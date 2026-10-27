// location.hash ベースのルーター。#/home, #/set/<id>, #/setup/<id>, #/play, #/result
// 画面は <section data-screen="name"> で、enter({ id }) / leave() を持つ。
// enter が false を返せばホームへ、{ redirect, params } を返せばその画面へ置換遷移する。

const screens = new Map();
let current = null;
let routing = 0;

export function registerScreen(name, { el, enter, leave }) {
  screens.set(name, { name, el, enter, leave });
}

export function buildHash(name, params = {}) {
  let h = `#/${name}`;
  if (params.id != null) h += `/${encodeURIComponent(params.id)}`;
  return h;
}

export function parseHash(hash = location.hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/');
  try {
    return { name: parts[0] || 'home', id: parts[1] ? decodeURIComponent(parts[1]) : undefined };
  } catch {
    // 不正なパーセントエンコード（#/set/%E0 など）はホーム扱い
    return { name: 'home', id: undefined };
  }
}

export function navigate(name, params = {}, { replace = false } = {}) {
  const hash = buildHash(name, params);
  if (replace) {
    history.replaceState(null, '', location.pathname + location.search + hash);
    route();
  } else if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

export function currentScreen() {
  return current ? current.name : null;
}

export function back(fallback = 'home') {
  if (history.length > 1) history.back();
  else navigate(fallback, {}, { replace: true });
}

async function safeLeave(screen) {
  try { await screen.leave?.(); } catch (e) { console.warn(e); }
}

async function route() {
  const token = ++routing;
  const { name, id } = parseHash();
  const target = screens.get(name) || screens.get('home');
  if (!target) return;
  if (current && current !== target) {
    const prev = current;
    current = null;
    await safeLeave(prev);
  }
  if (token !== routing) return; // leave 中に別の遷移が始まった（その遷移が続きを担当する）
  let result;
  try { result = await target.enter?.({ id }); } catch (e) { console.error(e); result = false; }
  if (token !== routing) {
    // enter 中に別の遷移が始まった：この画面は表示されないので、enter で確保したものを leave で片付ける
    if (current !== target) await safeLeave(target);
    return;
  }
  if (result === false) { navigate('home', {}, { replace: true }); return; }
  if (result && typeof result === 'object' && result.redirect) {
    navigate(result.redirect, result.params || {}, { replace: true });
    return;
  }
  for (const s of screens.values()) s.el.hidden = s !== target;
  current = target;
  window.scrollTo(0, 0);
}

export function startRouter() {
  window.addEventListener('hashchange', () => { route(); });
  route();
}

/** テスト用：登録画面と現在画面をリセットする */
export function _resetRouterForTests() {
  screens.clear();
  current = null;
  routing = 0;
}
