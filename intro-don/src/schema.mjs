// schema.mjs — お題セット（問題リスト）のスキーマ検証・正規化・import/export
// ARCHITECTURE.md 第3章の公開API。DOM/IndexedDB には一切触れない純粋関数のみ。
// validateSet は壊れた入力でも絶対に throw せず { ok:false, errors } を返す。
// 文字列は trim し、title/answer の長さ超過は errors、説明系（description/trivia/
// subtitle/credits/searchQuery/aliases/hints/tags）は上限で切り詰める方針（下記 LIMITS 参照）。

export const SCHEMA_VERSION = 1;

// 文字数は「コードポイント数」で数える（絵文字や結合文字を含む日本語を想定）。
export const LIMITS = Object.freeze({
  // --- セット ---
  id: 40,             // ^[a-z0-9-]{1,40}$
  title: 40,          // 超過は error
  emoji: 2,           // 超過は切り詰め（書記素単位）
  description: 200,   // 超過は切り詰め
  credits: 200,       // 超過は切り詰め
  tags: 20,           // 件数。超過分は捨てる
  tag: 20,            // 1件の長さ。超過は切り詰め
  difficulty: [1, 3],
  playSeconds: [0.5, 30],
  extendSeconds: [0.5, 30],
  questions: 200,     // 件数。超過は error
  // --- 問題 ---
  questionId: 40,     // ^[a-zA-Z0-9_-]{1,40}$
  answer: 80,         // 超過は error
  aliases: 20,        // 件数。超過分は捨てる
  alias: 80,          // 超過は切り詰め
  subtitle: 120,      // 超過は切り詰め
  hints: 5,           // 件数。超過分は捨てる
  hint: 80,           // 超過は切り詰め
  trivia: 300,        // 超過は切り詰め
  searchQuery: 120,   // 超過は切り詰め
  // --- 音源 ---
  videoId: 11,
  start: [0, 36000],  // 範囲外はクランプ
  blobId: 64,
  sourceName: 120,    // 超過は切り詰め
});

export const DEFAULTS = Object.freeze({
  difficulty: 2,
  playSeconds: 1.5,
  extendSeconds: 2,
  title: '新しいセット',
});

const SET_ID_RE = /^[a-z0-9-]{1,40}$/;
const QUESTION_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BLOB_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SOURCE_TYPES = ['youtube', 'local'];

// ---------------------------------------------------------------------------
// 小さなユーティリティ
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 文字列化して trim。数値/真偽値は文字列にする（手書き JSON への寛容さ）。それ以外は ''。
function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return '';
}

// コードポイント数（巨大文字列でも配列化せずに数える）
function charLen(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

// コードポイント単位で切り詰め
function truncate(s, max) {
  if (s.length <= max) return s; // UTF-16 長 <= max ならコードポイント数も max 以下
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out.trim();
}

// 絵文字は書記素単位で数える（Intl.Segmenter があれば使う）
function graphemes(s) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
  }
  return Array.from(s);
}

function clampNumber(v, [min, max], def) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// 文字列配列を正規化：trim・空要素除去・各要素の切り詰め・件数の切り詰め・重複除去
function strList(v, maxCount, maxLen) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out = [];
  for (const item of arr) {
    if (out.length >= maxCount) break;
    const s = truncate(str(item), maxLen);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function randomChars(n) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(n);
    c.getRandomValues(bytes);
    for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  } else {
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function newUserSetId() {
  return 'user-' + randomChars(10);
}

export function newQuestionId() {
  return 'q_' + randomChars(8);
}

// ---------------------------------------------------------------------------
// 正規化（lenient）と検証（errors 収集）を 1 パスで行う内部関数
// ---------------------------------------------------------------------------

function normalizeSource(raw, where, errors) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isPlainObject(raw)) {
    errors.push(`${where}.source はオブジェクトか null である必要があります`);
    return null;
  }
  const type = str(raw.type);
  if (!SOURCE_TYPES.includes(type)) {
    errors.push(`${where}.source.type が不明です: ${JSON.stringify(type)}`);
    return null;
  }
  const start = clampNumber(raw.start, LIMITS.start, 0);
  if (type === 'youtube') {
    const videoId = str(raw.videoId);
    if (!VIDEO_ID_RE.test(videoId)) {
      errors.push(`${where}.source.videoId が不正です（11文字の YouTube ID）`);
      return null;
    }
    return { type: 'youtube', videoId, start };
  }
  // local（録音も local と同じ経路）
  const blobId = str(raw.blobId);
  if (!BLOB_ID_RE.test(blobId)) {
    errors.push(`${where}.source.blobId が不正です`);
    return null;
  }
  const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration >= 0
    ? raw.duration
    : null;
  return {
    type: 'local',
    blobId,
    start,
    name: truncate(str(raw.name), LIMITS.sourceName),
    duration,
  };
}

