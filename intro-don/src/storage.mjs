// storage.mjs — IndexedDB / localStorage ラッパ（ARCHITECTURE.md 第6章）
// IndexedDB `intro-don` v1：sets（key:id）、audio（key:blobId）、results（autoIncrement）。
// localStorage：`intro-don:settings`。
// import 時には環境に触れない（indexedDB が無い Node でも import は成功し、呼び出し時に reject する）。
// createStorage({ idb, fetch, baseUrl, localStorage, navigator }) で依存を注入でき、
// 既定インスタンスの関数（loadBuiltinSets など）も同名で export している。

import { validateSet } from './schema.mjs';

export const DB_NAME = 'intro-don';
export const DB_VERSION = 1;
export const STORES = Object.freeze({ sets: 'sets', audio: 'audio', results: 'results' });
export const SETTINGS_KEY = 'intro-don:settings';
export const BUILTIN_INDEX_PATH = 'data/sets/index.json';

// ---------------------------------------------------------------------------
// IDB リクエスト/トランザクションを Promise に変換する小道具
// ---------------------------------------------------------------------------

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function makeBlobId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return 'b_' + c.randomUUID();
  // フォールバック：getRandomValues か Math.random で 32 桁の16進
  let hex = '';
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  }
  return 'b_' + hex;
}

function localBlobIdsOf(set) {
  const ids = [];
  for (const q of set && Array.isArray(set.questions) ? set.questions : []) {
    if (q && q.source && q.source.type === 'local' && q.source.blobId) ids.push(q.source.blobId);
  }
  return ids;
}

function defaultBaseUrl() {
  if (globalThis.document && typeof globalThis.document.baseURI === 'string') return globalThis.document.baseURI;
  if (globalThis.location && typeof globalThis.location.href === 'string') return globalThis.location.href;
  return 'http://localhost/';
}

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

/**
 * ストレージインスタンスを作る。依存はすべて注入可能（省略時は globalThis のもの）。
 * - idb: IndexedDB ファクトリ（無ければ呼び出し時に reject）
 * - fetch: loadBuiltinSets 用
 * - baseUrl: data/sets/index.json を相対解決する基準 URL（既定 document.baseURI）
 * - localStorage / navigator: settings 保存、persist()/estimate() 用
 * - logger: 同梱セットの検証失敗などの警告出力（既定 console）
 */
