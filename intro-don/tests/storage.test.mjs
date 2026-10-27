// storage.mjs のテスト（node --test）
// IndexedDB は最小の in-memory フェイクを createStorage({ idb }) で注入して検証する。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as storageModule from '../src/storage.mjs';
import { createStorage, SETTINGS_KEY, DB_NAME } from '../src/storage.mjs';

// ---------------------------------------------------------------------------
// 最小の IndexedDB フェイク（open / onupgradeneeded / transaction / objectStore /
// get / getAll / put / add / delete / oncomplete）。値は structuredClone で保存する。
// ---------------------------------------------------------------------------
function createFakeIndexedDB() {
  const databases = new Map(); // name -> { version, stores: Map }

  function makeRequest(tx, run) {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    tx._pending++;
    queueMicrotask(() => {
      try {
        r.result = run();
        r.onsuccess && r.onsuccess({ target: r });
      } catch (e) {
        r.error = e;
        tx._failed = e;
        r.onerror && r.onerror({ target: r });
      } finally {
        tx._pending--;
        tx._check();
      }
    });
    return r;
  }

  function keyOf(store, value) {
    const k = store.keyPath ? value[store.keyPath] : undefined;
    return k;
  }

  function storeApi(store, tx) {
    const assertWrite = () => {
      if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
    };
    return {
      get: (key) => makeRequest(tx, () => structuredClone(store.data.get(key))),
      getAll: () => makeRequest(tx, () => {
        const keys = [...store.data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return keys.map((k) => structuredClone(store.data.get(k)));
      }),
      put: (value) => makeRequest(tx, () => {
        assertWrite();
        let key = keyOf(store, value);
        if (key === undefined && store.autoIncrement) { key = ++store.seq; value = { ...value, [store.keyPath]: key }; }
        if (key === undefined) throw new Error('DataError: no key');
        store.data.set(key, structuredClone(value));
        return key;
      }),
      add: (value) => makeRequest(tx, () => {
        assertWrite();
        let key = keyOf(store, value);
        if (key === undefined && store.autoIncrement) { key = ++store.seq; value = { ...value, [store.keyPath]: key }; }
        if (store.data.has(key)) throw new Error('ConstraintError');
        store.data.set(key, structuredClone(value));
        return key;
      }),
      delete: (key) => makeRequest(tx, () => { assertWrite(); store.data.delete(key); }),
      clear: () => makeRequest(tx, () => { assertWrite(); store.data.clear(); }),
      count: () => makeRequest(tx, () => store.data.size),
    };
  }

  function dbApi(rec) {
    return {
      name: rec.name,
      version: rec.version,
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(name, { keyPath = null, autoIncrement = false } = {}) {
        if (rec.stores.has(name)) throw new Error('ConstraintError: store exists');
        rec.stores.set(name, { keyPath, autoIncrement, seq: 0, data: new Map() });
      },
      transaction(names, mode = 'readonly') {
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
        const tx = {
          mode, oncomplete: null, onerror: null, onabort: null, error: null,
          _pending: 0, _failed: null, _done: false,
          objectStore(n) {
            if (!list.includes(n)) throw new Error(`NotFoundError: ${n} not in transaction`);
            return storeApi(rec.stores.get(n), tx);
          },
          _check() {
            if (tx._done || tx._pending > 0) return;
            // すべてのリクエストが終わった後、少し待ってから complete（後続の同期発行を待つ）
            queueMicrotask(() => {
              if (tx._done || tx._pending > 0) return;
              tx._done = true;
              if (tx._failed) { tx.error = tx._failed; tx.onerror && tx.onerror({ target: tx }); }
              else tx.oncomplete && tx.oncomplete({ target: tx });
            });
          },
        };
        // リクエストがひとつも発行されなくても complete する
        queueMicrotask(() => tx._check());
        return tx;
      },
      close() {},
    };
  }

  const fake = {
    opened: 0,
    _databases: databases,
    open(name, version = 1) {
      fake.opened++;
      const r = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        let rec = databases.get(name);
        let upgrade = false;
        if (!rec) { rec = { name, version, stores: new Map() }; databases.set(name, rec); upgrade = true; }
        else if (rec.version < version) { rec.version = version; upgrade = true; }
        r.result = dbApi(rec);
        if (upgrade && r.onupgradeneeded) r.onupgradeneeded({ target: r });
        r.onsuccess && r.onsuccess({ target: r });
      });
      return r;
    },
  };
  return fake;
}

function createFakeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// fetch フェイク：URL → JSON のマップ
function createFakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  f.calls = calls;
  return f;
}

const USER_SET = {
  id: 'user-abc',
  title: '自作セット',
  questions: [
    { id: 'q1', answer: 'A', source: { type: 'local', blobId: 'b_one', start: 0, name: 'a.m4a', duration: 3 } },
    { id: 'q2', answer: 'B', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 0 } },
    { id: 'q3', answer: 'C', source: { type: 'local', blobId: 'b_two', start: 1, name: 'c.m4a', duration: 5 } },
    { id: 'q4', answer: 'D', source: null },
  ],
};

const BUILTIN = {
  schemaVersion: 1, id: 'konbini-chime', title: 'コンビニ入店音', builtin: true,
  questions: [{ id: 'q01', answer: 'ファミリーマート' }],
};

let idb; let ls; let nav; let st;
beforeEach(() => {
  idb = createFakeIndexedDB();
  ls = createFakeLocalStorage();
  nav = { storage: { persist: async () => { nav.persistCalls++; return true; }, estimate: async () => ({ usage: 123, quota: 456 }) }, persistCalls: 0 };
  st = createStorage({ idb, localStorage: ls, navigator: nav, logger: { warn() {} } });
});

describe('import / 環境なし', () => {
  test('indexedDB の無い Node でも import は成功し、呼び出し時に reject する', async () => {
    assert.equal(typeof globalThis.indexedDB, 'undefined');
    assert.equal(typeof storageModule.listUserSets, 'function');
    await assert.rejects(storageModule.listUserSets(), /IndexedDB/);
    await assert.rejects(createStorage({}).getSet('x'), /IndexedDB/);
  });

  test('localStorage が無くても loadSettings/saveSettings は落ちない', async () => {
    const s = createStorage({ idb });
    assert.deepEqual(await s.loadSettings(), {});
    assert.equal(await s.saveSettings({ a: 1 }), false);
  });

  test('estimateUsage は navigator.storage が無ければ null', async () => {
    const s = createStorage({ idb, navigator: {} });
    assert.deepEqual(await s.estimateUsage(), { usage: null, quota: null });
    assert.deepEqual(await st.estimateUsage(), { usage: 123, quota: 456 });
  });
});

