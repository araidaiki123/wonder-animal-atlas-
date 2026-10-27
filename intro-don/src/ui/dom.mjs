// DOM ヘルパ。ユーザー文字列は必ず textContent / 要素生成で描画する（innerHTML は使わない）。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// el('button', { class: 'btn', text: '保存', dataset: { id }, onclick: fn }, [children])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fromTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

export function openDialog(dlg) {
  if (dlg.open) return;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

export function closeDialog(dlg) {
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}

// data-close ボタン（×）と背景タップで閉じる。Esc は <dialog> 標準の cancel で閉じる。
// { backdrop: false } で背景タップによるクローズを無効化できる（録音中など誤タップで閉じたくないダイアログ用）。
export function bindDialogClose(dlg, onClose, { backdrop = true } = {}) {
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => closeDialog(dlg)));
  if (backdrop) dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(dlg); });
  if (onClose) dlg.addEventListener('close', onClose);
}

export function num(value, fallback) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampNum(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  return d;
}

// 短い音源の長さを取得（失敗・タイムアウトは 0）
export function probeDuration(blob, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('audio');
    const finish = (v) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(v); };
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => finish(Number.isFinite(a.duration) ? a.duration : 0));
    a.addEventListener('error', () => finish(0));
    setTimeout(() => finish(0), timeoutMs);
    a.src = url;
  });
}
