/**
 * UI 基盤モジュール（router / toast / dom）のテスト（node --test）。
 * window / document / location / history は最小のフェイクで置き換える。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 最小 DOM フェイク
// ---------------------------------------------------------------------------
class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.open = false;
    this._l = new Map();
  }
  addEventListener(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); }
  removeEventListener(ev, fn) { this._l.get(ev)?.delete(fn); }
  dispatch(ev, detail = {}) { for (const fn of [...(this._l.get(ev) || [])]) fn({ type: ev, target: this, ...detail }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for (const n of nodes) { if (n instanceof FakeNode) { n.parentNode = this; this.children.push(n); } } }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstElementChild() { return this.children[0] || null; }
  get firstChild() { return this.children[0] || null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  close() { this.open = false; this.dispatch('close'); }
  showModal() { this.open = true; }
}
function matches(node, sel) {
  if (sel.startsWith('#')) return node.attrs.id === sel.slice(1);
  if (sel.startsWith('[') && sel.endsWith(']')) return (`data-${sel.slice(1, -1).replace(/^data-/, '')}`) in node.attrs || sel.slice(1, -1) in node.attrs;
  return node.tagName === sel.toUpperCase();
}

function installFakeDom() {
  const body = new FakeNode('body');
  const doc = {
    body,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (s) => Object.assign(new FakeNode('#text'), { textContent: String(s) }),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    getElementById: (id) => body.querySelector(`#${id}`),
  };
  globalThis.document = doc;
  globalThis.Node = FakeNode;
  const loc = { hash: '', pathname: '/intro-don/', search: '' };
  globalThis.location = loc;
  const hist = { length: 1, replaceState(_s, _t, url) { loc.hash = url.slice(url.indexOf('#')); } };
  globalThis.history = hist;
  globalThis.window = freshWindow();
  return { body, doc, loc, hist, win: globalThis.window };
}

/** window は startRouter() がリスナーを足すので、テストごとに作り直す */
function freshWindow() {
  const winListeners = new Map();
  return {
    addEventListener(ev, fn) { if (!winListeners.has(ev)) winListeners.set(ev, new Set()); winListeners.get(ev).add(fn); },
    scrollTo() {},
    dispatch(ev) { for (const fn of [...(winListeners.get(ev) || [])]) fn({ type: ev }); },
  };
}

const fx = installFakeDom();
const router = await import('../src/ui/router.mjs');
const { toast, MAX_TOASTS } = await import('../src/ui/toast.mjs');
const { bindDialogClose, el } = await import('../src/ui/dom.mjs');

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------
// router.parseHash
// ---------------------------------------------------------------------------
describe('router.parseHash', () => {
  test('#/name/id を分解し、空はホーム', () => {
    assert.deepEqual(router.parseHash('#/set/abc'), { name: 'set', id: 'abc' });
    assert.deepEqual(router.parseHash('#/home'), { name: 'home', id: undefined });
    assert.deepEqual(router.parseHash(''), { name: 'home', id: undefined });
    assert.deepEqual(router.parseHash('#'), { name: 'home', id: undefined });
    assert.deepEqual(router.parseHash(router.buildHash('set', { id: 'あ/い' })), { name: 'set', id: 'あ/い' });
  });

  test('decodeURIComponent に失敗する不正値はホーム扱い（throw しない）', () => {
    assert.deepEqual(router.parseHash('#/set/%E0'), { name: 'home', id: undefined });
    assert.deepEqual(router.parseHash('#/set/%'), { name: 'home', id: undefined });
    assert.deepEqual(router.parseHash(null), { name: 'home', id: undefined });
  });
});

