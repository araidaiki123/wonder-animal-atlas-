// 5. 結果：順位表、共有（Web Share → クリップボード）、もう一回、ホームへ
import * as game from '../game.mjs';
import * as storage from '../storage.mjs';
import { $, clear, fromTemplate } from './dom.mjs';
import { toast, toastError, toastOk } from './toast.mjs';
import { state } from './state.mjs';
import { navigate } from './router.mjs';

let els;
let summary = '';

export function initResult() {
  els = {
    section: $('[data-screen="result"]'),
    setName: $('#result-set'),
    ranking: $('#ranking'),
    summary: $('#summary-text'),
    share: $('#btn-share'),
    again: $('#btn-again'),
    home: $('#btn-home'),
  };
  els.share.addEventListener('click', share);
  els.again.addEventListener('click', again);
  els.home.addEventListener('click', () => navigate('home'));
  return { el: els.section, enter, leave };
}

async function enter() {
  const s = state.session;
  const set = state.set;
  if (!s || !set) return false;
  els.setName.textContent = `${set.emoji || '🎵'} ${set.title}・${s.log.length}問`;
  const rows = game.ranking(s);
  const colorById = Object.fromEntries(state.players.map((p) => [p.id, p.color]));
  clear(els.ranking);
  for (const r of rows) {
    const li = fromTemplate('tpl-rank-row');
    li.dataset.rank = String(r.rank);
    $('.rank-no', li).textContent = r.rank === 1 ? '🏆' : `${r.rank}位`;
    $('.rank-swatch', li).style.background = colorById[r.playerId] || '#fff';
    $('.rank-name', li).textContent = r.name;
    $('.rank-score', li).textContent = `${r.score}点`;
    els.ranking.append(li);
  }
  try { summary = game.summaryText(s, set); } catch (e) { summary = ''; }
  els.summary.textContent = summary;
  els.summary.hidden = !summary;
  if (!state.resultSaved) {
    state.resultSaved = true;
    try {
      await storage.saveResult({
        setId: set.id, title: set.title, mode: s.settings && s.settings.mode,
        startedAt: s.startedAt, finishedAt: s.finishedAt || Date.now(),
        players: state.players, scores: s.scores, ranking: rows, questions: s.log.length, summary,
      });
    } catch (e) { console.warn('結果を保存できませんでした', e); }
  }
  return true;
}

function leave() {}

async function share() {
  if (!summary) return;
  if (navigator.share) {
    try { await navigator.share({ title: 'イントロどん 結果', text: summary }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(summary);
    toastOk('結果をコピーしました');
  } catch (e) {
    toastError('共有できませんでした。結果のテキストを長押しでコピーしてください。');
  }
}

function again() {
  const last = state.lastSetup;
  if (!last) { navigate('home'); return; }
  try {
    state.session = game.createSession({ set: last.set, players: last.players, settings: last.settings });
    state.set = last.set;
    state.players = last.players;
    state.resultSaved = false;
    navigate('play');
  } catch (e) {
    console.error(e);
    toast('もう一回を開始できませんでした。');
    navigate('setup', { id: last.set.id });
  }
}
