// 画面下部トースト（日本語メッセージ、任意のアクションボタン付き）
// duration: 0 は常駐（閉じるのは返り値の remove() かアクションボタン）。常駐トーストは「最大 3 件」の間引き対象にしない。
import { $, el } from './dom.mjs';

export const MAX_TOASTS = 3;

export function toast(message, { kind = 'info', duration = 3500, action = null } = {}) {
  const host = $('#toast-host');
  if (!host) return () => {};
  const persistent = !(duration > 0);
  const node = el('div', { class: 'toast', dataset: { kind, ...(persistent ? { persistent: '' } : {}) }, role: 'status' }, [
    el('span', { class: 'toast-msg', text: message }),
  ]);
  const remove = () => { node.remove(); };
  if (action) {
    node.append(el('button', {
      class: 'toast-action', type: 'button', text: action.label,
      onclick: () => { remove(); if (typeof action.onClick === 'function') action.onClick(); },
    }));
  }
  host.append(node);
  // 同時表示は 3 件まで（常駐トーストは数えず、間引きもしない）
  const transient = () => Array.from(host.children).filter((c) => !c.dataset || c.dataset.persistent == null);
  for (let list = transient(); list.length > MAX_TOASTS; list = transient()) list[0].remove();
  if (!persistent) setTimeout(remove, duration);
  return remove;
}

export const toastError = (message) => toast(message, { kind: 'error', duration: 5000 });
export const toastOk = (message) => toast(message, { kind: 'success' });
