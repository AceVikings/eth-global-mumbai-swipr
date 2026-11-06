import { createHash } from 'node:crypto';

type Contents = Record<string, string | Uint8Array>;
const cacheable = (path: string) => !path.endsWith('.map') && path !== '/api' && !path.startsWith('/api/');

export function createOfflineWorker(bundle: Contents, publicAssets: Contents, indexTemplate: string) {
  const contents = { ...bundle, ...publicAssets };
  const files = [...new Set(['/', '/index.html', '/manifest.webmanifest', ...Object.keys(contents).filter(cacheable)])].sort();
  const hash = createHash('sha256').update('swipr-offline-v2').update(indexTemplate);
  for (const path of files) {
    hash.update(path);
    if (contents[path] !== undefined) hash.update(contents[path]);
  }
  const version = hash.digest('hex').slice(0, 16);
  const source = `const CACHE='swipr-${version}', FILES=${JSON.stringify(files)};
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(url=>new Request(url,{cache:'reload'})))));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('swipr-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname==='/api'||u.pathname.startsWith('/api/'))return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.open(CACHE).then(c=>c.match('/index.html',{ignoreVary:true}))));return;
  }
  if(FILES.includes(u.pathname))e.respondWith(caches.open(CACHE).then(c=>c.match(e.request,{ignoreVary:true})).then(hit=>hit||fetch(e.request)));
});`;
  return { version, files, source };
}
