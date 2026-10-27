// 画面下部トースト（日本語メッセージ、任意のアクションボタン付き）
import { $, el } from './dom.mjs';

export function toast(message, { kind = 'info', duration = 3500, action = null } = {}) {
  const host = $('#toast-host');
  if (!host) return () => {};
  const node = el('div', { class: 'toast', dataset: { kind }, role: 'status' }, [
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
  // 同時表示は 3 件まで
  while (host.children.length > 3) host.firstElementChild.remove();
  if (duration > 0) setTimeout(remove, duration);
  return remove;
}

export const toastError = (message) => toast(message, { kind: 'error', duration: 5000 });
export const toastOk = (message) => toast(message, { kind: 'success' });
