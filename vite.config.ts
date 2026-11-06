import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { createHash } from "node:crypto";
// Generated from each build: no stale asset list, no caching of APIs or wallet data.
function offlineShell() {
  return {
    name: "swipr-offline-shell",
    generateBundle(
      _options: unknown,
      bundle: Record<string, { fileName: string }>,
    ) {
      const assets = Object.values(bundle)
        .map((file) => `/${file.fileName}`)
        .filter((path) => !path.endsWith(".map"));
      const files = [
        ...new Set([
          "/",
          "/index.html",
          "/manifest.webmanifest",
          ...assets,
          ...[
            "alice.jpg",
            "dan.jpg",
            "priya.jpg",
            "mark.svg",
            "icon-192.png",
            "icon-512.png",
          ].map((file) => `/assets/${file}`),
        ]),
      ];
      const version = createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex")
        .slice(0, 12);
      const source = `const CACHE='swipr-${version}', FILES=${JSON.stringify(files)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(url=>new Request(url,{cache:'reload'})))))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('swipr-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;
if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.open(CACHE).then(c=>c.match('/index.html',{ignoreVary:true}))));return}
if(FILES.includes(u.pathname))e.respondWith(caches.open(CACHE).then(c=>c.match(e.request,{ignoreVary:true})).then(hit=>hit||fetch(e.request)));});`;
      (this as unknown as { emitFile: (asset: object) => void }).emitFile({
        type: "asset",
        fileName: "sw.js",
        source,
      });
    },
  };
}
export default defineConfig({ plugins: [react(), tailwind(), offlineShell()] });