function normalizeQuestion(raw, where, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${where} はオブジェクトである必要があります`);
    raw = {};
  }
  const id = str(raw.id);
  if (!QUESTION_ID_RE.test(id)) {
    errors.push(`${where}.id が不正です（英数字・_・- で1〜${LIMITS.questionId}文字）: ${JSON.stringify(id)}`);
  }
  const answer = str(raw.answer);
  if (!answer) {
    errors.push(`${where}.answer は必須です`);
  } else if (charLen(answer) > LIMITS.answer) {
    errors.push(`${where}.answer は${LIMITS.answer}文字以内にしてください`);
  }
  const searchQuery = truncate(str(raw.searchQuery), LIMITS.searchQuery);
  return {
    id,
    answer,
    aliases: strList(raw.aliases, LIMITS.aliases, LIMITS.alias),
    subtitle: truncate(str(raw.subtitle), LIMITS.subtitle),
    hints: strList(raw.hints, LIMITS.hints, LIMITS.hint),
    trivia: truncate(str(raw.trivia), LIMITS.trivia),
    // searchQuery 省略時は answer を使う（仕様 3 章）
    searchQuery: searchQuery || answer,
    source: normalizeSource(raw.source, where, errors),
  };
}

function analyze(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    errors.push('セットはオブジェクトである必要があります');
    obj = {};
  }

  if (obj.schemaVersion !== undefined && obj.schemaVersion !== null) {
    const v = Number(obj.schemaVersion);
    if (Number.isFinite(v) && v > SCHEMA_VERSION) {
      errors.push(`対応していない schemaVersion です: ${v}（このアプリは ${SCHEMA_VERSION} まで）`);
    }
  }

  const id = str(obj.id);
  if (!SET_ID_RE.test(id)) {
    errors.push(`id が不正です（英小文字・数字・- で1〜${LIMITS.id}文字）: ${JSON.stringify(truncate(id, 50))}`);
  }

  const title = str(obj.title);
  if (!title) {
    errors.push('title は必須です');
  } else if (charLen(title) > LIMITS.title) {
    errors.push(`title は${LIMITS.title}文字以内にしてください`);
  }

  const emoji = graphemes(str(obj.emoji)).slice(0, LIMITS.emoji).join('');

  let questionsRaw = obj.questions;
  if (questionsRaw === undefined || questionsRaw === null) questionsRaw = [];
  if (!Array.isArray(questionsRaw)) {
    errors.push('questions は配列である必要があります');
    questionsRaw = [];
  }
  if (questionsRaw.length > LIMITS.questions) {
    errors.push(`questions は${LIMITS.questions}件以内にしてください（${questionsRaw.length}件）`);
    questionsRaw = questionsRaw.slice(0, LIMITS.questions);
  }
  const seen = new Set();
  const questions = questionsRaw.map((q, i) => {
    const where = `questions[${i}]`;
    const nq = normalizeQuestion(q, where, errors);
    if (nq.id) {
      if (seen.has(nq.id)) errors.push(`${where}.id が重複しています: ${nq.id}`);
      seen.add(nq.id);
    }
    return nq;
  });

  const set = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    emoji,
    description: truncate(str(obj.description), LIMITS.description),
    difficulty: Math.round(clampNumber(obj.difficulty, LIMITS.difficulty, DEFAULTS.difficulty)),
    tags: strList(obj.tags, LIMITS.tags, LIMITS.tag),
    playSeconds: clampNumber(obj.playSeconds, LIMITS.playSeconds, DEFAULTS.playSeconds),
    extendSeconds: clampNumber(obj.extendSeconds, LIMITS.extendSeconds, DEFAULTS.extendSeconds),
    builtin: obj.builtin === true,
    credits: truncate(str(obj.credits), LIMITS.credits),
    questions,
  };
  return { set, errors };
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/** 検証＋正規化。未知のプロパティは捨てる。絶対に throw しない。 */
export function validateSet(obj) {
  try {
    const { set, errors } = analyze(obj);
    return errors.length ? { ok: false, errors } : { ok: true, set };
  } catch (e) {
    return { ok: false, errors: [`予期しないエラー: ${e && e.message ? e.message : String(e)}`] };
  }
}

/** validate の ok 前提の正規化（エラーは無視して可能な限り正規化する） */
export function normalizeSet(obj) {
  return analyze(obj).set;
}

/** 新しいユーザーセット。id は "user-" + 乱数、builtin:false。 */
export function newUserSet(partial = {}) {
  const base = isPlainObject(partial) ? partial : {};
  const set = normalizeSet({
    ...base,
    id: newUserSetId(),
    builtin: false,
    title: str(base.title) || DEFAULTS.title,
  });
  return set;
}

/** 新しい問題。id は "q_" + 乱数。answer は空でもよい（編集中）。 */
export function newQuestion(partial = {}) {
  const base = isPlainObject(partial) ? partial : {};
  const id = QUESTION_ID_RE.test(str(base.id)) ? str(base.id) : newQuestionId();
  return normalizeQuestion({ ...base, id }, 'question', []);
}

/**
 * YouTube の URL/ID から 11 文字の videoId を取り出す。
 * watch?v= / youtu.be/ / shorts/ / embed/ / live/ / v/ / music.youtube.com / m.youtube.com、
 * 生の 11 文字 ID、共有テキストに埋め込まれた URL を受け付ける。それ以外は null。
 */
export function parseYouTubeId(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  if (VIDEO_ID_RE.test(t)) return t;

  // テキスト中の YouTube URL らしき部分をすべて拾う（共有テキスト「タイトル https://youtu.be/ID」対策）。
  // スキーム省略（youtu.be/ID）や括弧・句読点に囲まれたものも対象。
  for (const m of t.matchAll(YT_URL_RE)) {
    const id = idFromUrlToken(m[2]);
    if (id) return id;
  }
  return null;
}

const YT_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];
// 前後の区切り文字（空白・括弧・引用符・全角括弧）を含めない。
// 先頭の (^|[^a-z0-9.-]) は "notyoutube.com" のような別ドメインの一部にマッチしないための境界
// （後読み (?<!) は古い iOS Safari で使えないので使わない）
const YT_URL_RE = /(^|[^a-z0-9.-])((?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube(?:-nocookie)?\.com|youtu\.be)\/[^\s<>"'()\[\]{}（）「」『』]*)/gi;

function idFromUrlToken(token) {
  let cleaned = token.replace(/[.,;:!?。、]+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) cleaned = 'https://' + cleaned;
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isYt = YT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (!isYt) return null;

  const pick = (s) => {
    const m = /^([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(s || '');
    return m ? m[1] : null;
  };
  const segs = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
    return pick(segs[0]);
  }
  // /watch?v=ID（music / m / www すべて同じ）
  const v = url.searchParams.get('v');
  if (v) {
    const id = pick(v);
    if (id) return id;
  }
  // /shorts/ID, /embed/ID, /live/ID, /v/ID
  if (segs.length >= 2 && ['shorts', 'embed', 'live', 'v', 'e'].includes(segs[0])) {
    return pick(segs[1]);
  }
  // /attribution_link?u=/watch?v=ID のような入れ子
  const u = url.searchParams.get('u');
  if (u) {
    try {
      const inner = new URL(u, 'https://www.youtube.com/');
      const iv = inner.searchParams.get('v');
      if (iv) return pick(iv);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 整形 JSON に書き出す。builtin は false に落とし、builtin:true のセットは id を "user-<元id>" に付け替える
 * （書き出しは複製扱い。取り込んだ側で同梱セットと id が衝突しないようにする。決定的なので同じセットを
 * 何度書き出しても同じ id になり、取り込み側で上書き／重複の判断ができる）。
 * local 音源は Blob を持ち出せないので source:null に落とし、件数を _droppedLocalSources に付ける。
 */
export function exportSet(set) {
  const n = normalizeSet(set);
  if (n.builtin === true) n.id = `user-${n.id}`.slice(0, LIMITS.id);
  let dropped = 0;
  const questions = n.questions.map((q) => {
    if (q.source && q.source.type === 'local') {
      dropped++;
      return { ...q, source: null };
    }
    return q;
  });
  const out = { ...n, builtin: false, questions };
  if (dropped > 0) out._droppedLocalSources = dropped;
  return { json: JSON.stringify(out, null, 2), droppedLocalSources: dropped };
}

/**
 * JSON テキスト（またはパース済みオブジェクト）を取り込む。
 * - builtin:true のもの、id が builtinIds と衝突するもの、id が不正/欠落のものは "user-" の id を付け直す
 * - 常に builtin:false にする（取り込みは複製扱い）
 * - 問題 id が欠けていれば自動採番する（手書き JSON への寛容さ）
 * 絶対に throw しない。
 */
export function importSet(text, { builtinIds = [] } = {}) {
  let parsed;
  if (typeof text === 'string') {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, set: null, errors: [`JSON として読み込めませんでした: ${e.message}`] };
    }
  } else {
    parsed = text;
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, set: null, errors: ['セットはオブジェクトである必要があります'] };
  }
  const copy = { ...parsed, builtin: false };
  const id = str(copy.id);
  const builtinList = Array.isArray(builtinIds) ? builtinIds.map(String) : [];
  if (parsed.builtin === true || !SET_ID_RE.test(id) || builtinList.includes(id)) {
    copy.id = newUserSetId();
  }
  if (Array.isArray(copy.questions)) {
    const used = new Set(copy.questions.map((q) => (isPlainObject(q) ? str(q.id) : '')).filter(Boolean));
    copy.questions = copy.questions.map((q, i) => {
      if (!isPlainObject(q) || str(q.id)) return q;
      let candidate;
      let n = i + 1;
      do {
        candidate = 'q' + String(n).padStart(2, '0');
        n++;
      } while (used.has(candidate));
      used.add(candidate);
      return { ...q, id: candidate };
    });
  }
  const r = validateSet(copy);
  return r.ok ? { ok: true, set: r.set, errors: [] } : { ok: false, set: null, errors: r.errors };
}

/** 同梱セットを複製してユーザーセットにする（新しい id、builtin:false。問題もディープコピー） */
export function cloneSetForEditing(set) {
  const n = normalizeSet(set);
  return { ...n, id: newUserSetId(), builtin: false };
}