describe('ユーザーセット', () => {
  test('saveUserSet → getSet → listUserSets', async () => {
    const saved = await st.saveUserSet(USER_SET);
    assert.equal(saved.id, 'user-abc');
    assert.equal(saved.builtin, false);
    assert.ok(saved.createdAt > 0 && saved.updatedAt >= saved.createdAt);
    assert.equal(nav.persistCalls, 1, '初回保存で persist() を要求');
    const got = await st.getSet('user-abc');
    assert.equal(got.title, '自作セット');
    assert.equal(got.questions.length, 4);
    assert.equal(got.questions[0].source.blobId, 'b_one');
    const list = await st.listUserSets();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'user-abc');
    assert.equal(idb.opened, 1, 'DB は 1 回だけ開く');
    assert.equal(await st.getSet('nope'), null);
  });

  test('上書き保存で createdAt は保持、updatedAt は更新', async () => {
    const a = await st.saveUserSet(USER_SET);
    await new Promise((r) => setTimeout(r, 2));
    const b = await st.saveUserSet({ ...USER_SET, title: '改名' });
    assert.equal(b.createdAt, a.createdAt);
    assert.ok(b.updatedAt >= a.updatedAt);
    assert.equal((await st.listUserSets()).length, 1);
    assert.equal((await st.getSet('user-abc')).title, '改名');
    assert.equal(nav.persistCalls, 1, 'persist は 1 回だけ');
  });

  test('listUserSets は updatedAt 降順', async () => {
    await st.saveUserSet({ id: 'user-1', title: '1' });
    await new Promise((r) => setTimeout(r, 2));
    await st.saveUserSet({ id: 'user-2', title: '2' });
    const ids = (await st.listUserSets()).map((s) => s.id);
    assert.deepEqual(ids, ['user-2', 'user-1']);
  });

  test('不正なセットは validateSet のエラー付きで reject', async () => {
    await assert.rejects(st.saveUserSet({ id: 'user-x', title: '' }), (e) => Array.isArray(e.errors) && e.errors.length > 0);
    await assert.rejects(st.saveUserSet(null), /不正/);
    assert.equal((await st.listUserSets()).length, 0);
  });

  test('builtin:true のセットは保存拒否', async () => {
    await assert.rejects(st.saveUserSet(BUILTIN), /同梱/);
    assert.equal((await st.listUserSets()).length, 0);
  });

  test('deleteUserSet は local 音源 blob もすべて削除する', async () => {
    const b1 = await st.putAudio({ blob: new Blob(['one']), name: 'a.m4a', duration: 3 });
    const b2 = await st.putAudio({ blob: new Blob(['two']), name: 'c.m4a', duration: 5 });
    const b3 = await st.putAudio({ blob: new Blob(['other']) });
    const set = {
      ...USER_SET,
      questions: [
        { id: 'q1', answer: 'A', source: { type: 'local', blobId: b1 } },
        { id: 'q2', answer: 'B', source: { type: 'local', blobId: b2 } },
        { id: 'q3', answer: 'C', source: { type: 'local', blobId: b2 } }, // 同じ blob を 2 問で参照
      ],
    };
    await st.saveUserSet(set);
    assert.ok(await st.getAudio(b1));
    assert.equal(await st.deleteUserSet('user-abc'), true);
    assert.equal(await st.getSet('user-abc'), null);
    assert.equal(await st.getAudio(b1), null);
    assert.equal(await st.getAudio(b2), null);
    assert.ok(await st.getAudio(b3), '無関係な blob は残る');
    assert.equal(await st.deleteUserSet('user-abc'), false, '存在しなければ false');
  });

  test('他のセットからも参照されている blob は残す', async () => {
    const b = await st.putAudio({ blob: new Blob(['shared']) });
    await st.saveUserSet({ id: 'user-1', title: '1', questions: [{ id: 'q', answer: 'a', source: { type: 'local', blobId: b } }] });
    await st.saveUserSet({ id: 'user-2', title: '2', questions: [{ id: 'q', answer: 'a', source: { type: 'local', blobId: b } }] });
    await st.deleteUserSet('user-1');
    assert.ok(await st.getAudio(b));
    await st.deleteUserSet('user-2');
    assert.equal(await st.getAudio(b), null);
  });
});

describe('音源', () => {
  test('putAudio は b_ + UUID、getAudio で Blob と属性が戻る', async () => {
    const blob = new Blob(['hello'], { type: 'audio/mp4' });
    const id = await st.putAudio({ blob, name: '店内.m4a', duration: 31.2 });
    assert.match(id, /^b_[0-9a-f-]{32,36}$/);
    const rec = await st.getAudio(id);
    assert.equal(rec.blobId, id);
    assert.equal(rec.mimeType, 'audio/mp4');
    assert.equal(rec.name, '店内.m4a');
    assert.equal(rec.duration, 31.2);
    assert.ok(rec.createdAt > 0);
    assert.equal(await rec.blob.text(), 'hello');
    const id2 = await st.putAudio({ blob: new Blob(['x']), mimeType: 'audio/webm' });
    assert.notEqual(id, id2);
    assert.equal((await st.getAudio(id2)).mimeType, 'audio/webm');
    assert.equal((await st.getAudio(id2)).duration, null);
  });

  test('deleteAudio と未知 id', async () => {
    const id = await st.putAudio({ blob: new Blob(['x']) });
    await st.deleteAudio(id);
    assert.equal(await st.getAudio(id), null);
    assert.equal(await st.getAudio('b_nope'), null);
    await assert.doesNotReject(st.deleteAudio('b_nope'));
    await assert.rejects(st.putAudio({}), /blob/);
  });
});

