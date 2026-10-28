// 앱처럼 설치(PWA)하기 위한 서비스 워커.
// 화면(index.html)은 늘 인터넷에서 새로 받고, 인터넷이 끊겼을 때만 저장해 둔 것을 보여준다.
// 시세·뉴스 같은 /api 응답은 저장하지 않는다(오래된 숫자를 보여주지 않게).
const CACHE = "myeco-v2";
const SHELL = ["/", "/manifest.json", "/img/lumi/app-192.png", "/img/lumi/icon.png", "/img/lumi/main.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // /api(시세·뉴스)와 /__/auth(구글 로그인 중계)는 건드리지 않는다
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/__/")) return;
  // 화면: 인터넷 먼저, 안 되면 저장본
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put("/", copy));
      return r;
    }).catch(() => caches.match("/")));
    return;
  }
  // 루미 그림 등: 저장본 먼저
  if (url.pathname.startsWith("/img/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    })));
  }
});
