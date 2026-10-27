// 3. ゲーム設定：人数・名前・モード・秒数・得点・出題数・シャッフル → createSession
import * as game from '../game.mjs';
import * as storage from '../storage.mjs';
import { $, $$, clear, fromTemplate, num, clampNum } from './dom.mjs';
import { toastError } from './toast.mjs';
import { state, findSet, colorOf, defaultPlayerName, MAX_PLAYERS, MIN_PLAYERS } from './state.mjs';
import { navigate, back } from './router.mjs';

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
  setMode(s.mode === 'buzzer' ? 'buzzer' : 'host');
  return true;
}

function leave() {}

function setMode(m) {
  mode = m === 'buzzer' ? 'buzzer' : 'host';
  $$('.seg-btn', els.modeSeg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  els.modeDesc.textContent = mode === 'host'
    ? '司会が「どん！」で再生し、答えた人をタップして加点します（1〜8人）。'
    : 'スマホを机の中央に置き、画面を人数分の早押しボタンに分割します（2〜4人）。';
  setCount(playerCount);
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
  return {
    mode,
    playSeconds: clampNum(num(els.playSeconds.value, set.playSeconds ?? 1.5), 0.5, 30),
    extendSeconds: clampNum(num(els.extendSeconds.value, set.extendSeconds ?? 2), 0.5, 30),
    points: [els.p1, els.p2, els.p3].map((e, i) => clampNum(Math.floor(num(e.value, [3, 2, 1][i])), 0, 99)),
    wrongPenalty: els.penalty.value === '-1' ? -1 : 0,
    shuffle: els.shuffle.checked,
    questionLimit: limit,
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
  for (let i = 0; i < playerCount; i++) {
    const name = (names[i] || '').trim() || defaultPlayerName(i);
    players.push({ id: `p${i + 1}`, name, color: colorOf(i) });
  }
  let session;
  try {
    session = game.createSession({ set, players, settings });
  } catch (e) {
    console.error(e);
    toastError('ゲームを開始できませんでした：' + (e && e.message ? e.message : '不明なエラー'));
    return;
  }
  state.set = set;
  state.players = players;
  state.session = session;
  state.lastSetup = { set, players, settings };
  state.resultSaved = false;
  state.settings = {
    ...(state.settings || {}),
    ...settings,
    playerCount,
    playerNames: players.map((p) => p.name),
    lastSetId: set.id,
  };
  try { await storage.saveSettings(state.settings); } catch (e) { /* 記憶できなくても続行 */ }
  navigate('play');
}
