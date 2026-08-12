/* オフライン対応のサービスワーカー。
   HTTPSで配信されたとき(ホーム画面アプリとして使うとき)だけ登録される。
   初回表示で全データを端末へ保存し、以後は圏外・外出先でも図鑑全体が開ける。 */
const CACHE_NAME = "wonder-animal-atlas-v5-1";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "game.mjs",
  "logic.mjs",
  "manifest.webmanifest",
  "data/animals.json",
  "data/glossary.json",
  "data/quizzes.json",
  "data/animal-tiers.json",
  "assets/animal-portraits-v2.jpg",
  "assets/hero-atlas.png",
  "assets/app-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => cached || fetch(request))
  );
});
