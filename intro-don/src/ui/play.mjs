// 4. プレイ：どん！ボタン・プログレス・ヒント・ストップ・正解者・早押し分割パネル・正解表示
import * as game from '../game.mjs';
import { createPlayer, PLAY_START_TIMEOUT_MESSAGE } from '../audio/player.mjs';
import * as storage from '../storage.mjs';
import { $, $$, el, clear, fromTemplate } from './dom.mjs';
import { toast, toastError } from './toast.mjs';
import { state, searchLinks } from './state.mjs';
import { navigate, parseHash } from './router.mjs';
import { unlockAudio, buzzSound, correctSound, wrongSound } from './sound.mjs';

const RING = 289.03; // 2π×46
const WARMUP_TEXT = '▶ 中央を1回タップして準備';
const WARMUP_HUB_TEXT = '上の動画枠の中央を1回タップして準備';
const STANDALONE_HINT_KEY = 'intro-don:standaloneHintShown';
const GUIDE_TOAST_MS = 4000;    // 案内トーストの表示時間
const GUARD_BACK_TEXT = 'ゲーム中です。やめる場合は左上の × を押してください';
const LEAVE_FALLBACK_MS = 600;  // 番兵の履歴を history.back() で捨てたあと popstate が来ない場合の保険

let els;
let player = null;
let unlocked = false;
let wakeLock = null;
let wakeLockPending = false;   // acquireWakeLock の再入防止
let wakeLockHintShown = false; // 失敗時の案内は早押しモードで一度だけ
let active = false;
let gameSeq = 0;               // enter() ごとに増える（非同期の案内・準備が別ゲームに漏れないように）
let prepareSeq = 0;            // prepareCurrent() ごとに増える（古い準備の完了が新しい準備の loading を潰さないように）
let preparedQid = null;
let loading = false;           // 音源の準備中（どん！を無効化）
let ring = { total: 0, remaining: 0, at: 0, running: false, raf: 0 };
let judgeWrongMode = false;
let warmingUp = false;         // iOS 向け YouTube 暖機中（iframe の直接タップ待ち）
let errorNotified = false;     // 1 回の再生／準備につきエラートーストは一度だけ
let sourceFailNotified = false; // 音源が使えない問題で「別アプリで流して」案内を出したか（問題ごと）
let soundHintShown = false;    // 「音が出ないときは…」は初回のみ
let guideShownThisGame = false; // 案内トースト（ホーム画面追加／自動ロック／音量）は 1 ゲームにつき 1 件だけ
let guideUntil = 0;            // 案内トーストが表示されている間（ms, Date.now 基準）は別の案内を出さない
let pendingLeave = null;       // 番兵の履歴を捨てたあとに置換遷移する先（'home' | 'result'）
let pendingLeaveTimer = 0;