// ---------------------------------------------------------------------------
// router.route：遷移の競合と leave()
// ---------------------------------------------------------------------------
describe('router 遷移の競合', () => {
  let log;
  let release;   // 遅い enter を解放する

  function screen(name, { slowEnter = false, enterResult } = {}) {
    const elx = new FakeNode('section');
    router.registerScreen(name, {
      el: elx,
      enter: async ({ id }) => {
        log.push(`enter:${name}${id ? ':' + id : ''}`);
        if (slowEnter) await new Promise((r) => { release = r; });
        return enterResult;
      },
      leave: async () => { log.push(`leave:${name}`); },
    });
    return elx;
  }

  beforeEach(() => {
    router._resetRouterForTests();
    log = [];
    release = null;
    fx.loc.hash = '';
    fx.win = globalThis.window = freshWindow();
  });

  test('通常遷移：前の画面の leave → 次の enter → 表示', async () => {
    const home = screen('home');
    const set = screen('set');
    router.startRouter();
    await tick();
    assert.deepEqual(log, ['enter:home']);
    assert.equal(router.currentScreen(), 'home');
    assert.equal(home.hidden, false);
    assert.equal(set.hidden, true);

    fx.loc.hash = '#/set/x1';
    fx.win.dispatch('hashchange');
    await tick();
    assert.deepEqual(log, ['enter:home', 'leave:home', 'enter:set:x1']);
    assert.equal(router.currentScreen(), 'set');
    assert.equal(set.hidden, false);
  });

  test('enter 中に別の遷移が割り込んだら、割り込まれた画面の leave() が必ず呼ばれる', async () => {
    screen('home');
    const setup = screen('setup', { slowEnter: true });
    const play = screen('play');
    router.startRouter();
    await tick();

    fx.loc.hash = '#/setup/s1';
    fx.win.dispatch('hashchange');
    await tick();
    assert.deepEqual(log, ['enter:home', 'leave:home', 'enter:setup:s1']);   // setup.enter が pending

    fx.loc.hash = '#/play';
    fx.win.dispatch('hashchange');
    await tick();
    // current は null なので play の前に leave は無い。play は表示済み
    assert.deepEqual(log, ['enter:home', 'leave:home', 'enter:setup:s1', 'enter:play']);
    assert.equal(router.currentScreen(), 'play');
    assert.equal(play.hidden, false);

    release();   // 遅れて setup.enter が完了
    await tick();
    assert.deepEqual(log, ['enter:home', 'leave:home', 'enter:setup:s1', 'enter:play', 'leave:setup']);
    assert.equal(router.currentScreen(), 'play', '割り込まれた画面は表示されない');
    assert.equal(setup.hidden, true);
  });

  test('enter が false を返したらホームへ、redirect ならその画面へ', async () => {
    screen('home');
    screen('set', { enterResult: false });
    screen('setup', { enterResult: { redirect: 'set', params: { id: 'r' } } });
    router.startRouter();
    await tick();
    fx.loc.hash = '#/setup/zz';
    fx.win.dispatch('hashchange');
    await tick(10);
    assert.deepEqual(log, ['enter:home', 'leave:home', 'enter:setup:zz', 'enter:set:r', 'enter:home']);
    assert.equal(router.currentScreen(), 'home');
  });
});

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------
describe('toast', () => {
  let host;
  beforeEach(() => {
    fx.body.children = [];
    host = new FakeNode('div');
    host.attrs.id = 'toast-host';
    fx.body.append(host);
  });

  test('host が無ければ no-op の remove を返す', () => {
    fx.body.children = [];
    assert.equal(typeof toast('x'), 'function');
  });

  test('一時トーストは最大 3 件に間引く', () => {
    for (let i = 1; i <= 5; i++) toast(`t${i}`);
    assert.equal(MAX_TOASTS, 3);
    assert.deepEqual(host.children.map((c) => c.children[0].textContent), ['t3', 't4', 't5']);
  });

  test('duration:0 の常駐トーストは間引かれず、数にも入れない', () => {
    const removePersist = toast('更新があります', { duration: 0, action: { label: '再読み込み', onClick() {} } });
    for (let i = 1; i <= 5; i++) toast(`t${i}`);
    const texts = host.children.map((c) => c.children[0].textContent);
    assert.deepEqual(texts, ['更新があります', 't3', 't4', 't5']);
    assert.equal('persistent' in host.children[0].dataset, true);
    // 常駐が後から来ても同様
    toast('常駐2', { duration: 0 });
    for (let i = 6; i <= 8; i++) toast(`t${i}`);
    assert.deepEqual(host.children.map((c) => c.children[0].textContent), ['更新があります', '常駐2', 't6', 't7', 't8']);
    removePersist();
    assert.deepEqual(host.children.map((c) => c.children[0].textContent), ['常駐2', 't6', 't7', 't8']);
  });

  test('アクションボタンで閉じて onClick を呼ぶ', () => {
    let clicked = 0;
    toast('a', { duration: 0, action: { label: 'OK', onClick: () => { clicked++; } } });
    const btn = host.children[0].querySelector('button');
    assert.equal(btn.textContent, 'OK');
    btn.dispatch('click');
    assert.equal(clicked, 1);
    assert.equal(host.children.length, 0);
  });
});

// ---------------------------------------------------------------------------
// dom.bindDialogClose
// ---------------------------------------------------------------------------
describe('dom.bindDialogClose', () => {
  function dialog() {
    const dlg = new FakeNode('dialog');
    const x = el('button', { 'data-close': true, text: '×' });
    dlg.append(x);
    dlg.open = true;
    return { dlg, x };
  }

  test('既定：× と背景タップで閉じ、close で onClose', () => {
    const { dlg, x } = dialog();
    let closed = 0;
    bindDialogClose(dlg, () => { closed++; });
    dlg.dispatch('click', { target: dlg });
    assert.equal(dlg.open, false);
    assert.equal(closed, 1);
    dlg.open = true;
    x.dispatch('click');
    assert.equal(dlg.open, false);
    assert.equal(closed, 2);
  });

  test('{ backdrop: false }：背景タップでは閉じない（× は従来どおり）', () => {
    const { dlg, x } = dialog();
    let closed = 0;
    bindDialogClose(dlg, () => { closed++; }, { backdrop: false });
    dlg.dispatch('click', { target: dlg });
    assert.equal(dlg.open, true);
    assert.equal(closed, 0);
    x.dispatch('click');
    assert.equal(dlg.open, false);
    assert.equal(closed, 1);
  });

  test('ダイアログ内の要素タップは閉じない', () => {
    const { dlg } = dialog();
    const inner = el('p', { text: '本文' });
    dlg.append(inner);
    bindDialogClose(dlg);
    dlg.dispatch('click', { target: inner });
    assert.equal(dlg.open, true);
  });
});
