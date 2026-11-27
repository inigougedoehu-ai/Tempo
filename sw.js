"use strict";
const CACHE="tempo-shell-2.2.2";
const root=new URL(self.registration.scope);
const shell=new URL("index.html",root).href;
const assets=["index.html","tempo-2.2.2.js","manifest.webmanifest","icon.svg","tempo-apple-180.png","tempo-icon-192.png","tempo-icon-512.png"].map(p=>new URL(p,root).href);
self.addEventListener("install",e=>e.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(assets.map(u=>new Request(u,{cache:"reload"})));await self.skipWaiting();})()));
self.addEventListener("activate",e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith("tempo-shell-")&&k!==CACHE)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener("fetch",e=>{
 const req=e.request,u=new URL(req.url);
 if(req.method!=="GET"||u.origin!==root.origin||!u.pathname.startsWith(root.pathname)||u.searchParams.has("_version"))return;
 if(req.mode==="navigate"&&(u.pathname===root.pathname||u.pathname===new URL(shell).pathname)){
  e.respondWith((async()=>{try{const r=await fetch(req,{cache:"no-store"});if(r.ok){const c=await caches.open(CACHE);await c.put(shell,r.clone());return r;}throw Error("Unavailable");}catch{const saved=await caches.match(shell,{cacheName:CACHE});return saved||new Response("Tempo necesita conexión la primera vez.",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}});}})());return;
 }
 if(assets.includes(u.href)&&u.href!==shell)e.respondWith((async()=>{const c=await caches.open(CACHE);return (await c.match(req))||fetch(req);})());
});
