// 5. 結果：順位表、共有（Web Share → クリップボード）、もう一回、ホームへ
//    きがるモードは順位表の代わりに「全N問 聴きました」と聴いた曲のリストを出す。
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
    title: $('#result-title'),
    setName: $('#result-set'),
    ranking: $('#ranking'),
    listenedTitle: $('#listened-title'),
    listened: $('#listened'),
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
  const casual = s.settings && s.settings.mode === 'casual';
  els.section.dataset.mode = casual ? 'casual' : 'score';
  els.title.textContent = casual ? 'おしまい' : '結果発表';
  els.setName.textContent = `${set.emoji || '🎵'} ${set.title}・${s.log.length}問`;
  const rows = game.ranking(s);
  els.ranking.hidden = casual;
  els.listenedTitle.hidden = !casual;
  els.listened.hidden = !casual;
  clear(els.ranking);
  clear(els.listened);
  if (casual) {
    renderListened(s, set);
  } else {
    const colorById = Object.fromEntries(state.players.map((p) => [p.id, p.color]));
    for (const r of rows) {
      const li = fromTemplate('tpl-rank-row');
      li.dataset.rank = String(r.rank);
      $('.rank-no', li).textContent = r.rank === 1 ? '🏆' : `${r.rank}位`;
      $('.rank-swatch', li).style.background = colorById[r.playerId] || '#fff';
      $('.rank-name', li).textContent = r.name;
      $('.rank-score', li).textContent = `${r.score}点`;
      els.ranking.append(li);
    }
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

// きがるモード：聴いた曲（answer と subtitle）を log の順に並べる
function renderListened(s, set) {
  els.listenedTitle.textContent = `🎧 全${s.order.length}問 聴きました`;
  const questions = set.questions || [];
  s.log.forEach((entry, i) => {
    const q = questions.find((x) => x.id === entry.questionId);
    const li = fromTemplate('tpl-listened-row');
    $('.listened-no', li).textContent = `${i + 1}.`;
    $('.listened-answer', li).textContent = q ? q.answer : String(entry.questionId);
    const sub = $('.listened-sub', li);
    sub.textContent = q && q.subtitle ? q.subtitle : '';
    sub.hidden = !(q && q.subtitle);
    els.listened.append(li);
  });
}

async function share() {
  if (!summary) return;
  const s = state.session;
  const title = s && s.settings && s.settings.mode === 'casual' ? 'イントロどん' : 'イントロどん 結果';
  if (navigator.share) {
    try { await navigator.share({ title, text: summary }); return; }
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
    // 結果の履歴をプレイで置き換える（新しいゲームから「戻る」で古い結果に戻っても意味がないため）
    navigate('play', {}, { replace: true });
  } catch (e) {
    console.error(e);
    toast('もう一回を開始できませんでした。');
    navigate('setup', { id: last.set.id });
  }
}