export function createStorage({
  idb,
  fetch: fetchFn,
  baseUrl,
  localStorage: ls,
  navigator: nav,
  dbName = DB_NAME,
  logger = globalThis.console,
} = {}) {
  const getIdb = () => idb ?? globalThis.indexedDB;
  const getFetch = () => fetchFn ?? globalThis.fetch;
  const getLs = () => ls ?? globalThis.localStorage;
  const getNav = () => nav ?? globalThis.navigator;

  let dbPromise = null;
  let builtinCache = null; // loadBuiltinSets の結果（getSet のフォールバック用）
  let persistRequested = false;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const factory = getIdb();
      if (!factory || typeof factory.open !== 'function') {
        reject(new Error('IndexedDB が利用できません'));
        return;
      }
      let request;
      try {
        request = factory.open(dbName, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      request.onupgradeneeded = (ev) => {
        const db = (ev && ev.target && ev.target.result) || request.result;
        const names = db.objectStoreNames;
        if (!names.contains(STORES.sets)) db.createObjectStore(STORES.sets, { keyPath: 'id' });
        if (!names.contains(STORES.audio)) db.createObjectStore(STORES.audio, { keyPath: 'blobId' });
        if (!names.contains(STORES.results)) db.createObjectStore(STORES.results, { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 別タブでの削除・更新時は接続を閉じて次回開き直す
        if ('onversionchange' in db) {
          db.onversionchange = () => {
            try { db.close(); } catch { /* ignore */ }
            dbPromise = null;
          };
        }
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB を開けませんでした'));
      request.onblocked = () => reject(new Error('IndexedDB が他のタブでブロックされています'));
    });
    dbPromise.catch(() => { dbPromise = null; }); // 失敗したら次回再試行できるように
    return dbPromise;
  }

  // 単一ストアで 1 リクエスト
  async function one(storeName, mode, fn) {
    const db = await openDb();
    const tx = db.transaction(storeName, mode);
    const result = await req(fn(tx.objectStore(storeName)));
    if (mode === 'readwrite') await txDone(tx);
    return result;
  }

  // 複数リクエストを 1 トランザクションで（fn は同期的にリクエストを発行する）
  async function batch(storeNames, mode, fn) {
    const db = await openDb();
    const tx = db.transaction(storeNames, mode);
    fn(tx);
    await txDone(tx);
  }

  // iOS の自動削除対策（失敗は無視）
  async function requestPersist() {
    if (persistRequested) return;
    persistRequested = true;
    try {
      const n = getNav();
      if (n && n.storage && typeof n.storage.persist === 'function') await n.storage.persist();
    } catch {
      /* ignore */
    }
  }

  // ---- 同梱セット ----

  async function loadBuiltinSets() {
    const f = getFetch();
    if (typeof f !== 'function') throw new Error('fetch が利用できません');
    const base = baseUrl ?? defaultBaseUrl();
    const indexUrl = new URL(BUILTIN_INDEX_PATH, base);
    const res = await f(indexUrl.href);
    if (!res || !res.ok) throw new Error(`同梱セット一覧を取得できません: ${indexUrl.href}`);
    const index = await res.json();
    // index.json は ["konbini-chime", ...] / [{ id, file? }, ...] / { sets: [...] } のいずれも受け付ける
    const entries = Array.isArray(index) ? index : Array.isArray(index && index.sets) ? index.sets : [];
    const sets = [];
    for (const entry of entries) {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      const file = typeof entry === 'object' && entry && entry.file ? entry.file : `${id}.json`;
      if (!id) continue;
      try {
        const url = new URL(`data/sets/${file}`, base);
        const r = await f(url.href);
        if (!r || !r.ok) throw new Error(`HTTP ${r && r.status}`);
        const v = validateSet(await r.json());
        if (!v.ok) {
          logger && logger.warn && logger.warn(`同梱セット ${id} が不正です:`, v.errors);
          continue;
        }
        sets.push({ ...v.set, builtin: true });
      } catch (e) {
        logger && logger.warn && logger.warn(`同梱セット ${id} を読み込めません:`, e && e.message);
      }
    }
    builtinCache = sets;
    return sets;
  }

  // ---- ユーザーセット ----

  async function listUserSets() {
    const all = await one(STORES.sets, 'readonly', (st) => st.getAll());
    return all
      .filter((s) => s && s.builtin !== true)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async function getSet(id) {
    let found = null;
    try {
      found = await one(STORES.sets, 'readonly', (st) => st.get(id));
    } catch (e) {
      if (!builtinCache) throw e;
    }
    if (found) return found;
    if (builtinCache) return builtinCache.find((s) => s.id === id) ?? null;
    return null;
  }

  async function saveUserSet(set) {
    const v = validateSet(set);
    if (!v.ok) {
      const err = new Error('セットが不正です: ' + v.errors.join(' / '));
      err.errors = v.errors;
      throw err;
    }
    if (v.set.builtin === true || (set && set.builtin === true)) {
      throw new Error('同梱セットは保存できません（複製して編集してください）');
    }
    const existing = await one(STORES.sets, 'readonly', (st) => st.get(v.set.id));
    const now = Date.now();
    const record = {
      ...v.set,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now,
    };
    await one(STORES.sets, 'readwrite', (st) => st.put(record));
    await requestPersist();
    return record;
  }

  async function deleteUserSet(id) {
    const all = await one(STORES.sets, 'readonly', (st) => st.getAll());
    const target = all.find((s) => s && s.id === id);
    if (!target) return false;
    // 他のセットからも参照されている blob は残す（複製などで共有されている場合）
    const referencedElsewhere = new Set();
    for (const s of all) if (s.id !== id) for (const b of localBlobIdsOf(s)) referencedElsewhere.add(b);
    const toDelete = [...new Set(localBlobIdsOf(target))].filter((b) => !referencedElsewhere.has(b));
    await batch([STORES.sets, STORES.audio], 'readwrite', (tx) => {
      tx.objectStore(STORES.sets).delete(id);
      const audio = tx.objectStore(STORES.audio);
      for (const b of toDelete) audio.delete(b);
    });
    return true;
  }

  // ---- 音源 ----

  async function putAudio({ blob, mimeType, name, duration } = {}) {
    if (!blob) throw new Error('blob が必要です');
    const blobId = makeBlobId();
    const record = {
      blobId,
      blob,
      mimeType: mimeType || blob.type || 'application/octet-stream',
      name: typeof name === 'string' ? name : '',
      duration: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
      createdAt: Date.now(),
    };
    await one(STORES.audio, 'readwrite', (st) => st.put(record));
    await requestPersist();
    return blobId;
  }

  async function getAudio(blobId) {
    const r = await one(STORES.audio, 'readonly', (st) => st.get(blobId));
    return r ?? null;
  }

  async function deleteAudio(blobId) {
    await one(STORES.audio, 'readwrite', (st) => st.delete(blobId));
    return true;
  }

  async function estimateUsage() {
    try {
      const n = getNav();
      if (n && n.storage && typeof n.storage.estimate === 'function') {
        const e = await n.storage.estimate();
        return { usage: e.usage ?? null, quota: e.quota ?? null };
      }
    } catch {
      /* ignore */
    }
    return { usage: null, quota: null };
  }

  // ---- 結果 ----

  async function saveResult(summary) {
    const record = { ...(summary && typeof summary === 'object' ? summary : { summary }), createdAt: Date.now() };
    delete record.id; // autoIncrement に任せる
    return one(STORES.results, 'readwrite', (st) => st.add(record));
  }

  async function listResults(limit = 20) {
    const all = await one(STORES.results, 'readonly', (st) => st.getAll());
    all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (b.id ?? 0) - (a.id ?? 0));
    return typeof limit === 'number' && limit >= 0 ? all.slice(0, limit) : all;
  }

  // ---- 設定（localStorage、失敗は空/false） ----

  async function loadSettings() {
    try {
      const raw = getLs() && getLs().getItem(SETTINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async function saveSettings(obj) {
    try {
      const l = getLs();
      if (!l) return false;
      l.setItem(SETTINGS_KEY, JSON.stringify(obj && typeof obj === 'object' ? obj : {}));
      return true;
    } catch {
      return false;
    }
  }

  // テスト・デバッグ用
  async function close() {
    if (!dbPromise) return;
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      /* ignore */
    }
    dbPromise = null;
  }

  return {
    loadBuiltinSets,
    listUserSets,
    getSet,
    saveUserSet,
    deleteUserSet,
    putAudio,
    getAudio,
    deleteAudio,
    estimateUsage,
    saveResult,
    listResults,
    loadSettings,
    saveSettings,
    close,
  };
}

// ---------------------------------------------------------------------------
// 既定インスタンス（遅延生成：import 時に環境へ触れない）
// ---------------------------------------------------------------------------

let defaultInstance = null;
function def() {
  if (!defaultInstance) defaultInstance = createStorage();
  return defaultInstance;
}

export const loadBuiltinSets = (...a) => def().loadBuiltinSets(...a);
export const listUserSets = (...a) => def().listUserSets(...a);
export const getSet = (...a) => def().getSet(...a);
export const saveUserSet = (...a) => def().saveUserSet(...a);
export const deleteUserSet = (...a) => def().deleteUserSet(...a);
export const putAudio = (...a) => def().putAudio(...a);
export const getAudio = (...a) => def().getAudio(...a);
export const deleteAudio = (...a) => def().deleteAudio(...a);
export const estimateUsage = (...a) => def().estimateUsage(...a);
export const saveResult = (...a) => def().saveResult(...a);
export const listResults = (...a) => def().listResults(...a);
export const loadSettings = (...a) => def().loadSettings(...a);
export const saveSettings = (...a) => def().saveSettings(...a);
