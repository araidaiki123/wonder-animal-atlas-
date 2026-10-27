// 4. プレイ：どん！ボタン・プログレス・ヒント・ストップ・正解者・早押し分割パネル・正解表示
import * as game from '../game.mjs';
import { createPlayer } from '../audio/player.mjs';
import { $, $$, el, clear, fromTemplate } from './dom.mjs';
import { toastError } from './toast.mjs';
import { state, searchLinks } from './state.mjs';
import { navigate } from './router.mjs';
import { unlockAudio, buzzSound, correctSound, wrongSound } from './sound.mjs';

const RING = 289.03; // 2π×46
let els;
let player = null;
let unlocked = false;
let wakeLock = null;
let active = false;
let preparedQid = null;
let ring = { total: 0, remaining: 0, at: 0, running: false, raf: 0 };
let judgeWrongMode = false;

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
  };

  els.quit.addEventListener('click', () => {
    if (window.confirm('ゲームをやめてホームに戻りますか？')) navigate('home');
  });
  // 「どん！」は pointerdown ではなく click（iOS の play() 制約のためユーザー操作内で同期的に呼ぶ）
  els.don.addEventListener('click', onDon);
  els.buzzDon.addEventListener('click', onDon);
  els.stop.addEventListener('click', onStop);
  els.hint.addEventListener('click', onHint);
  els.buzzHint.addEventListener('click', onHint);
  els.reveal.addEventListener('click', onReveal);
  els.buzzReveal.addEventListener('click', onReveal);
  els.judgeReveal.addEventListener('click', onReveal);
  els.judgeCancel.addEventListener('click', onJudgeCancel);
  els.judgeWrong.addEventListener('change', () => { judgeWrongMode = els.judgeWrong.checked; els.judge.dataset.wrong = String(judgeWrongMode); });
  els.buzzCorrect.addEventListener('click', () => onJudge(true, state.session.buzzedBy));
  els.buzzWrong.addEventListener('click', () => onJudge(false, state.session.buzzedBy));
  els.next.addEventListener('click', onNext);
  els.revealThumb.addEventListener('error', () => { els.revealThumb.hidden = true; });
  els.buzzGrid.addEventListener('pointerdown', onBuzzPointer);
  els.buzzGrid.addEventListener('contextmenu', (e) => e.preventDefault());
  // 初回タップでオーディオを解放
  els.section.addEventListener('pointerdown', () => { unlockAudio(); unlockPlayer(); }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) acquireWakeLock();
  });

  return { el: els.section, enter, leave };
}

// ---------- 画面の出入り ----------
async function enter() {
  const s = state.session;
  if (!s || !state.set) return false;
  if (s.phase === 'finished') return { redirect: 'result' };
  active = true;
  const mode = s.settings.mode === 'buzzer' ? 'buzzer' : 'host';
  els.section.dataset.mode = mode;
  els.modeBadge.textContent = mode === 'buzzer' ? '早押し' : '司会';
  judgeWrongMode = false;
  els.judgeWrong.checked = false;
  els.judge.dataset.wrong = 'false';
  buildBuzzGrid();
  acquireWakeLock();
  preparedQid = null;
  await prepareCurrent();
  render();
  return true;
}

function leave() {
  active = false;
  stopRing();
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  releaseWakeLock();
}

