// 앱처럼 설치(PWA)하기 위한 서비스 워커.
// 화면(index.html·app.js)은 늘 인터넷에서 새로 받고, 인터넷이 끊겼을 때만 저장해 둔 것을 보여준다.
// 시세·뉴스 같은 /api 응답은 저장하지 않는다(오래된 숫자를 보여주지 않게).
const CACHE = "myeco-v4";
const SHELL = ["/", "/app.js", "/manifest.json", "/img/lumi/app-192.png", "/img/lumi/icon.png", "/img/lumi/main.png"];

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
  // 화면 코드(app.js): 화면처럼 인터넷 먼저, 안 되면 저장본 (예전엔 index.html 안에 있었음)
  if (url.pathname === "/app.js") {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put("/app.js", copy));
      return r;
    }).catch(() => caches.match("/app.js")));
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

// 아침 알림: 서버가 내용 없이 깨우면, 오늘 문구를 받아서 띄운다. 누르면 앱 홈으로
self.addEventListener("push", (e) => {
  e.waitUntil(fetch("/api/market?push=today").then((r) => r.json()).catch(() => ({}))
    .then((m) => self.registration.showNotification(m.title || "루미의 아침 1분", {
      body: m.body || "오늘 나에게 중요한 3가지를 1분 만에 확인해 보세요.", icon: "/img/lumi/app-192.png", badge: "/img/lumi/app-192.png", tag: "morning", data: { url: "/" },
    })));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => new URL(c.url).origin === location.origin);
    return w ? w.focus().then((c) => c.navigate?.("/")) : self.clients.openWindow("/");
  }));
});
