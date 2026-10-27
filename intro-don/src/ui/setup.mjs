// 3. ゲーム設定：人数・名前・モード・秒数・得点・出題数・シャッフル → createSession
//    きがるモード（casual）は人数・得点・ペナルティの欄を隠し、プレイヤーは game.createSession が 1 人補う。
//    ホームの「🎧 聴く」からは startQuick() で設定画面を経由せずに開始する。
import * as game from '../game.mjs';
import * as storage from '../storage.mjs';
import { $, $$, clear, fromTemplate, num, clampNum } from './dom.mjs';
import { toastError } from './toast.mjs';
import { state, findSet, colorOf, defaultPlayerName, MAX_PLAYERS, MIN_PLAYERS } from './state.mjs';
import { navigate, back } from './router.mjs';

const MODE_DESC = {
  casual: '得点なし。流して、答えを見て、次へ。',
  host: '司会が「どん！」で再生し、答えた人をタップして加点します（1〜8人）。',
  buzzer: 'スマホを机の中央に置き、画面を人数分の早押しボタンに分割します（2〜4人）。',
};

let els;
let set = null;
let mode = 'host';
let playerCount = 2;
let names = [];
let starting = false; // 「スタート」の二重起動ガード

export function initSetup() {
  els = {
    section: $('[data-screen="setup"]'),
    setName: $('#setup-set-name'),
    modeSeg: $('#mode-seg'),
    modeDesc: $('#mode-desc'),
    playersBlock: $('#players-block'),
    pointsRow: $('#setup-points-row'),
    penaltyField: $('#setup-penalty-field'),
    advSummary: $('#adv-summary'),
    minus: $('#players-minus'),
    plus: $('#players-plus'),
    count: $('#players-count'),
    list: $('#players-list'),
    playSeconds: $('#setup-play-seconds'),
    extendSeconds: $('#setup-extend-seconds'),
    p1: $('#setup-points-1'),
    p2: $('#setup-points-2'),
    p3: $('#setup-points-3'),
    penalty: $('#setup-penalty'),
    limit: $('#setup-limit'),
    shuffle: $('#setup-shuffle'),
    start: $('#btn-start'),
  };
  $('[data-nav="back"]', els.section).addEventListener('click', () => back('home'));
  $$('.seg-btn', els.modeSeg).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  els.minus.addEventListener('click', () => setCount(playerCount - 1));
  els.plus.addEventListener('click', () => setCount(playerCount + 1));
  els.start.addEventListener('click', start);
  return { el: els.section, enter, leave };
}

async function enter({ id }) {
  set = findSet(id);
  if (!set) {
    try { set = await storage.getSet(id); } catch (e) { set = null; }
  }
  if (!set) return false;
  if (!set.questions || set.questions.length === 0) {
    toastError('問題が1件以上ないとプレイできません。');
    return { redirect: 'set', params: { id } };
  }
  const s = state.settings || {};
  els.setName.textContent = `${set.emoji || '🎵'} ${set.title}（${set.questions.length}問）`;
  names = Array.isArray(s.playerNames) ? s.playerNames.slice(0, 8) : [];
  playerCount = num(s.playerCount, 2);
  const sameSet = s.lastSetId === set.id;
  els.playSeconds.value = sameSet && s.playSeconds ? s.playSeconds : (set.playSeconds ?? 1.5);
  els.extendSeconds.value = sameSet && s.extendSeconds ? s.extendSeconds : (set.extendSeconds ?? 2);
  const pts = Array.isArray(s.points) && s.points.length === 3 ? s.points : [3, 2, 1];
  [els.p1.value, els.p2.value, els.p3.value] = pts;
  els.penalty.value = String(num(s.wrongPenalty, 0) === -1 ? -1 : 0);
  els.limit.value = s.questionLimit ? String(s.questionLimit) : '';
  els.limit.max = String(set.questions.length);
  els.limit.placeholder = `全問（${set.questions.length}）`;
  els.shuffle.checked = s.shuffle !== false;
  setMode(game.MODES.includes(s.mode) ? s.mode : 'host');
  return true;
}

function leave() {}

