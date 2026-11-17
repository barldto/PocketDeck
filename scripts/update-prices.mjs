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

// Cardmarket expansion per TCGdex set: majority vote over a few TCGdex cards whose product ID is known. Cached.
let setExpansions={};try{setExpansions=JSON.parse(await readFile('cm-map/sets.json','utf8'));}catch{}
async function detectExpansion(lang,set,cards){
  const picks=[...new Set([0,1,2,Math.floor(cards.length/3),Math.floor(cards.length/2),cards.length-1,cards.length-2].filter(i=>i>=0&&i<cards.length))].map(i=>cards[i]);
  const votes=new Map();
  await Promise.all(picks.map(async card=>{
    try{
      const detail=await json(`${TCGDEX}${lang}/cards/${encodeURIComponent(set+'-'+card.localId)}`);
      const ids=[detail.pricing?.cardmarket?.idProduct,detail.thirdParty?.cardmarket,...(detail.variants_detailed||[]).map(v=>v.thirdParty?.cardmarket)].filter(Number.isInteger);
      for(const id of new Set(ids)){const exp=byId.get(id)?.idExpansion;if(exp)votes.set(exp,(votes.get(exp)||0)+1);}
    }catch{}
  }));
  const best=[...votes].sort((a,b)=>b[1]-a[1])[0];
  return best&&best[1]>=2?best[0]:0;
}
async function pool(items,size,fn){let i=0;await Promise.all(Array.from({length:size},async()=>{while(i<items.length)await fn(items[i++]);}));}

await rm('cm-map/en',{recursive:true,force:true});await rm('cm-map/ja',{recursive:true,force:true});
let mapped=0,unresolved=0,detected=0;
for(const lang of ['en','ja']){
  await mkdir(`cm-map/${lang}`,{recursive:true});
  const sets=cardsOf(lang);
  const missing=[...sets.keys()].filter(set=>{const c=setExpansions[lang+':'+set];return !c||(!c.exp&&Date.now()-c.at>7*864e5);});
  await pool(missing,6,async set=>{const exp=await detectExpansion(lang,set,sets.get(set));setExpansions[lang+':'+set]={exp,at:Date.now()};if(exp)detected++;});
  for(const [set,cards] of sets){
    const exp=setExpansions[lang+':'+set]?.exp;if(!exp)continue;
    const byName=new Map();
    for(const card of cards){const en=englishName(lang,card.name);if(!en)continue;const key=baseName(en);if(!byName.has(key))byName.set(key,[]);byName.get(key).push(card);}
    const out={};
    for(const [key,group] of byName){
      const candidates=byExpansionName.get(exp+'|'+key);if(!candidates?.length)continue;
      group.sort((a,b)=>numeric(a.localId)-numeric(b.localId)||String(a.localId).localeCompare(String(b.localId)));
      // Cardmarket creates the versions of one card in collector-number order, so the n-th version is the n-th card.
      if(group.length===candidates.length){group.forEach((card,i)=>{out[card.localId]=[candidates[i],...candidates];mapped++;});}
      else{group.forEach(card=>{out[card.localId]=[0,...candidates];unresolved++;});}
    }
    if(Object.keys(out).length)await writeFile(`cm-map/${lang}/${set}.json`,JSON.stringify(out));
  }
}
await writeFile('cm-map/sets.json',JSON.stringify(setExpansions));
console.log(`Guide ${updated}: ${priced} prices in ${SHARDS} shards. Mapping: ${mapped} cards resolved, ${unresolved} ambiguous, ${detected} new set links.`);
