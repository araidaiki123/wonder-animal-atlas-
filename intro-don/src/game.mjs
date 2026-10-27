// game.mjs — イントロどんのゲーム状態機械と採点（純粋関数・副作用なし）
// ARCHITECTURE.md 第4章の公開API。すべての遷移関数は新しい Session を返し、
// 入力の Session は変更しない。無効な遷移では同じ Session オブジェクトをそのまま返す（throw しない）。
// DOM や乱数などの外部状態は createSession の random / now 注入で差し替え可能（テスト用）。

export const PHASES = ['lobby', 'ready', 'playing', 'buzzed', 'judging', 'revealed', 'finished'];

// host: 司会モード、buzzer: 早押しモード、casual: きがるモード（得点なし。流して、答えを見て、次へ）
export const MODES = ['host', 'buzzer', 'casual'];

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'host',
  playSeconds: 1.5,
  extendSeconds: 2,
  points: Object.freeze([3, 2, 1]),
  wrongPenalty: 0,
  shuffle: true,
  questionLimit: null,
});

export const PLAYER_LIMITS = Object.freeze({ host: [1, 8], buzzer: [2, 4], casual: [1, 1] });

// きがるモードでプレイヤーが省略されたときに補う 1 人
export const CASUAL_PLAYER = Object.freeze({ id: 'solo', name: 'みんな', color: null });

const MODE_LABEL = { host: '司会', buzzer: '早押し', casual: 'きがる' };

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