describe('結果と設定', () => {
  test('saveResult / listResults（新しい順、limit）', async () => {
    const k1 = await st.saveResult({ setId: 'a', scores: { p1: 3 } });
    const k2 = await st.saveResult({ setId: 'b', scores: { p1: 5 } });
    const k3 = await st.saveResult({ setId: 'c' });
    assert.ok(k1 < k2 && k2 < k3, 'autoIncrement');
    const all = await st.listResults();
    assert.deepEqual(all.map((r) => r.setId), ['c', 'b', 'a']);
    assert.ok(all[0].createdAt > 0);
    assert.equal(all[0].id, k3);
    assert.deepEqual((await st.listResults(2)).map((r) => r.setId), ['c', 'b']);
    assert.equal((await st.listResults(0)).length, 0);
  });

  test('loadSettings / saveSettings は localStorage に JSON', async () => {
    assert.deepEqual(await st.loadSettings(), {});
    assert.equal(await st.saveSettings({ mode: 'buzzer', names: ['a', 'b'] }), true);
    assert.equal(ls.getItem(SETTINGS_KEY), JSON.stringify({ mode: 'buzzer', names: ['a', 'b'] }));
    assert.deepEqual(await st.loadSettings(), { mode: 'buzzer', names: ['a', 'b'] });
    ls.setItem(SETTINGS_KEY, '{broken');
    assert.deepEqual(await st.loadSettings(), {});
    ls.setItem(SETTINGS_KEY, '[1,2]');
    assert.deepEqual(await st.loadSettings(), {});
    const broken = createStorage({ idb, localStorage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('quota'); } } });
    assert.deepEqual(await broken.loadSettings(), {});
    assert.equal(await broken.saveSettings({}), false);
  });
});

describe('loadBuiltinSets', () => {
  const BASE = 'https://example.github.io/wonder-animal-atlas-/intro-don/';
  const routes = {
    [BASE + 'data/sets/index.json']: ['konbini-chime', { id: 'broken' }, { id: 'custom', file: 'custom-file.json' }, 'missing'],
    [BASE + 'data/sets/konbini-chime.json']: BUILTIN,
    [BASE + 'data/sets/broken.json']: { id: 'broken', title: '' },
    [BASE + 'data/sets/custom-file.json']: { id: 'custom', title: 'カスタム', questions: [] },
  };

  test('index.json を基準 URL から相対で取得し、validateSet 済み・builtin:true で返す', async () => {
    const fetch = createFakeFetch(routes);
    const warnings = [];
    const s = createStorage({ idb, fetch, baseUrl: BASE, logger: { warn: (...a) => warnings.push(a) } });
    const sets = await s.loadBuiltinSets();
    assert.deepEqual(sets.map((x) => x.id), ['konbini-chime', 'custom']);
    assert.equal(sets[0].builtin, true);
    assert.equal(sets[1].builtin, true, 'JSON に builtin が無くても同梱扱い');
    assert.equal(sets[0].questions[0].answer, 'ファミリーマート');
    assert.equal(sets[0].difficulty, 2, '正規化済み');
    assert.equal(fetch.calls[0], BASE + 'data/sets/index.json');
    assert.ok(fetch.calls.includes(BASE + 'data/sets/custom-file.json'));
    assert.equal(warnings.length, 2, 'broken と missing を警告');
    // 読み込み後は getSet で同梱セットも引ける
    assert.equal((await s.getSet('konbini-chime')).title, 'コンビニ入店音');
  });

  test('サブパス配信でも相対解決される（document.baseURI 相当を注入）', async () => {
    const base = 'https://user.github.io/repo/intro-don/index.html';
    const fetch = createFakeFetch({ [new URL('data/sets/index.json', base).href]: { sets: [] } });
    const s = createStorage({ idb, fetch, baseUrl: base });
    assert.deepEqual(await s.loadBuiltinSets(), []);
    assert.equal(fetch.calls[0], 'https://user.github.io/repo/intro-don/data/sets/index.json');
  });

  test('index.json が取得できなければ reject', async () => {
    const s = createStorage({ idb, fetch: createFakeFetch({}), baseUrl: BASE });
    await assert.rejects(s.loadBuiltinSets(), /同梱セット一覧/);
    const s2 = createStorage({ idb, fetch: undefined, baseUrl: BASE });
    if (typeof globalThis.fetch !== 'function') await assert.rejects(s2.loadBuiltinSets());
  });
});

describe('DB 構成', () => {
  test('intro-don v1 に sets/audio/results ストアを作る', async () => {
    await st.saveSettings({});
    await st.listUserSets();
    const rec = idb._databases.get(DB_NAME);
    assert.ok(rec);
    assert.equal(rec.version, 1);
    assert.deepEqual([...rec.stores.keys()].sort(), ['audio', 'results', 'sets']);
    assert.equal(rec.stores.get('sets').keyPath, 'id');
    assert.equal(rec.stores.get('audio').keyPath, 'blobId');
    assert.equal(rec.stores.get('results').autoIncrement, true);
  });
});
