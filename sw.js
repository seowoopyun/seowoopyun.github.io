// 2-3반 함께 공부하기 — 오프라인에서도 앱 화면이 열리도록 캐시. 기록 데이터(서버 API)는 캐시하지 않는다.
const VERSION = 'v8';
const CORE = `sqc-core-${VERSION}`;
const RUNTIME = `sqc-runtime-${VERSION}`;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CORE).then((c) => c.addAll(['./', './manifest.webmanifest', './icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![CORE, RUNTIME].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CORE).then((c) => c.put('./', copy)); return res; }).catch(() => caches.match('./')));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || (url.origin === location.origin && /\.(js|css|png|svg|woff2?|wasm|data|webmanifest)$/.test(url.pathname))) {
    e.respondWith(caches.open(RUNTIME).then((cache) => cache.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