function finiteOr(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function normalizeSettings(input, set) {
  const s = input && typeof input === 'object' ? input : {};
  const mode = MODES.includes(s.mode) ? s.mode : DEFAULT_SETTINGS.mode;
  const points = Array.isArray(s.points) && s.points.length
    ? s.points.map((p) => Math.max(0, finiteOr(p, 0)))
    : [...DEFAULT_SETTINGS.points];
  let questionLimit = null;
  if (typeof s.questionLimit === 'number' && Number.isFinite(s.questionLimit) && s.questionLimit >= 1) {
    questionLimit = Math.floor(s.questionLimit);
  }
  return {
    mode,
    playSeconds: finiteOr(s.playSeconds, finiteOr(set && set.playSeconds, DEFAULT_SETTINGS.playSeconds)),
    extendSeconds: finiteOr(s.extendSeconds, finiteOr(set && set.extendSeconds, DEFAULT_SETTINGS.extendSeconds)),
    points,
    wrongPenalty: finiteOr(s.wrongPenalty, 0),
    shuffle: s.shuffle !== false,
    questionLimit,
  };
}

// Fisher–Yates（random は [0,1) を返す関数。注入で決定的にテストできる）
export function shuffleArray(arr, random = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function hasPlayer(s, playerId) {
  return s.players.some((p) => p.id === playerId);
}

// 現在の問題のログ行を作って revealed に遷移する共通処理
function toRevealed(s, { winnerId, points }) {
  const entry = {
    questionId: currentQuestionId(s),
    winnerId: winnerId ?? null,
    points,
    playCount: s.playCount,
    hintCount: s.hintCount,
  };
  return { ...s, phase: 'revealed', log: [...s.log, entry] };
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * セッションを作る。
 * - players: [{ id, name, color }] 司会モード 1..8 人、早押しモード 2..4 人、きがるモード 1 人
 *   （きがるモードで players が空／省略なら CASUAL_PLAYER を 1 人補う）
 * - settings: 省略部分は set の値 → 既定値で補う
 * - random: シャッフル用乱数（テストで決定的に）、now: 開始時刻（ms）
 * 引数が不正なときは Error を throw する（遷移関数と違い、ここは呼び出し側のバグ）。
 */
export function createSession({ set, players, settings, random = Math.random, now = Date.now() } = {}) {
  if (!set || !Array.isArray(set.questions) || set.questions.length === 0) {
    throw new Error('問題が 1 件以上あるセットが必要です');
  }
  const resolved = normalizeSettings(settings, set);

  if (resolved.mode === 'casual' && (!Array.isArray(players) || players.length === 0)) {
    players = [{ ...CASUAL_PLAYER }];
  }
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('プレイヤーが必要です');
  }
  const [minP, maxP] = PLAYER_LIMITS[resolved.mode];
  if (players.length < minP || players.length > maxP) {
    throw new Error(`${MODE_LABEL[resolved.mode]}モードのプレイヤー数は ${minP}〜${maxP} 人です`);
  }
  const normPlayers = players.map((p, i) => {
    const src = p && typeof p === 'object' ? p : {};
    const id = src.id !== undefined && src.id !== null && String(src.id) !== '' ? String(src.id) : `p${i + 1}`;
    const name = typeof src.name === 'string' && src.name.trim() ? src.name.trim() : `プレイヤー${i + 1}`;
    return { id, name, color: src.color ?? null };
  });
  const ids = new Set(normPlayers.map((p) => p.id));
  if (ids.size !== normPlayers.length) {
    throw new Error('プレイヤー id が重複しています');
  }

  let order = set.questions.map((q) => q.id);
  if (resolved.shuffle) order = shuffleArray(order, random);
  if (resolved.questionLimit !== null) order = order.slice(0, resolved.questionLimit);

  const scores = {};
  for (const p of normPlayers) scores[p.id] = 0;

  return {
    setId: set.id,
    players: normPlayers,
    settings: resolved,
    order,
    index: 0,
    phase: 'ready',
    playCount: 0,
    hintCount: 0,
    buzzedBy: null,
    lockedOut: [],
    scores,
    log: [],
    startedAt: now,
    finishedAt: null,
  };
}

/**
 * ready|playing → playing、playCount+1。
 * playing からも受け付ける（音が止まったあと誰も分からず「もう一回どん！」するため）。
 * revealed からは呼ばない（UI が nextQuestion してから）。
 */
export function startPlay(s) {
  if (s.phase !== 'ready' && s.phase !== 'playing') return s;
  return { ...s, phase: 'playing', playCount: s.playCount + 1 };
}

/**
 * playing → 司会モードは judging、早押し・きがるモードは ready（早押しは誰も押さなければ押し直せる）。
 * 司会モードでは、誤答のあと再生せずに別の人が答えた場合（ready かつ playCount>0）も judging へ進める。
 */
export function stopPlay(s) {
  if (s.phase === 'playing') {
    return { ...s, phase: s.settings.mode === 'host' ? 'judging' : 'ready' };
  }
  if (s.phase === 'ready' && s.playCount > 0 && s.settings.mode === 'host') {
    return { ...s, phase: 'judging' };
  }
  return s;
}

/** 司会モードの judging → ready（正解者選択をやめて続きを再生する） */
export function cancelJudging(s) {
  if (s.phase !== 'judging') return s;
  return { ...s, phase: 'ready' };
}

/**
 * 早押し。playing、または再生停止後の ready（playCount>0）でのみ受け付ける。
 * lockedOut のプレイヤー・存在しないプレイヤー・司会／きがるモードでは無視。
 */
export function buzz(s, playerId) {
  if (s.settings.mode !== 'buzzer') return s;
  const canBuzz = s.phase === 'playing' || (s.phase === 'ready' && s.playCount > 0);
  if (!canBuzz) return s;
  if (!hasPlayer(s, playerId) || s.lockedOut.includes(playerId)) return s;
  return { ...s, phase: 'buzzed', buzzedBy: playerId };
}

/**
 * 判定。
 * - host: judging で playerId 必須。
 * - buzzer: buzzed で playerId は buzzedBy（引数は無視）。
 * - casual: 得点がないので常に無視（同じ Session を返す）。
 * 正解 → pointsForPlay の得点を加算して revealed。
 * 誤答 → lockedOut に追加、wrongPenalty（負値のみ、下限なし）を加算して ready。
 */
export function judge(s, { correct, playerId } = {}) {
  if (s.settings.mode === 'casual') return s;
  let target;
  if (s.settings.mode === 'buzzer') {
    if (s.phase !== 'buzzed' || !s.buzzedBy) return s;
    target = s.buzzedBy;
  } else {
    if (s.phase !== 'judging') return s;
    if (!hasPlayer(s, playerId)) return s;
    target = playerId;
  }
  if (s.lockedOut.includes(target)) return s;

  if (correct) {
    const pts = pointsForPlay(s.settings, s.playCount);
    const scores = { ...s.scores, [target]: (s.scores[target] ?? 0) + pts };
    return toRevealed({ ...s, scores }, { winnerId: target, points: pts });
  }
  const penalty = Math.min(0, finiteOr(s.settings.wrongPenalty, 0));
  const scores = penalty !== 0 ? { ...s.scores, [target]: (s.scores[target] ?? 0) + penalty } : s.scores;
  return {
    ...s,
    phase: 'ready',
    buzzedBy: null,
    lockedOut: [...s.lockedOut, target],
    scores,
  };
}

/** ヒントを開く（hintCount+1）。maxHints（question.hints.length、UI が渡す）に達していれば無視。得点には影響しない。 */
export function openHint(s, maxHints = Infinity) {
  if (!['ready', 'playing', 'buzzed', 'judging'].includes(s.phase)) return s;
  if (s.hintCount >= maxHints) return s;
  return { ...s, hintCount: s.hintCount + 1 };
}

/** 答えを見る（誰も正解なし、winner null で log）。ready/playing/buzzed/judging から revealed へ。 */
export function reveal(s) {
  if (!['ready', 'playing', 'buzzed', 'judging'].includes(s.phase)) return s;
  return toRevealed({ ...s, buzzedBy: null }, { winnerId: null, points: 0 });
}

/** revealed → 次の問題（ready）。最後の問題なら finished。 */
export function nextQuestion(s, now = Date.now()) {
  if (s.phase !== 'revealed') return s;
  const base = { ...s, playCount: 0, hintCount: 0, buzzedBy: null, lockedOut: [] };
  if (s.index + 1 >= s.order.length) {
    return { ...base, phase: 'finished', finishedAt: now };
  }
  return { ...base, index: s.index + 1, phase: 'ready' };
}

export function currentQuestionId(s) {
  return s.order[s.index] ?? null;
}

/** 早押しで全員が誤答済みなら true（UI が reveal を促すために使う） */
export function allLockedOut(s) {
  return s.players.length > 0 && s.players.every((p) => s.lockedOut.includes(p.id));
}

/** 再生回数 playCount に対応する得点 = points[min(playCount, len) - 1] */
export function pointsForPlay(settings, playCount) {
  const points = settings && Array.isArray(settings.points) && settings.points.length
    ? settings.points
    : DEFAULT_SETTINGS.points;
  const n = Math.max(1, Math.floor(finiteOr(playCount, 1)));
  return finiteOr(points[Math.min(n, points.length) - 1], 0);
}

/** 順位表。得点降順、同点は同順位（1,1,3 方式）。同点内はプレイヤー登録順。 */
export function ranking(s) {
  const rows = s.players.map((p, i) => ({ playerId: p.id, name: p.name, score: s.scores[p.id] ?? 0, i }));
  rows.sort((a, b) => b.score - a.score || a.i - b.i);
  let rank = 0;
  return rows.map((r, idx) => {
    if (idx === 0 || r.score !== rows[idx - 1].score) rank = idx + 1;
    return { playerId: r.playerId, name: r.name, score: r.score, rank };
  });
}

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 共有用テキスト。例：
 *   🎵 イントロどん 結果（コンビニ入店音）
 *   🥇 たろう 9点
 *   🥈 はなこ 6点
 *   🥈 じろう 6点
 *   全12問 / 2026-10-27
 * 同点は同じメダル、4位以降は「4. 名前 点」。
 *
 * きがるモード（得点なし）は順位の代わりに聴いた曲を log の順に並べる：
 *   🎵 イントロどん（コンビニ入店音）
 *   全12問 聴きました
 *   1. ファミリーマート
 *   2. セブン-イレブン
 *   …
 *   2026-10-27
 * answer は set から引く（set が無い／見つからない問題は questionId を出す）。
 */
export function summaryText(s, set) {
  const title = set && typeof set.title === 'string' && set.title.trim() ? `（${set.title.trim()}）` : '';
  if (s.settings && s.settings.mode === 'casual') {
    const questions = set && Array.isArray(set.questions) ? set.questions : [];
    const lines = [`🎵 イントロどん${title}`, `全${s.order.length}問 聴きました`];
    s.log.forEach((entry, i) => {
      const q = questions.find((x) => x && x.id === entry.questionId);
      const answer = q && typeof q.answer === 'string' && q.answer.trim() ? q.answer.trim() : String(entry.questionId);
      lines.push(`${i + 1}. ${answer}`);
    });
    lines.push(formatDate(s.finishedAt ?? s.startedAt ?? Date.now()));
    return lines.join('\n');
  }
  const lines = [`🎵 イントロどん 結果${title}`];
  for (const r of ranking(s)) {
    const prefix = MEDALS[r.rank] ?? `${r.rank}.`;
    lines.push(`${prefix} ${r.name} ${r.score}点`);
  }
  lines.push(`全${s.order.length}問 / ${formatDate(s.finishedAt ?? s.startedAt ?? Date.now())}`);
  return lines.join('\n');
}

/**
 * 今回の再生ウィンドウ。毎回「頭から」再生し、回数ごとに extendSeconds ずつ長く聞かせる。
 * seconds = playSeconds + extendSeconds * (playCount - 1)。playCount 0 のときは次の（1回目の）値。
 */
export function playbackWindow(s) {
  const n = Math.max(1, s.playCount);
  const { playSeconds, extendSeconds } = s.settings;
  return { start: 0, seconds: playSeconds + extendSeconds * (n - 1) };
}
