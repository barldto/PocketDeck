/* No captured images or OCR input pass through this worker. Only app files and public GET resources are cached. */
const VERSION='pocketdeck-web-v4-6-5',SHELL=VERSION+'-shell',PUBLIC=VERSION+'-public',ART='pocketdeck-art-v2';
const shellFiles=['./','./index.html','./catalog.json','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(shellFiles)).then(()=>self.skipWaiting()));});
// Old app versions are removed. Pokémon artwork and the on-device safety copy of the collection are kept.
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('pocketdeck-web-')&&![SHELL,PUBLIC].includes(key)).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);
  if(url.origin===self.location.origin){
    if(url.pathname.endsWith('/__pocketdeck-mirror.json'))return;
    if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(SHELL).then(cache=>cache.put('./index.html',copy)).catch(()=>{});}return response;}).catch(()=>caches.match('./index.html')));return;}
    if(/\/(prices|cm-map)\//.test(url.pathname))return; // daily prices: always from the network
    if(url.pathname.includes('/art/')){event.respondWith(caches.open(ART).then(async cache=>{const cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok)cache.put(request,response.clone()).catch(()=>{});return response;}));return;}
    event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));return;
  }
  // API JSON has its own dated IndexedDB cache and must remain network-first.
  const allowed=['assets.tcgdex.net','cdn.jsdelivr.net'];if(!allowed.includes(url.hostname)||url.protocol!=='https:')return;
  event.respondWith(caches.open(PUBLIC).then(async cache=>{
    const cached=await cache.match(request);if(cached)return cached;
    const response=await fetch(request);
    if(response.ok){try{await cache.put(request,response.clone());const keys=await cache.keys();if(keys.length>400)await cache.delete(keys[0]);}catch{}}
    return response;
  }));
});
