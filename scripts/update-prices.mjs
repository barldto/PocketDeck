// Builds prices.json from Cardmarket's public daily Pokémon files (product list + price guide).
// Runs on GitHub Actions. Prices are stored in cents to keep the file small.
import {writeFile,readFile} from 'node:fs/promises';

const BASE=process.env.CM_BASE||'https://downloads.s3.cardmarket.com/productCatalog/';
const PRODUCTS=BASE+'productList/products_singles_6.json';
const GUIDE=BASE+'priceGuide/price_guide_6.json';

async function load(url){
  const response=await fetch(url,{headers:{'user-agent':'PocketDeck price updater (github.com/barldto/PocketDeck)'}});
  if(!response.ok)throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}
// The files wrap their rows in an object ({version, createdAt, products|priceGuides: [...]}); accept a bare array as well.
const rows=data=>Array.isArray(data)?data:Object.values(data).find(Array.isArray)||[];
const cents=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.round(value*100):0;
// "Yanma (V.2)" and "Yanma" are versions of the same card inside one expansion.
const baseName=name=>String(name||'').replace(/\s*\((?:V\.?\s*\d+|Version\s*\d+)\)\s*$/i,'').trim().toLowerCase();

const [productData,guideData]=await Promise.all([load(PRODUCTS),load(GUIDE)]);
const products=rows(productData),guides=rows(guideData);
if(products.length<1000||guides.length<1000)throw new Error(`Unexpectedly small files: ${products.length} products, ${guides.length} price rows`);

// Price row per product: [trend, avg, low, avg7, avg30, trendHolo, avgHolo, lowHolo] in cents (0 = no value).
const p={};
for(const g of guides){
  if(!g||!Number.isInteger(g.idProduct))continue;
  const row=[g.trend,g.avg,g.low,g.avg7,g.avg30,g['trend-holo'],g['avg-holo'],g['low-holo']].map(cents);
  if(row.some(Boolean))p[g.idProduct]=row;
}

// Siblings: products with the same base name in the same expansion (different printings / rarities of one card).
const groups=new Map();
for(const item of products){
  if(!item||!Number.isInteger(item.idProduct)||!item.idExpansion)continue;
  const key=item.idExpansion+'|'+baseName(item.name);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(item.idProduct);
}
const s={};
for(const ids of groups.values()){
  const priced=ids.filter(id=>p[id]);
  if(priced.length<2||priced.length>12)continue;
  for(const id of priced)s[id]=priced.filter(other=>other!==id);
}

if(process.env.PD_DEBUG){const near=products.filter(x=>x.idProduct>=778370&&x.idProduct<=778470||x.idProduct>=719430&&x.idProduct<=719640&&/Charmeleon|Glutexo/i.test(x.name));await writeFile('debug-names.json',JSON.stringify(near,null,1));}
const updated=guideData.createdAt||productData.createdAt||new Date().toISOString();
const output={format:'PocketDeckPrices',version:1,source:'Cardmarket price guide',updated,p,s};
const json=JSON.stringify(output);
let previous='';try{previous=await readFile('prices.json','utf8');}catch{}
if(previous){try{const old=JSON.parse(previous);if(old.updated===updated){console.log('Price guide unchanged:',updated);process.exit(0);}}catch{}}
await writeFile('prices.json',json);
console.log(`prices.json: ${Object.keys(p).length} prices, ${Object.keys(s).length} products with siblings, ${(json.length/1024/1024).toFixed(2)} MB, guide ${updated}`);