function setMode(m) {
  mode = game.MODES.includes(m) ? m : 'host';
  $$('.seg-btn', els.modeSeg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  els.modeDesc.textContent = MODE_DESC[mode];
  const casual = mode === 'casual';
  // きがるモードは人数・名前・得点・ペナルティを使わない（値は保持したまま隠すだけ）
  els.playersBlock.hidden = casual;
  els.pointsRow.hidden = casual;
  els.penaltyField.hidden = casual;
  els.advSummary.textContent = casual ? '秒数・出題' : '秒数・得点・出題';
  if (!casual) setCount(playerCount);
}

function setCount(n) {
  playerCount = clampNum(n, MIN_PLAYERS[mode], MAX_PLAYERS[mode]);
  els.count.value = String(playerCount);
  els.minus.disabled = playerCount <= MIN_PLAYERS[mode];
  els.plus.disabled = playerCount >= MAX_PLAYERS[mode];
  renderPlayers();
}

function renderPlayers() {
  // 入力中の名前を保持してから描き直す
  $$('.player-name', els.list).forEach((inp, i) => { names[i] = inp.value; });
  clear(els.list);
  for (let i = 0; i < playerCount; i++) {
    const row = fromTemplate('tpl-player-row');
    $('.player-swatch', row).style.background = colorOf(i);
    const inp = $('.player-name', row);
    inp.value = names[i] || '';
    inp.placeholder = defaultPlayerName(i);
    inp.addEventListener('input', () => { names[i] = inp.value; });
    els.list.append(row);
  }
}

function readSettings() {
  const total = set.questions.length;
  const limitRaw = els.limit.value.trim();
  const limit = limitRaw ? clampNum(Math.floor(num(limitRaw, total)), 1, total) : null;
  const common = {
    mode,
    playSeconds: clampNum(num(els.playSeconds.value, set.playSeconds ?? 1.5), 0.5, 30),
    extendSeconds: clampNum(num(els.extendSeconds.value, set.extendSeconds ?? 2), 0.5, 30),
    shuffle: els.shuffle.checked,
    questionLimit: limit,
  };
  // きがるモードは得点・ペナルティを持たない（保存される設定でも他モードの値を上書きしない）
  if (mode === 'casual') return common;
  return {
    ...common,
    points: [els.p1, els.p2, els.p3].map((e, i) => clampNum(Math.floor(num(e.value, [3, 2, 1][i])), 0, 99)),
    wrongPenalty: els.penalty.value === '-1' ? -1 : 0,
  };
}

async function start() {
  if (starting) return;
  starting = true;
  els.start.disabled = true;
  try {
    await doStart();
  } finally {
    starting = false;
    els.start.disabled = false;
  }
}

async function doStart() {
  const settings = readSettings();
  const players = [];
  if (mode !== 'casual') {
    for (let i = 0; i < playerCount; i++) {
      const name = (names[i] || '').trim() || defaultPlayerName(i);
      players.push({ id: `p${i + 1}`, name, color: colorOf(i) });
    }
  }
  if (!beginSession({ set, players, settings })) return;
  state.settings = {
    ...(state.settings || {}),
    ...settings,
    lastSetId: set.id,
  };
  if (mode !== 'casual') {
    // きがるモードでは人数・名前を触らない（次に司会／早押しを選んだとき前回の値が残るように）
    state.settings.playerCount = playerCount;
    state.settings.playerNames = players.map((p) => p.name);
  }
  try { await storage.saveSettings(state.settings); } catch (e) { /* 記憶できなくても続行 */ }
  navigate('play');
}

/**
 * Session を作って state に載せる（設定画面のスタートとホームの「🎧 聴く」で共通）。
 * players が空のときは createSession が補った players（きがるモードの「みんな」）を使う。
 * @returns {boolean} 開始できたか（失敗時はトースト済み）
 */
function beginSession({ set: target, players, settings }) {
  let session;
  try {
    session = game.createSession({ set: target, players, settings });
  } catch (e) {
    console.error(e);
    toastError('ゲームを開始できませんでした：' + (e && e.message ? e.message : '不明なエラー'));
    return false;
  }
  state.set = target;
  state.players = session.players;
  state.session = session;
  state.lastSetup = { set: target, players: session.players, settings };
  state.resultSaved = false;
  return true;
}

/**
 * 設定画面を経由せずに即プレイ開始（ホームの「🎧 聴く」）。
 * 秒数は前回この set で使った設定（無ければ set の既定）、シャッフル有り、全問。
 * 保存済み設定（モード・人数・得点など）は変更しない。
 * @param {object} target セット
 * @param {{ mode?: string }} [opts] mode は既定 'casual'
 * @returns {boolean} 開始できたか
 */
export function startQuick(target, { mode: m = 'casual' } = {}) {
  if (!target || !target.questions || target.questions.length === 0) {
    toastError('問題が1件以上ないとプレイできません。');
    return false;
  }
  const s = state.settings || {};
  const sameSet = s.lastSetId === target.id;
  const settings = {
    mode: game.MODES.includes(m) ? m : 'casual',
    playSeconds: clampNum(num(sameSet ? s.playSeconds : undefined, target.playSeconds ?? 1.5), 0.5, 30),
    extendSeconds: clampNum(num(sameSet ? s.extendSeconds : undefined, target.extendSeconds ?? 2), 0.5, 30),
    shuffle: true,
    questionLimit: null,
  };
  if (!beginSession({ set: target, players: [], settings })) return false;
  navigate('play');
  return true;
}
