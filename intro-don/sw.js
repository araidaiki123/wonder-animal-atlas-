/* イントロどん Service Worker
   アプリ殻 + 同梱セット JSON を事前キャッシュ。同一オリジンは cache-first + バックグラウンド更新、
   YouTube 等のクロスオリジンには触らない。navigate はオフライン時に index.html を返す。 */
const VERSION = 'v1.0.0';
const CACHE_NAME = `intro-don-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-512.png',
  './src/schema.mjs',
  './src/game.mjs',
  './src/storage.mjs',
  './src/audio/player.mjs',
  './src/audio/youtube.mjs',
  './src/audio/local.mjs',
  './src/ui/dom.mjs',
  './src/ui/toast.mjs',
  './src/ui/router.mjs',
  './src/ui/sound.mjs',
  './src/ui/state.mjs',
  './src/ui/home.mjs',
  './src/ui/set-editor.mjs',
  './src/ui/setup.mjs',
  './src/ui/play.mjs',
  './src/ui/result.mjs',
  './data/sets/index.json',
];

// index.json の形式差（id の配列 / {id,file} の配列 / {sets:[...]}）を吸収してセット JSON の URL を列挙
function setUrlsFromIndex(index) {
  const items = Array.isArray(index) ? index : (index && Array.isArray(index.sets) ? index.sets : []);
  const urls = [];
  for (const it of items) {
    if (typeof it === 'string') urls.push(`./data/sets/${it}.json`);
    else if (it && typeof it === 'object') {
      if (typeof it.file === 'string') urls.push(it.file.startsWith('.') || it.file.startsWith('/') ? it.file : `./data/sets/${it.file}`);
      else if (typeof it.path === 'string') urls.push(it.path);
      else if (typeof it.id === 'string') urls.push(`./data/sets/${it.id}.json`);
    }
  }
  return urls;
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // 1 ファイル欠けても全体を失敗させない
  await Promise.allSettled(SHELL.map((u) => cache.add(u).catch((e) => console.warn('precache 失敗', u, e))));
  try {
    const res = await fetch('./data/sets/index.json', { cache: 'no-cache' });
    if (res.ok) {
      await cache.put('./data/sets/index.json', res.clone());
      const urls = setUrlsFromIndex(await res.json());
      await Promise.allSettled(urls.map((u) => cache.add(u).catch(() => {})));
    }
  } catch (e) { /* オフライン時のインストールは殻のみ */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('intro-don-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // youtube.com などは触らない

  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(req, { ignoreSearch: true, fallback: './index.html' }));
    return;
  }
  event.respondWith(staleWhileRevalidate(req, { ignoreSearch: false }));
});

async function staleWhileRevalidate(req, { ignoreSearch, fallback }) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch });
  const network = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const res = await network;
  if (res) return res;
  if (fallback) {
    const fb = await cache.match(fallback);
    if (fb) return fb;
  }
  return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
