/* イントロどん Service Worker
   ★ デプロイ時は必ず VERSION を上げること ★
   - アプリ殻（SHELL）と同梱セット JSON（data/sets/*）は install 時にバージョン付きキャッシュへ precache する
     （cache: 'reload' で HTTP キャッシュを経由せず必ずネットワークから取る）。
   - SHELL と data/sets は「バージョン付きキャッシュから cache-first」で返す。バックグラウンド更新（SWR）は
     しない。古い app.js と新しい *.mjs が混在するのを防ぐため、更新は VERSION を上げて丸ごと入れ替える
     （activate で旧バージョンのキャッシュを削除 → 次回ロードで新しい殻が揃う）。
   - SHELL 以外の同一オリジン（将来の追加ファイル）は network-first + キャッシュ fallback。
   - YouTube 等のクロスオリジンには触らない。navigate はオフライン時に index.html を返す。 */
const VERSION = 'v1.1.1';
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

/** HTTP キャッシュを経由せず必ずネットワークから取る Request（古いファイルを precache しないため） */
function reloadRequest(u) {
  return new Request(u, { cache: 'reload' });
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // 1 ファイル欠けても全体を失敗させない
  await Promise.allSettled(SHELL.map((u) => cache.add(reloadRequest(u)).catch((e) => console.warn('precache 失敗', u, e))));
  try {
    const res = await fetch(reloadRequest('./data/sets/index.json'));
    if (res.ok) {
      await cache.put('./data/sets/index.json', res.clone());
      const urls = setUrlsFromIndex(await res.json());
      await Promise.allSettled(urls.map((u) => cache.add(reloadRequest(u)).catch(() => {})));
    }
  } catch (e) { /* オフライン時のインストールは殻のみ */ }
}

/** SHELL / data/sets に属する（= バージョン付きキャッシュから cache-first で返す）パスか */
const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u, self.location.href).pathname));
const SETS_PREFIX = new URL('./data/sets/', self.location.href).pathname;
function isShellPath(pathname) {
  return SHELL_PATHS.has(pathname) || pathname.startsWith(SETS_PREFIX);
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
    // 殻の HTML はバージョン付きキャッシュから（?url= 等のクエリは無視）。無ければネットワーク → index.html
    event.respondWith(cacheFirst(req, { ignoreSearch: true, fallback: './index.html' }));
    return;
  }
  if (isShellPath(url.pathname)) {
    event.respondWith(cacheFirst(req, { ignoreSearch: false }));
    return;
  }
  event.respondWith(networkFirst(req));
});

/** 殻用：キャッシュにあればそれを返す（更新は VERSION の切り替えで丸ごと行う）。無ければネットワーク → fallback */
async function cacheFirst(req, { ignoreSearch, fallback }) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // precache に漏れた殻ファイルは同じバージョンのキャッシュに補充する（次回から cache-first）
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    if (fallback) {
      const fb = await cache.match(fallback);
      if (fb) return fb;
    }
    return offlineResponse();
  }
}

/** 殻以外の同一オリジン：ネットワーク優先、失敗時はキャッシュ */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return offlineResponse();
  }
}

function offlineResponse() {
  return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
