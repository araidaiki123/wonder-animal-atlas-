// アプリ全体で共有する状態（セット一覧・設定・進行中セッション）
import * as storage from '../storage.mjs';

export const PLAYER_COLORS = ['#ffe600', '#ff2d95', '#2de2ff', '#3cff8f'];
export const MAX_PLAYERS = { host: 8, buzzer: 4 };
export const MIN_PLAYERS = { host: 1, buzzer: 2 };

export const state = {
  builtinSets: [],
  userSets: [],
  builtinError: false,
  settings: {},
  set: null,         // プレイ中のセット
  session: null,     // game.Session
  players: [],
  lastSetup: null,   // { set, players, settings }（もう一回用）
  resultSaved: false,
};

export function colorOf(index) {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function defaultPlayerName(index) {
  return `プレイヤー${index + 1}`;
}

export async function refreshSets() {
  try {
    state.builtinSets = (await storage.loadBuiltinSets()) || [];
    state.builtinError = false;
  } catch (e) {
    console.warn('同梱セットの読み込みに失敗', e);
    state.builtinSets = [];
    state.builtinError = true;
  }
  try {
    state.userSets = (await storage.listUserSets()) || [];
  } catch (e) {
    console.warn('自作セットの読み込みに失敗', e);
    state.userSets = [];
  }
}

export function findSet(id) {
  return state.userSets.find((s) => s.id === id) || state.builtinSets.find((s) => s.id === id) || null;
}

// state.userSets 内の同 id を置換（なければ追加）
export function upsertUserSet(set) {
  const i = state.userSets.findIndex((s) => s.id === set.id);
  if (i >= 0) state.userSets[i] = set; else state.userSets.push(set);
}

export function removeUserSet(id) {
  state.userSets = state.userSets.filter((s) => s.id !== id);
}

// 音源の種別。録音は local と同じ経路なので name の接頭辞で区別する（暫定）
export function sourceKind(q) {
  const s = q && q.source;
  if (!s || !s.type) return 'none';
  if (s.type === 'youtube') return 'youtube';
  if (s.type === 'local') return /^録音/.test(s.name || '') ? 'record' : 'local';
  return 'none';
}

export const SOURCE_LABEL = { youtube: 'YouTube', local: '端末', record: '録音', none: '未設定' };

export function sourceStats(set) {
  const qs = set.questions || [];
  return { total: qs.length, withSource: qs.filter((q) => sourceKind(q) !== 'none').length };
}

export function difficultyStars(d) {
  const n = Math.min(3, Math.max(1, Number(d) || 2));
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

export function searchLinks(q) {
  const term = (q && (q.searchQuery || q.answer)) || '';
  return {
    youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
    apple: `https://music.apple.com/jp/search?term=${encodeURIComponent(term)}`,
  };
}
