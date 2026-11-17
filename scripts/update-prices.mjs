// PocketDeck price updater (runs daily on GitHub Actions).
// 1. Loads Cardmarket's public Pokémon product list and price guide.
// 2. Writes the prices in 50 small shards (prices/<idProduct % 50>.json).
// 3. Builds its own card -> Cardmarket product mapping per set (cm-map/<lang>/<set>.json),
//    because TCGdex sometimes links a card to a product from a different set.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';

const BASE=process.env.CM_BASE||'https://downloads.s3.cardmarket.com/productCatalog/';
const TCGDEX=process.env.TCGDEX_BASE||'https://api.tcgdex.net/v2/';
const SHARDS=50;
const UA={'user-agent':'PocketDeck price updater (github.com/barldto/PocketDeck)'};

async function json(url){const response=await fetch(url,{headers:UA});if(!response.ok)throw new Error(`${url} -> HTTP ${response.status}`);return response.json();}
const rows=data=>Array.isArray(data)?data:Object.values(data).find(Array.isArray)||[];
const cents=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.round(value*100):0;
// "Yanma [Whirlwind | Razor Wing]" -> "yanma"; "Charizard ex (V.2)" -> "charizard ex"
const baseName=name=>String(name||'').replace(/\s*\[.*\]\s*$/,'').replace(/\s*\((?:V\.?\s*\d+|Version\s*\d+)\)\s*$/i,'').replace(/[’`]/g,"'").trim().toLowerCase();
const numeric=id=>{const n=parseInt(String(id).replace(/^\D+/,''),10);return Number.isFinite(n)?n:1e9;};

/* ---------- 1. Cardmarket files ---------- */
const [productData,guideData]=await Promise.all([json(BASE+'productList/products_singles_6.json'),json(BASE+'priceGuide/price_guide_6.json')]);
const products=rows(productData),guides=rows(guideData);
if(products.length<1000||guides.length<1000)throw new Error(`Unexpectedly small files: ${products.length} products, ${guides.length} price rows`);
const updated=guideData.createdAt||productData.createdAt||new Date().toISOString();

if(process.env.PD_DEBUG){const want=new Set([6037,5996,6092,3851,6189,5519,5782]);await writeFile('debug-names.json',JSON.stringify(products.filter(p=>want.has(p.idExpansion)).map(p=>[p.idExpansion,p.idProduct,p.name])));}
/* ---------- 2. Price shards ---------- */
// Row per product: [trend, avg, low, avg7, avg30, trendHolo, avgHolo, lowHolo] in cents (0 = no value).
const shards=Array.from({length:SHARDS},()=>({}));let priced=0;
for(const g of guides){
  if(!g||!Number.isInteger(g.idProduct))continue;
  const row=[g.trend,g.avg,g.low,g.avg7,g.avg30,g['trend-holo'],g['avg-holo'],g['low-holo']].map(cents);
  if(row.some(Boolean)){shards[g.idProduct%SHARDS][g.idProduct]=row;priced++;}
}
await rm('prices',{recursive:true,force:true});await mkdir('prices',{recursive:true});
await Promise.all(shards.map((shard,i)=>writeFile(`prices/${i}.json`,JSON.stringify(shard))));
await writeFile('prices/meta.json',JSON.stringify({format:'PocketDeckPrices',version:2,source:'Cardmarket price guide',updated,shards:SHARDS}));

/* ---------- 3. Own mapping ---------- */
const byId=new Map(products.filter(p=>Number.isInteger(p?.idProduct)).map(p=>[p.idProduct,p]));
const byExpansionName=new Map();
for(const p of byId.values()){if(!p.idExpansion)continue;const key=p.idExpansion+'|'+baseName(p.name);if(!byExpansionName.has(key))byExpansionName.set(key,[]);byExpansionName.get(key).push(p.idProduct);}
for(const ids of byExpansionName.values())ids.sort((a,b)=>a-b);

// TCGdex catalogue (from this repo) and Pokémon names (for Japanese -> English).
const catalog=JSON.parse(await readFile('catalog.json','utf8'));
const html=await readFile('index.html','utf8');
const species=JSON.parse(html.match(/<script id="pd-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).species;
const jaNames=species.map(s=>[s.nameJA,s.nameEN]).filter(([ja])=>ja).sort((a,b)=>b[0].length-a[0].length);
function englishName(lang,name){
  if(lang==='en')return name;
  const n=String(name).normalize('NFKC').trim();
  const hit=jaNames.find(([ja])=>n.startsWith(ja.normalize('NFKC')));if(!hit)return null;
  const suffix=n.slice(hit[0].normalize('NFKC').length).trim();
  if(!suffix)return hit[1];
  if(/^(ex|EX|GX|V|VMAX|VSTAR|LV\.X|BREAK)$/.test(suffix))return hit[1]+' '+suffix;
  return null; // regional forms, trainer's Pokémon etc.: leave to TCGdex
}
function cardsOf(lang){
  const sets=new Map();
  for(const [set,,list] of catalog.catalogues[lang]||[])for(const [localId,name] of list){if(!sets.has(set))sets.set(set,[]);sets.get(set).push({localId,name});}
  return sets;
}

// Cardmarket expansion per TCGdex set. TCGdex product IDs are only a hint (they can point to other sets),
// so the decision is made by comparing the Pokémon names of the set with the names in each Cardmarket expansion.
const expNames=new Map(),nameExps=new Map();
for(const key of byExpansionName.keys()){const i=key.indexOf('|'),exp=Number(key.slice(0,i)),name=key.slice(i+1);if(!expNames.has(exp))expNames.set(exp,new Set());expNames.get(exp).add(name);if(!nameExps.has(name))nameExps.set(name,new Set());nameExps.get(name).add(exp);}
let voteCache={};try{voteCache=JSON.parse(await readFile('cm-map/votes.json','utf8'));}catch{}
async function tcgdexVotes(lang,set,cards){
  const cached=voteCache[lang+':'+set];if(cached&&Date.now()-cached.at<30*864e5)return cached.votes;
  const picks=[...new Set([0,1,2,Math.floor(cards.length/3),Math.floor(cards.length/2),cards.length-1,cards.length-2].filter(i=>i>=0&&i<cards.length))].map(i=>cards[i]);
  const votes={};
  await Promise.all(picks.map(async card=>{
    try{
      const detail=await json(`${TCGDEX}${lang}/cards/${encodeURIComponent(set+'-'+card.localId)}`);
      const ids=[detail.pricing?.cardmarket?.idProduct,detail.thirdParty?.cardmarket,...(detail.variants_detailed||[]).map(v=>v.thirdParty?.cardmarket)].filter(Number.isInteger);
      for(const id of new Set(ids)){const exp=byId.get(id)?.idExpansion;if(exp)votes[exp]=(votes[exp]||0)+1;}
    }catch{}
  }));
  voteCache[lang+':'+set]={votes,picks:picks.length,at:Date.now()};return votes;
}
function chooseExpansion(names,votes,taken){
  const counts=new Map();for(const name of names)for(const exp of nameExps.get(name)||[])counts.set(exp,(counts.get(exp)||0)+1);
  const totalVotes=Object.values(votes).reduce((a,b)=>a+b,0)||1;let best=0,bestScore=0;
  for(const [exp,inter] of counts){
    if(taken.has(exp))continue;const size=expNames.get(exp).size,jaccard=inter/(names.size+size-inter);
    const score=jaccard+0.3*((votes[exp]||0)/totalVotes);
    if(inter>=Math.min(3,names.size)&&inter>=names.size*0.5&&score>bestScore){best=exp;bestScore=score;}
  }
  return best;
}
async function pool(items,size,fn){let i=0;await Promise.all(Array.from({length:size},async()=>{while(i<items.length)await fn(items[i++]);}));}

await rm('cm-map',{recursive:true,force:true});
let mapped=0,unresolved=0;const setExpansions={},taken=new Set(),plan=[];
for(const lang of ['en','ja'])for(const [set,cards] of cardsOf(lang)){
  const named=cards.map(card=>({...card,key:(n=>n&&baseName(n))(englishName(lang,card.name))})).filter(card=>card.key);
  plan.push({lang,set,cards:named,names:new Set(named.map(c=>c.key))});
}
await pool(plan,6,async item=>{item.votes=await tcgdexVotes(item.lang,item.set,item.cards);});
// 1. TCGdex is unanimous for a set (>= 3 sampled cards, >= 90 % one expansion): trust it. Several small sets may share one expansion.
for(const item of plan){
  const total=Object.values(item.votes).reduce((a,b)=>a+b,0),top=Object.entries(item.votes).sort((a,b)=>b[1]-a[1])[0];
  if(top&&top[1]>=3&&top[1]/total>=0.9&&expNames.has(Number(top[0]))){item.fixed=Number(top[0]);taken.add(item.fixed);}
}
// 2. Otherwise compare names; strongest matches first, so a clear set claims its expansion before a weaker look-alike can.
for(const item of plan){if(item.fixed)continue;item.exp=chooseExpansion(item.names,item.votes,new Set());const size=item.exp?expNames.get(item.exp).size:0;const inter=item.exp?[...item.names].filter(n=>expNames.get(item.exp).has(n)).length:0;item.strength=item.exp?inter/(item.names.size+size-inter):0;}
plan.sort((a,b)=>(b.fixed?2:b.strength)-(a.fixed?2:a.strength));
for(const item of plan){
  const exp=item.fixed||chooseExpansion(item.names,item.votes,taken);setExpansions[item.lang+':'+item.set]=exp;if(!exp)continue;taken.add(exp);
  const byName=new Map();for(const card of item.cards){if(!byName.has(card.key))byName.set(card.key,[]);byName.get(card.key).push(card);}
  const out={};
  for(const [key,group] of byName){
    const candidates=byExpansionName.get(exp+'|'+key);if(!candidates?.length)continue;
    group.sort((a,b)=>numeric(a.localId)-numeric(b.localId)||String(a.localId).localeCompare(String(b.localId)));
    // Cardmarket creates the versions of one card in collector-number order, so the n-th version is the n-th card.
    if(group.length===candidates.length){group.forEach((card,i)=>{out[card.localId]=[candidates[i],...candidates];mapped++;});}
    else{group.forEach(card=>{out[card.localId]=[0,...candidates];unresolved++;});}
  }
  if(Object.keys(out).length){await mkdir(`cm-map/${item.lang}`,{recursive:true});await writeFile(`cm-map/${item.lang}/${item.set}.json`,JSON.stringify(out));}
}
await mkdir('cm-map',{recursive:true});await writeFile('cm-map/votes.json',JSON.stringify(voteCache));
await writeFile('cm-map/sets.json',JSON.stringify(setExpansions));
console.log(`Guide ${updated}: ${priced} prices in ${SHARDS} shards. Sets linked: ${Object.values(setExpansions).filter(Boolean).length}/${plan.length}. Cards resolved: ${mapped}, ambiguous: ${unresolved}.`);