// タッチ端末か（iOS/Android では YouTube iframe の初回再生に直接タップが必要になることがある）
function isTouchDevice() {
  try { return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}

export function initPlay() {
  els = {
    section: $('[data-screen="play"]'),
    quit: $('#btn-quit'),
    counter: $('#play-counter'),
    modeBadge: $('#play-mode-badge'),
    scores: $('#play-scores'),
    ytBox: $('#yt-box'),
    ytMount: $('#yt-mount'),
    ytOverlay: $('#yt-overlay'),
    ytOverlayText: $('#yt-overlay-text'),
    hostStage: $('#host-stage'),
    donWrap: $('.don-wrap', $('#host-stage')),
    don: $('#don-button'),
    donRing: $('#don-ring-fg'),
    donSub: $('#don-sub'),
    noSource: $('#no-source-panel'),
    nsYt: $('#ns-yt-link'),
    nsAm: $('#ns-am-link'),
    countLabel: $('#play-count-label'),
    pointsLabel: $('#play-points-label'),
    hints: $('#hint-area'),
    hint: $('#btn-hint'),
    stop: $('#btn-stop'),
    reveal: $('#btn-reveal'),
    judge: $('#judge-panel'),
    judgePlayers: $('#judge-players'),
    judgeWrong: $('#judge-wrong-mode'),
    judgeCancel: $('#btn-judge-cancel'),
    judgeReveal: $('#btn-judge-reveal'),
    buzzStage: $('#buzz-stage'),
    buzzGrid: $('#buzz-grid'),
    buzzDon: $('#buzz-don'),
    buzzRing: $('#buzz-ring-fg'),
    buzzDonSub: $('#buzz-don-sub'),
    buzzStatus: $('#buzz-status'),
    buzzJudge: $('#buzz-judge'),
    buzzCorrect: $('#buzz-correct'),
    buzzWrong: $('#buzz-wrong'),
    buzzHint: $('#buzz-hint'),
    buzzReveal: $('#buzz-reveal'),
    buzzHints: $('#buzz-hints'),
    buzzNoSource: $('#buzz-no-source'),
    bzYt: $('#bz-yt-link'),
    bzAm: $('#bz-am-link'),
    revealPanel: $('#reveal-panel'),
    revealAnswer: $('#reveal-answer'),
    revealSubtitle: $('#reveal-subtitle'),
    revealWinner: $('#reveal-winner'),
    revealThumb: $('#reveal-thumb'),
    revealTrivia: $('#reveal-trivia'),
    revealAliases: $('#reveal-aliases'),
    next: $('#btn-next'),
    warmupSkip: $('#yt-warmup-skip'),
  };

  els.quit.addEventListener('click', () => {
    if (window.confirm('ゲームをやめてホームに戻りますか？')) quitGame();
  });
  // 「どん！」は pointerdown ではなく click（iOS の play() 制約のためユーザー操作内で同期的に呼ぶ）
  els.don.addEventListener('click', onDon);
  els.buzzDon.addEventListener('click', onDon);
  els.stop.addEventListener('click', onStop);
  els.hint.addEventListener('click', onHint);
  els.buzzHint.addEventListener('click', onHint);
  els.reveal.addEventListener('click', onReveal);
  // 早押しハブの「答え」は小さく誤タップしやすいので確認を挟む
  els.buzzReveal.addEventListener('click', () => {
    const s = state.session;
    if (!s || s.phase === 'revealed') return;
    if (window.confirm('答えを表示しますか？')) onReveal();
  });
  els.judgeReveal.addEventListener('click', onReveal);
  els.judgeCancel.addEventListener('click', onJudgeCancel);
  els.judgeWrong.addEventListener('change', () => { judgeWrongMode = els.judgeWrong.checked; els.judge.dataset.wrong = String(judgeWrongMode); });
  els.buzzCorrect.addEventListener('click', () => onJudge(true, state.session.buzzedBy));
  els.buzzWrong.addEventListener('click', () => onJudge(false, state.session.buzzedBy));
  els.next.addEventListener('click', onNext);
  els.warmupSkip.addEventListener('click', onWarmupSkip);
  els.revealThumb.addEventListener('error', () => { els.revealThumb.hidden = true; });
  els.buzzGrid.addEventListener('pointerdown', onBuzzPointer);
  els.buzzGrid.addEventListener('keydown', onBuzzKey);
  els.buzzGrid.addEventListener('contextmenu', (e) => e.preventDefault());
  // 初回タップでオーディオを解放（iOS は click などの「本物のユーザー操作」内でないと解放されない）
  els.section.addEventListener('click', () => { unlockAudio(); unlockPlayer(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) acquireWakeLock();
  });

  // 戻る操作（ブラウザバック・スワイプ）でうっかりゲームを抜けないようにする。
  // enter() で同じ URL の履歴（番兵）を 1 つ積んでおき、戻った先がまだ #/play なら案内トーストを出して forward() で戻す。
  // iOS Safari のスワイプバック中は window.confirm が無視されることがあるので確認ダイアログは使わない
  // （戻る操作は常にキャンセル。やめるのは左上の × だけ）。
  window.addEventListener('popstate', (e) => {
    if (pendingLeave) {
      // leaveTo() が番兵の履歴を捨てるために呼んだ history.back()：ここから置換遷移する
      const name = pendingLeave;
      pendingLeave = null;
      clearTimeout(pendingLeaveTimer);
      navigate(name, {}, { replace: true });
      return;
    }
    if (!active) return;
    if (parseHash().name !== 'play') return;        // hash が変わった遷移はルーターに任せる
    if (e.state && e.state.introDonGuard) return;   // forward() で番兵の履歴に戻ってきただけ
    toast(GUARD_BACK_TEXT, { duration: 3000 });
    history.forward();
  });

  return { el: els.section, enter, leave };
}

/**
 * ゲームを離れる（× でやめる／最後の問題のあと結果へ）。
 * enter() で積んだ番兵の履歴を history.back() で捨ててから置換遷移するので、
 * 遷移先で「戻る」を押しても #/play に戻らず、プレイ前の画面（設定）に戻る。
 * 番兵が無い（pushState できなかった）環境ではそのまま置換遷移する。
 */
function leaveTo(name) {
  clearTimeout(pendingLeaveTimer);
  let hasGuard = false;
  try { hasGuard = !!(history.state && history.state.introDonGuard); } catch (e) { hasGuard = false; }
  if (!hasGuard) { pendingLeave = null; navigate(name, {}, { replace: true }); return; }
  pendingLeave = name;
  pendingLeaveTimer = setTimeout(() => {
    if (pendingLeave !== name) return;   // popstate が来なかった：保険として直接置換する
    pendingLeave = null;
    navigate(name, {}, { replace: true });
  }, LEAVE_FALLBACK_MS);
  try { history.back(); } catch (e) {
    pendingLeave = null;
    clearTimeout(pendingLeaveTimer);
    navigate(name, {}, { replace: true });
  }
}

function quitGame() {
  // session を消してから離れる：戻る操作で #/play に来ても enter() が false を返しホームへ置換される（ループしない）
  state.session = null;
  leaveTo('home');
}

// ---------- 画面の出入り ----------
async function enter() {
  const s = state.session;
  if (!s || !state.set) return false;
  if (s.phase === 'finished') return { redirect: 'result' };
  active = true;
  gameSeq += 1;
  guideShownThisGame = false;
  pendingLeave = null;
  clearTimeout(pendingLeaveTimer);
  document.body.dataset.activeScreen = 'play';
  const mode = s.settings.mode === 'buzzer' ? 'buzzer' : 'host';
  els.section.dataset.mode = mode;
  els.modeBadge.textContent = mode === 'buzzer' ? '早押し' : '司会';
  judgeWrongMode = false;
  els.judgeWrong.checked = false;
  els.judge.dataset.wrong = 'false';
  buildBuzzGrid();
  pushHistoryGuard();
  const wakeLockResult = acquireWakeLock();
  preparedQid = null;
  // 先に描いてから音源を準備する（準備中は「どん！」を無効化し、動画枠に「読み込み中…」を出す）
  render();
  prepareCurrent().then(() => { if (active) render(); });
  showFirstTimeHints(mode, wakeLockResult);
  return true;
}

function leave() {
  active = false;
  loading = false;
  pendingLeave = null;
  clearTimeout(pendingLeaveTimer);
  delete document.body.dataset.activeScreen;
  if (warmingUp) { setWarmingUp(false); if (player) player.cancelWarmUp(); }
  stopRing();
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  releaseWakeLock();
}

function pushHistoryGuard() {
  try {
    if (history.state && history.state.introDonGuard) return;
    history.pushState({ introDonGuard: true }, '', location.href);
  } catch (e) { /* 履歴操作が許されない環境では確認なしで戻れるだけ */ }
}

/**
 * 案内トースト（エラーではない「お知らせ」）。1 ゲームにつき 1 件だけ、かつ別の案内が表示中なら出さない。
 * @returns {boolean} 実際に表示したか
 */
function showGuide(message) {
  if (guideShownThisGame || Date.now() < guideUntil) return false;
  guideShownThisGame = true;
  guideUntil = Date.now() + GUIDE_TOAST_MS;
  toast(message, { duration: GUIDE_TOAST_MS });
  return true;
}

// 優先順：ホーム画面に追加 → 自動ロック → 音量。表示できなかった案内は次のゲームに持ち越す
async function showFirstTimeHints(mode, wakeLockResult) {
  const token = gameSeq;
  if (mode === 'buzzer' && navigator.standalone !== true) {
    let shown = false;
    try { shown = localStorage.getItem(STANDALONE_HINT_KEY) === '1'; } catch (e) { shown = false; }
    if (!shown && showGuide('ホーム画面に追加すると全画面で遊べます。')) {
      try { localStorage.setItem(STANDALONE_HINT_KEY, '1'); } catch (e) { /* 記憶できなくても続行 */ }
      return;
    }
  }
  let wakeOk = true;
  try { wakeOk = await wakeLockResult; } catch (e) { wakeOk = true; }
  if (!active || token !== gameSeq) return;
  if (mode === 'buzzer' && wakeOk === false && !wakeLockHintShown) {
    if (showGuide('自動ロックを「なし」にしておくと画面が消えません。')) { wakeLockHintShown = true; return; }
  }
  if (!soundHintShown && showGuide('音が出ないときはマナーモード・音量を確認してください。')) soundHintShown = true;
}

/**
 * 画面消灯を防ぐ。戻り値：取得できれば true、request が失敗したら false、非対応・取得済みなら null/true。
 * 失敗時の案内は showFirstTimeHints が（他の案内と調停して）出す。
 */
async function acquireWakeLock() {
  if (wakeLock || wakeLockPending) return true;
  if (!navigator.wakeLock) return null;
  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!active) { lock.release().catch(() => {}); return true; }
    wakeLock = lock;
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch (e) {
    wakeLock = null;
    return false;
  } finally {
    wakeLockPending = false;
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ---------- プレイヤー ----------
function getPlayer() {
  if (!player) {
    player = createPlayer({ youtubeMount: els.ytMount, onStateChange, getAudio: (blobId) => storage.getAudio(blobId) });
  }
  return player;
}

function unlockPlayer() {
  if (unlocked) return;
  unlocked = true;
  try { getPlayer().unlock(); } catch (e) { /* noop */ }
}

function currentQuestion() {
  const s = state.session;
  const id = game.currentQuestionId(s);
  return (state.set.questions || []).find((q) => q.id === id) || null;
}

function notifyError(message) {
  if (errorNotified) return;
  errorNotified = true;
  toastError(message);
}

/**
 * 現在の問題の音源を準備する。
 * @param {{ forceWarmUp?: boolean }} [opts] forceWarmUp: タッチ端末でなくても暖機（中央タップ）を提示する（watchdog 後の復帰用）
 */
async function prepareCurrent({ forceWarmUp = false } = {}) {
  const q = currentQuestion();
  if (!q || preparedQid === q.id) return;
  const token = ++prepareSeq;
  preparedQid = q.id;
  stopRing();
  if (warmingUp) setWarmingUp(false);
  errorNotified = false;
  sourceFailNotified = false;
  // YouTube 以外（端末音源・録音・音源なし）では動画枠は不要なので隠す（iframe を隠したまま再生はしない）
  els.ytBox.hidden = !(q.source && q.source.type === 'youtube');
  loading = !!q.source;
  setOverlay(false, q.source ? '読み込み中…' : '音源なし');
  if (active) render();
  try {
    await getPlayer().prepare(q.source || null);
  } catch (e) {
    console.warn(e);
    // player 側が 'error' を通知していればそちらのトーストだけにする
    if (token === prepareSeq && active) notifyError('音源を準備できませんでした。');
  }
  // 途中で別の準備が始まった／画面を離れた：loading はその準備（または leave()）が管理するので触らない
  if (token !== prepareSeq || !active) return;
  loading = false;
  if (getPlayer().state !== 'error' && getPlayer().state !== 'loading') setOverlay(false, q.source ? '「どん！」で再生' : '音源なし');
  maybeWarmUp(q, forceWarmUp);
  render();
}

// iOS/Android の YouTube：初回だけ iframe を直接タップしてもらう（ミュートで再生→即停止→頭出し）
// force=true なら（watchdog で再生が始まらなかった後の復帰）タッチ端末でなくても提示する
function maybeWarmUp(q, force = false) {
  const p = getPlayer();
  if (!q || !q.source || q.source.type !== 'youtube') return;
  if ((!force && !isTouchDevice()) || p.state !== 'ready' || !p.needsWarmUp) return;
  setWarmingUp(true);
  p.armWarmUp({ start: q.source.start || 0 }).then((ok) => {
    if (!warmingUp) return;
    setWarmingUp(false);
    if (ok) setOverlay(false, '準備OK！「どん！」で再生');
    render();
  });
}

function setWarmingUp(on) {
  warmingUp = on;
  els.ytOverlay.dataset.warmup = String(on);
  els.warmupSkip.hidden = !on;
  if (on) setOverlay(false, WARMUP_TEXT);
}

function onWarmupSkip() {
  if (!warmingUp) return;
  setWarmingUp(false);
  getPlayer().skipWarmUp();
  setOverlay(false, '「どん！」で再生');
  render();
}

// プレイヤーからの状態通知（100ms 程度の間隔で remainingMs が来る想定）
function onStateChange(st, info = {}) {
  if (!active) return;
  if (st === 'warming') return;
  if (st === 'playing') {
    els.don.dataset.playing = 'true';
    els.buzzDon.dataset.playing = 'true';
    if (info.buffering === true) {
      // バッファ待ち：実再生の進捗通知が来るまでリングは回さない
      setOverlay(true, '読み込み中…');
      return;
    }
    const total = ring.total || 1;
    const remaining = typeof info.remainingMs === 'number' ? info.remainingMs : Math.max(0, ring.remaining - (performance.now() - ring.at));
    ring.remaining = remaining;
    ring.at = performance.now();
    ring.total = total;
    if (!ring.running) startRing();
    setOverlay(true, '再生中…');
  } else {
    if (ring.running) stopRing();
    els.don.dataset.playing = 'false';
    els.buzzDon.dataset.playing = 'false';
    if (st === 'error') {
      setOverlay(false, '再生できません');
      const detail = info.error && info.error.message ? info.error.message : '';
      if (detail === PLAY_START_TIMEOUT_MESSAGE) {
        // watchdog：文言は player のものだけ（「再生できませんでした。」を重ねない）。復帰は onDon 側で再 cue + 暖機
        notifyError(detail);
      } else {
        notifyError('再生できませんでした。' + (detail || (navigator.onLine === false ? '圏外のため YouTube は再生できません。' : '')));
      }
    } else if (st === 'loading') {
      setOverlay(true, '読み込み中…');
    } else if (!warmingUp) {
      const q = currentQuestion();
      setOverlay(false, q && q.source ? '「どん！」で再生' : '音源なし');
    }
  }
}

function setOverlay(playing, text) {
  els.ytOverlay.dataset.playing = String(!!playing);
  els.ytOverlayText.textContent = text;
}

// 円周プログレス（remainingMs を補間しながら描く）
function startRing() {
  ring.running = true;
  const tick = () => {
    if (!ring.running) return;
    const rem = Math.max(0, ring.remaining - (performance.now() - ring.at));
    const ratio = ring.total > 0 ? rem / ring.total : 0;
    const offset = RING * (1 - ratio);
    els.donRing.style.strokeDashoffset = String(offset);
    els.buzzRing.style.strokeDashoffset = String(offset);
    if (rem <= 0) { stopRing(); return; }
    ring.raf = requestAnimationFrame(tick);
  };
  ring.raf = requestAnimationFrame(tick);
}

function stopRing() {
  ring.running = false;
  cancelAnimationFrame(ring.raf);
  els.donRing.style.strokeDashoffset = String(RING);
  els.buzzRing.style.strokeDashoffset = String(RING);
}

// ---------- 操作 ----------
function onDon() {
  unlockAudio();
  unlockPlayer();
  const s = state.session;
  if (!s || !['ready', 'playing'].includes(s.phase)) return;
  if (warmingUp || loading) return;
  const next = game.startPlay(s);
  if (next === s) return;
  state.session = next;
  const q = currentQuestion();
  const win = game.playbackWindow(next);
  const pl = q && q.source ? getPlayer() : null;
  if (pl && (pl.state === 'error' || pl.state === 'none' || pl.state === 'idle')) {
    // 音源が準備できていない（読み込み失敗など）：再生せず回数だけ数える（別アプリで流す運用）
    if (!sourceFailNotified) {
      sourceFailNotified = true;
      toast('音源を再生できないため、別アプリで流して「どん！」で回数を数えてください。', { duration: 4500 });
    }
  } else if (q && q.source) {
    errorNotified = false;
    ring.total = Math.max(1, win.seconds * 1000);
    ring.remaining = ring.total;
    ring.at = performance.now();
    const start = (q.source.start || 0) + (win.start || 0);
    // 再生が始まらなかった（watchdog／エラー）ときは押す前の状態に戻す。
    // 利用者が先に「ストップ」等で状態を進めていれば（state.session !== next）何もしない。
    const revert = () => {
      if (state.session !== next || !active) return;
      state.session = s;
      stopRing();
      els.don.dataset.playing = 'false';
      els.buzzDon.dataset.playing = 'false';
      render();
    };
    // play() の結果：true=再生中、null=自分で止めた（ストップ・早押し・答え・やめる）→ 何もしない、
    // false=始まらなかった → player が 'error' のときだけ戻す（watchdog なら再 cue して暖機へ）
    const onStarted = (started) => {
      if (started !== false) return;
      const pl2 = getPlayer();
      if (pl2.state !== 'error') return;
      revert();
      const err = pl2.lastError;
      if (err && err.message === PLAY_START_TIMEOUT_MESSAGE) recoverFromStartTimeout(q);
      else notifyError('再生できませんでした。');
    };
    try {
      // iOS 対策：タップハンドラ内から同期的に呼ぶ
      const p = getPlayer().play({ start, seconds: win.seconds });
      if (p && typeof p.then === 'function') {
        p.then(onStarted)
          .catch((e) => { console.warn(e); onStateChange('error', { error: e }); revert(); });
      }
    } catch (e) {
      console.warn(e);
      onStateChange('error', { error: e });
      revert();
      return;
    }
  }
  render();
}

/**
 * watchdog（再生開始が来なかった）後の復帰：同じ問題を cue し直し、暖機（動画枠の中央を 1 回タップ）を提示する。
 * 暖機をスキップ済みで adapter が「暖機済み」と思っている場合は player.resetWarmUp() で作り直してから cue する。
 * prepare 自体の失敗（圏外など）は従来どおり 'error' のまま「回数だけ数える」運用になる。
 */
async function recoverFromStartTimeout(q) {
  if (!active) return;
  const cur = currentQuestion();
  if (!cur || !q || cur.id !== q.id) return;
  try { getPlayer().resetWarmUp(); } catch (e) { console.warn(e); }
  preparedQid = null;
  await prepareCurrent({ forceWarmUp: true });
}

function onStop() {
  const s = state.session;
  if (!s) return;
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  stopRing();
  state.session = game.stopPlay(s);
  render();
}

function onHint() {
  const s = state.session;
  const q = currentQuestion();
  if (!s || !q) return;
  const max = (q.hints || []).length;
  if (s.hintCount >= max) return;
  state.session = game.openHint(s, max);
  render();
}

function onReveal() {
  const s = state.session;
  if (!s || s.phase === 'revealed') return;
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  stopRing();
  state.session = game.reveal(s);
  render();
}

function onJudgeCancel() {
  const s = state.session;
  if (!s || s.phase !== 'judging') return;
  state.session = game.cancelJudging(s);
  render();
}

function onJudge(correct, playerId) {
  const s = state.session;
  if (!s || !playerId) return;
  const next = game.judge(s, { correct, playerId });
  if (next === s) return;
  state.session = next;
  if (correct) correctSound(); else wrongSound();
  if (!correct && s.settings.mode === 'host') {
    judgeWrongMode = false;
    els.judgeWrong.checked = false;
    els.judge.dataset.wrong = 'false';
  }
  render();
}

function onBuzzPointer(e) {
  const panel = e.target.closest('.buzz-panel');
  if (!panel) return;
  e.preventDefault();
  buzzFromPanel(panel);
}

// キーボード操作（Space / Enter）でも早押しできるように
function onBuzzKey(e) {
  if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
  const panel = e.target.closest('.buzz-panel');
  if (!panel) return;
  e.preventDefault();
  buzzFromPanel(panel);
}

function buzzFromPanel(panel) {
  const s = state.session;
  if (!s || s.settings.mode !== 'buzzer') return;
  if (!(s.phase === 'playing' || (s.phase === 'ready' && s.playCount > 0))) return;
  const playerId = panel.dataset.playerId;
  if (s.lockedOut.includes(playerId)) return;
  const next = game.buzz(s, playerId);
  if (next === s) return;
  state.session = next;
  if (player) { try { player.stop(); } catch (err) { /* noop */ } }
  stopRing();
  buzzSound(state.players.findIndex((p) => p.id === playerId));
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (err) { /* noop */ } }
  render();
}

async function onNext() {
  const s = state.session;
  if (!s || s.phase !== 'revealed') return;
  const next = game.nextQuestion(s);
  state.session = next;
  // 結果へは番兵の履歴を捨ててから置換遷移（結果画面の「戻る」が 1 回で設定画面に戻る）
  if (next.phase === 'finished') { leaveTo('result'); return; }
  els.ytBox.dataset.revealed = 'false';
  render();
  await prepareCurrent();
  render();
}

// ---------- 描画 ----------
function playerById(id) {
  return state.players.find((p) => p.id === id) || null;
}

function render() {
  const s = state.session;
  if (!s || !active) return;
  const q = currentQuestion();
  const mode = s.settings.mode === 'buzzer' ? 'buzzer' : 'host';
  const phase = s.phase;
  els.section.dataset.phase = phase;
  els.counter.textContent = `${Math.min(s.index + 1, s.order.length)} / ${s.order.length}`;

  // 表示するパネル
  const revealed = phase === 'revealed';
  els.hostStage.hidden = !(mode === 'host' && (phase === 'ready' || phase === 'playing'));
  els.judge.hidden = !(mode === 'host' && phase === 'judging');
  els.buzzStage.hidden = !(mode === 'buzzer' && !revealed);
  els.revealPanel.hidden = !revealed;
  els.ytBox.dataset.revealed = String(revealed);
  els.ytBox.hidden = !(q && q.source && q.source.type === 'youtube');
  if (revealed) setOverlay(false, '正解');

  renderScores(s);

  const nextWin = game.playbackWindow({ ...s, playCount: s.playCount + 1 });
  const nextPts = game.pointsForPlay(s.settings, s.playCount + 1);
  const hasSource = !!(q && q.source);
  const links = searchLinks(q);
  const canDon = !loading && !warmingUp && (phase === 'ready' || phase === 'playing');

  if (mode === 'host') {
    els.donWrap.hidden = !hasSource;
    els.noSource.hidden = hasSource;
    if (!hasSource) {
      els.nsYt.href = links.youtube;
      els.nsAm.href = links.apple;
      ensureNoSourceCounter(els.noSource);
    }
    els.donSub.textContent = loading ? '読み込み中…' : `${s.playCount + 1}回目・${nextWin.seconds}秒`;
    els.don.disabled = !canDon;
    els.countLabel.textContent = `再生 ${s.playCount} 回`;
    els.pointsLabel.textContent = s.playCount > 0 ? `いま正解で ${game.pointsForPlay(s.settings, s.playCount)} 点` : `正解で ${nextPts} 点`;
    renderHints(els.hints, q, s.hintCount);
    els.hint.disabled = !q || !(q.hints || []).length || s.hintCount >= (q.hints || []).length;
    els.hint.textContent = q && (q.hints || []).length ? `ヒント ${s.hintCount}/${q.hints.length}` : 'ヒント';
    els.stop.disabled = !(phase === 'playing' || (phase === 'ready' && s.playCount > 0));
    if (phase === 'judging') renderJudge(s);
  } else {
    const allLocked = phase !== 'revealed' && game.allLockedOut(s);
    els.buzzDonSub.textContent = loading ? '読み込み中…' : `${s.playCount + 1}回目・${nextWin.seconds}秒`;
    els.buzzDon.disabled = !canDon || allLocked;
    els.buzzDon.hidden = !hasSource;
    els.buzzNoSource.hidden = hasSource;
    if (!hasSource) {
      els.bzYt.href = links.youtube;
      els.bzAm.href = links.apple;
      ensureNoSourceCounter(els.buzzNoSource, true);
      $('.ns-count', els.buzzNoSource).disabled = allLocked;
    }
    const buzzer = phase === 'buzzed' ? playerById(s.buzzedBy) : null;
    els.buzzJudge.hidden = !buzzer;
    let status;
    let statusKind = '';
    if (buzzer) status = `${buzzer.name} が解答！`;
    else if (allLocked) { status = '全員お手つき！答えを見る'; statusKind = 'locked'; }
    else if (warmingUp) { status = WARMUP_HUB_TEXT; statusKind = 'warmup'; }
    else if (loading) status = '読み込み中…';
    else if (phase === 'playing') status = '早押し受付中';
    else if (s.playCount > 0) status = `再生 ${s.playCount} 回・正解で ${game.pointsForPlay(s.settings, s.playCount)} 点`;
    else status = `正解で ${nextPts} 点`;
    els.buzzStatus.textContent = status;
    els.buzzStatus.dataset.kind = statusKind;
    renderHints(els.buzzHints, q, s.hintCount);
    els.buzzHint.disabled = !q || !(q.hints || []).length || s.hintCount >= (q.hints || []).length;
    renderBuzzPanels(s);
  }

  if (revealed) renderReveal(s, q);
}

// 音源なし問題用：「再生した（回数+1）」ボタンを動的に追加（採点のため）
function ensureNoSourceCounter(panel, small = false) {
  if ($('.ns-count', panel)) {
    $('.ns-count', panel).textContent = `再生した（${state.session.playCount + 1}回目）`;
    return;
  }
  const btn = el('button', { class: `btn btn-primary ns-count${small ? ' btn-sm' : ''}`, type: 'button', text: `再生した（${state.session.playCount + 1}回目）` });
  btn.addEventListener('click', onDon);
  panel.append(btn);
}

function renderScores(s) {
  clear(els.scores);
  for (const p of state.players) {
    const chip = el('span', { class: 'score-chip', style: `--chip:${p.color}`, dataset: { locked: String(s.lockedOut.includes(p.id)) } }, [
      el('span', { text: p.name }),
      el('b', { text: String(s.scores[p.id] ?? 0) }),
    ]);
    els.scores.append(chip);
  }
}

function renderHints(list, q, count) {
  clear(list);
  const hints = (q && q.hints) || [];
  for (let i = 0; i < Math.min(count, hints.length); i++) {
    list.append(el('li', { text: `ヒント${i + 1}：${hints[i]}` }));
  }
}

function renderJudge(s) {
  clear(els.judgePlayers);
  for (const p of state.players) {
    const locked = s.lockedOut.includes(p.id);
    const b = el('button', { class: 'judge-btn', type: 'button', style: `--chip:${p.color}` }, [
      el('span', { text: p.name }),
      el('small', { text: locked ? '誤答済み' : `${s.scores[p.id] ?? 0}点` }),
    ]);
    b.disabled = locked;
    b.addEventListener('click', () => onJudge(!judgeWrongMode, p.id));
    els.judgePlayers.append(b);
  }
}

function buildBuzzGrid() {
  clear(els.buzzGrid);
  const n = state.players.length;
  els.buzzGrid.dataset.count = String(Math.min(4, Math.max(2, n)));
  state.players.forEach((p, i) => {
    const panel = fromTemplate('tpl-buzz-panel');
    panel.dataset.playerId = p.id;
    panel.style.setProperty('--chip', p.color);
    // 上段（対面の人）は 180° 回転：2人=1枚目、3人=1枚目、4人=1・2枚目
    panel.dataset.flip = String(n === 4 ? i < 2 : i === 0);
    panel.setAttribute('aria-label', `${p.name} の早押しボタン`);
    $('.buzz-name', panel).textContent = p.name;
    els.buzzGrid.append(panel);
  });
}

function renderBuzzPanels(s) {
  const armed = s.phase === 'playing' || (s.phase === 'ready' && s.playCount > 0);
  $$('.buzz-panel', els.buzzGrid).forEach((panel) => {
    const id = panel.dataset.playerId;
    const locked = s.lockedOut.includes(id);
    panel.dataset.locked = String(locked);
    panel.dataset.active = String(s.phase === 'buzzed' && s.buzzedBy === id);
    panel.dataset.armed = String(armed && !locked);
    panel.setAttribute('aria-disabled', String(locked || !armed));
    $('.buzz-score', panel).textContent = `${s.scores[id] ?? 0}`;
    $('.buzz-state', panel).textContent = locked ? '× お手つき' : (s.phase === 'buzzed' && s.buzzedBy === id ? '解答権！' : (armed ? 'タップ！' : ''));
  });
}

function renderReveal(s, q) {
  if (!q) return;
  els.revealAnswer.textContent = q.answer;
  els.revealSubtitle.textContent = q.subtitle || '';
  const entry = [...s.log].reverse().find((l) => l.questionId === q.id);
  if (entry && entry.winnerId) {
    const p = playerById(entry.winnerId);
    els.revealWinner.textContent = `🏆 ${p ? p.name : entry.winnerId}  +${entry.points}点`;
  } else {
    els.revealWinner.textContent = '正解者なし';
  }
  if (q.source && q.source.type === 'youtube') {
    els.revealThumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(q.source.videoId)}/hqdefault.jpg`;
    els.revealThumb.hidden = false;
  } else {
    els.revealThumb.removeAttribute('src');
    els.revealThumb.hidden = true;
  }
  els.revealTrivia.textContent = q.trivia || '';
  els.revealTrivia.hidden = !q.trivia;
  els.revealAliases.textContent = q.aliases && q.aliases.length ? `別解：${q.aliases.join('、')}` : '';
  const last = s.index >= s.order.length - 1;
  els.next.textContent = last ? '結果を見る' : '次の問題';
}