async function acquireWakeLock() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ---------- プレイヤー ----------
function getPlayer() {
  if (!player) {
    player = createPlayer({ youtubeMount: els.ytMount, onStateChange });
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

async function prepareCurrent() {
  const q = currentQuestion();
  if (!q || preparedQid === q.id) return;
  preparedQid = q.id;
  stopRing();
  setOverlay(false, q.source ? 'タップで再生' : '音源なし');
  try {
    await getPlayer().prepare(q.source || null);
  } catch (e) {
    console.warn(e);
    toastError('音源を準備できませんでした。');
  }
}

// プレイヤーからの状態通知（100ms 程度の間隔で remainingMs が来る想定）
function onStateChange(st, info = {}) {
  if (!active) return;
  if (st === 'playing') {
    const total = ring.total || 1;
    const remaining = typeof info.remainingMs === 'number' ? info.remainingMs : Math.max(0, ring.remaining - (performance.now() - ring.at));
    ring.remaining = remaining;
    ring.at = performance.now();
    ring.total = total;
    if (!ring.running) startRing();
    setOverlay(true, '再生中…');
    els.don.dataset.playing = 'true';
    els.buzzDon.dataset.playing = 'true';
  } else {
    if (ring.running) stopRing();
    els.don.dataset.playing = 'false';
    els.buzzDon.dataset.playing = 'false';
    if (st === 'error') {
      setOverlay(false, '再生できません');
      toastError('再生できませんでした。' + (info.error && info.error.message ? info.error.message : navigator.onLine === false ? '圏外のため YouTube は再生できません。' : ''));
    } else if (st === 'loading') {
      setOverlay(true, '読み込み中…');
    } else {
      const q = currentQuestion();
      setOverlay(false, q && q.source ? 'タップで再生' : '音源なし');
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

// ---------- 状態機械の補助（API に無い遷移の暫定対応） ----------
function withPhase(s, phase, extra = {}) {
  return { ...s, phase, ...extra };
}

// ---------- 操作 ----------
function onDon() {
  unlockAudio();
  unlockPlayer();
  const s = state.session;
  if (!s || !['ready', 'playing'].includes(s.phase)) return;
  let next = game.startPlay(s);
  if (next === s && s.phase === 'playing') {
    // 再生中（or 再生終了後）の再押し：状態機械が受け付けない場合は回数だけ進める（暫定）
    next = withPhase(s, 'playing', { playCount: s.playCount + 1 });
  }
  if (next === s) return;
  state.session = next;
  const q = currentQuestion();
  const win = game.playbackWindow(next);
  if (q && q.source) {
    ring.total = Math.max(1, win.seconds * 1000);
    ring.remaining = ring.total;
    ring.at = performance.now();
    const start = (q.source.start || 0) + (win.start || 0);
    try {
      // iOS 対策：タップハンドラ内から同期的に呼ぶ
      const p = getPlayer().play({ start, seconds: win.seconds });
      if (p && typeof p.catch === 'function') p.catch((e) => { console.warn(e); onStateChange('error', { error: e }); });
    } catch (e) {
      console.warn(e);
      onStateChange('error', { error: e });
    }
  }
  render();
}

function onStop() {
  const s = state.session;
  if (!s) return;
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  stopRing();
  let next = game.stopPlay(s);
  if (next === s && s.phase === 'ready' && s.playCount > 0 && s.settings.mode === 'host') {
    // 誤答のあと再生せずに別の人が答えた場合（暫定：直接 judging へ）
    next = withPhase(s, 'judging');
  }
  state.session = next;
  render();
}

function onHint() {
  const s = state.session;
  const q = currentQuestion();
  if (!s || !q) return;
  const max = (q.hints || []).length;
  if (s.hintCount >= max) return;
  const next = game.openHint(s);
  state.session = next === s ? { ...s, hintCount: Math.min(max, s.hintCount + 1) } : next;
  render();
}

function onReveal() {
  const s = state.session;
  if (!s || s.phase === 'revealed') return;
  if (player) { try { player.stop(); } catch (e) { /* noop */ } }
  stopRing();
  let next = game.reveal(s);
  if (next === s) next = withPhase(s, 'revealed');
  state.session = next;
  render();
}

function onJudgeCancel() {
  const s = state.session;
  if (!s || s.phase !== 'judging') return;
  // judging → ready に戻す遷移が API に無いため暫定
  state.session = withPhase(s, 'ready');
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
  if (next.phase === 'finished') { navigate('result'); return; }
  els.ytBox.dataset.revealed = 'false';
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
  if (revealed) setOverlay(false, '正解');

  renderScores(s);

  const win = game.playbackWindow(s);
  const nextWin = game.playbackWindow({ ...s, playCount: s.playCount + 1 });
  const nextPts = game.pointsForPlay(s.settings, s.playCount + 1);
  const hasSource = !!(q && q.source);
  const links = searchLinks(q);

  if (mode === 'host') {
    els.donWrap.hidden = !hasSource;
    els.noSource.hidden = hasSource;
    if (!hasSource) {
      els.nsYt.href = links.youtube;
      els.nsAm.href = links.apple;
      ensureNoSourceCounter(els.noSource);
    }
    els.donSub.textContent = `${s.playCount + 1}回目・${nextWin.seconds}秒`;
    els.don.disabled = !(phase === 'ready' || phase === 'playing');
    els.countLabel.textContent = `再生 ${s.playCount} 回`;
    els.pointsLabel.textContent = s.playCount > 0 ? `いま正解で ${game.pointsForPlay(s.settings, s.playCount)} 点` : `正解で ${nextPts} 点`;
    renderHints(els.hints, q, s.hintCount);
    els.hint.disabled = !q || !(q.hints || []).length || s.hintCount >= (q.hints || []).length;
    els.hint.textContent = q && (q.hints || []).length ? `ヒント ${s.hintCount}/${q.hints.length}` : 'ヒント';
    els.stop.disabled = !(phase === 'playing' || (phase === 'ready' && s.playCount > 0));
    if (phase === 'judging') renderJudge(s);
  } else {
    els.buzzDonSub.textContent = `${s.playCount + 1}回目・${nextWin.seconds}秒`;
    els.buzzDon.disabled = !(phase === 'ready' || phase === 'playing');
    els.buzzDon.hidden = !hasSource;
    els.buzzNoSource.hidden = hasSource;
    if (!hasSource) {
      els.bzYt.href = links.youtube;
      els.bzAm.href = links.apple;
      ensureNoSourceCounter(els.buzzNoSource, true);
    }
    const buzzer = phase === 'buzzed' ? playerById(s.buzzedBy) : null;
    els.buzzJudge.hidden = !buzzer;
    els.buzzStatus.textContent = buzzer ? `${buzzer.name} が解答！` : (phase === 'playing' ? '早押し受付中' : (s.playCount > 0 ? `再生 ${s.playCount} 回・正解で ${game.pointsForPlay(s.settings, s.playCount)} 点` : `正解で ${nextPts} 点`));
    renderHints(els.buzzHints, q, s.hintCount);
    els.buzzHint.disabled = !q || !(q.hints || []).length || s.hintCount >= (q.hints || []).length;
    renderBuzzPanels(s);
  }

  if (revealed) renderReveal(s, q);
  void win;
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
