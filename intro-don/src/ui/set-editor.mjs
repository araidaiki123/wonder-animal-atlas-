// 2. セット詳細／編集 + 問題編集モーダル（音源：YouTube URL / 端末ファイル / 録音）
import * as schema from '../schema.mjs';
import * as storage from '../storage.mjs';
import { createRecorder } from '../audio/local.mjs';
import { $, $$, el, clear, fromTemplate, openDialog, closeDialog, bindDialogClose, num, clampNum, formatClock, debounce, probeDuration } from './dom.mjs';
import { toast, toastError, toastOk } from './toast.mjs';
import { state, findSet, upsertUserSet, removeUserSet, sourceKind, SOURCE_LABEL, sourceStats, difficultyStars, searchLinks } from './state.mjs';
import { navigate } from './router.mjs';

const MAX_RECORD_SEC = 60;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 端末ファイルの上限 50MB
const PREVIEW_MS = 3000;
const LAST_TAB_KEY = 'intro-don:lastSourceTab';

let els;
let set = null;        // 表示中のセット（自作なら編集対象そのもの）
let editable = false;
let draft = null;      // 問題編集モーダルの作業コピー
let editingId = null;  // 編集中の question.id（新規は null）
let originalBlobId = null;
let draftBlobIds = []; // モーダル中に新規作成した blobId（キャンセル時に掃除）
let previewUrls = [];  // モーダル中に作った ObjectURL（閉じるときに revoke）
let rec = null;        // 録音中のレコーダー
let recTimer = null;
let recLevelRaf = 0;
let recStartedAt = 0;
let recAudioCtx = null;
let recLevelValue = -1; // レコーダーからの実レベル（-1 = 未受信）
let previewAudio = null; // 試聴用 <audio playsinline>（1 要素を使い回す）
let previewTimer = null;
let exportFileName = 'set.json';

export function initSetEditor() {
  els = {
    section: $('[data-screen="set"]'),
    heading: $('#set-heading'),
    kind: $('#set-kind-badge'),
    readonly: $('#set-readonly'),
    viewEmoji: $('#set-view-emoji'),
    viewTitle: $('#set-view-title'),
    viewMeta: $('#set-view-meta'),
    viewDesc: $('#set-view-desc'),
    viewCredits: $('#set-view-credits'),
    clone: $('#btn-clone'),
    form: $('#set-form'),
    emoji: $('#set-emoji'),
    title: $('#set-title'),
    desc: $('#set-desc'),
    playSeconds: $('#set-play-seconds'),
    extendSeconds: $('#set-extend-seconds'),
    difficulty: $('#set-difficulty'),
    formStatus: $('#set-form-status'),
    playSet: $('#btn-play-set'),
    addQ: $('#btn-add-question'),
    exportBtn: $('#btn-export'),
    deleteSet: $('#btn-delete-set'),
    qList: $('#q-list'),
    qEmpty: $('#q-empty'),
    // 問題モーダル
    dlg: $('#dlg-question'),
    qForm: $('#q-form'),
    qTitle: $('#q-dialog-title'),
    qAnswer: $('#q-answer'),
    qAliases: $('#q-aliases'),
    qSubtitle: $('#q-subtitle'),
    qHints: $('#q-hints'),
    qTrivia: $('#q-trivia'),
    qSearch: $('#q-search'),
    qSourceStatus: $('#q-source-status'),
    preview: $('#btn-preview'),
    clearSource: $('#btn-clear-source'),
    tabs: $('#source-tabs'),
    ytUrl: $('#q-yt-url'),
    ytStart: $('#q-yt-start'),
    ytApply: $('#btn-yt-apply'),
    ytPaste: $('#btn-yt-paste'),
    ytError: $('#q-yt-error'),
    file: $('#q-file'),
    recBtn: $('#btn-rec'),
    recTime: $('#rec-time'),
    recLevel: $('#rec-level'),
    localStart: $('#q-local-start'),
    localStartRow: $('#q-local-start').closest('.field-row'),
    toolbar: $('.set-toolbar'),
    linkYt: $('#link-yt-search'),
    linkAm: $('#link-am-search'),
    qError: $('#q-error'),
    qDelete: $('#btn-q-delete'),
    // 書き出しモーダル
    dlgExport: $('#dlg-export'),
    exportNote: $('#export-note'),
    exportText: $('#export-text'),
    exportCopy: $('#btn-export-copy'),
    exportDownload: $('#btn-export-download'),
  };

  $('[data-nav="home"]', els.section).addEventListener('click', () => navigate('home'));
  els.clone.addEventListener('click', cloneSet);
  els.playSet.addEventListener('click', () => {
    if (!set.questions.length) { toastError('問題が1件以上必要です。'); return; }
    navigate('setup', { id: set.id });
  });
  els.addQ.addEventListener('click', () => openQuestionDialog(null));
  els.exportBtn.addEventListener('click', exportSet);
  els.deleteSet.addEventListener('click', deleteSet);

  // セット基本情報：入力のたびに反映して遅延保存
  const onSetInput = debounce(saveSet, 600);
  els.form.addEventListener('submit', (e) => e.preventDefault());
  els.form.addEventListener('input', () => { applySetForm(); onSetInput(); });
  els.form.addEventListener('change', () => { applySetForm(); onSetInput.flush(); });

  // 問題モーダル（入力途中の誤タップで消えないよう、背景タップでは閉じない）
  bindDialogClose(els.dlg, onDialogClosed, { backdrop: false });
  els.qForm.addEventListener('submit', (e) => { e.preventDefault(); saveQuestion(); });
  els.qDelete.addEventListener('click', deleteQuestion);
  $$('.tab', els.tabs).forEach((t) => t.addEventListener('click', () => { selectTab(t.dataset.tab); rememberTab(t.dataset.tab); }));
  els.ytApply.addEventListener('click', applyYouTube);
  els.ytPaste.addEventListener('click', pasteYouTube);
  els.ytUrl.addEventListener('input', () => showYtError(''));
  els.file.addEventListener('change', onFileChosen);
  els.recBtn.addEventListener('click', toggleRecord);
  els.localStart.addEventListener('change', () => {
    if (draft && draft.source && draft.source.type === 'local') {
      draft.source = { ...draft.source, start: clampNum(num(els.localStart.value, 0), 0, 36000) };
    }
  });
  els.preview.addEventListener('click', previewSource);
  els.clearSource.addEventListener('click', () => { stopPreview(); draft.source = null; renderSourceStatus(); });
  [els.qAnswer, els.qSearch].forEach((i) => i.addEventListener('input', updateSearchLinks));

  // 試聴用 <audio>：iOS では click ハンドラ内で同期的に play() する必要があるので 1 要素を先に作っておく
  previewAudio = document.createElement('audio');
  previewAudio.setAttribute('playsinline', '');
  previewAudio.preload = 'auto';
  previewAudio.addEventListener('ended', stopPreview);

  // 書き出しモーダル
  bindDialogClose(els.dlgExport);
  els.exportCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(els.exportText.value); toastOk('JSON をコピーしました'); }
    catch (e) { els.exportText.select(); toastError('コピーできませんでした。テキストを選択してコピーしてください。'); }
  });
  els.exportDownload.addEventListener('click', downloadOrShareExport);

  return { el: els.section, enter, leave };
}

async function enter({ id }) {
  set = findSet(id);
  if (!set) {
    try { set = await storage.getSet(id); } catch (e) { set = null; }
  }
  if (!set) { toastError('セットが見つかりません。'); return false; }
  editable = !set.builtin;
  renderHead();
  renderQuestions();
  return true;
}

function leave() {
  stopPreview();
  if (rec) stopRecording(true);
  // 画面を離れるときはモーダルも閉じる（close イベントで作業コピーと孤児 blob を掃除）
  closeDialog(els.dlg);
  closeDialog(els.dlgExport);
}

// ---------- セット見出し ----------
function renderHead() {
  els.heading.textContent = set.title;
  els.kind.textContent = set.builtin ? '同梱' : '自作';
  els.readonly.hidden = editable;
  els.form.hidden = !editable;
  els.addQ.hidden = !editable;
  els.deleteSet.hidden = !editable;
  els.clone.hidden = !set.builtin;
  els.toolbar.dataset.readonly = String(!editable);
  if (editable) {
    els.emoji.value = set.emoji || '';
    els.title.value = set.title || '';
    els.desc.value = set.description || '';
    els.playSeconds.value = set.playSeconds ?? 1.5;
    els.extendSeconds.value = set.extendSeconds ?? 2;
    els.difficulty.value = String(set.difficulty || 2);
    els.formStatus.textContent = '';
  } else {
    els.viewEmoji.textContent = set.emoji || '🎵';
    els.viewTitle.textContent = set.title;
    const st = sourceStats(set);
    els.viewMeta.textContent = `${st.total}曲・${difficultyStars(set.difficulty)}・🎧 ${st.withSource}/${st.total}・初回 ${set.playSeconds ?? 1.5}秒 / 延長 +${set.extendSeconds ?? 2}秒`;
    els.viewDesc.textContent = set.description || '';
    els.viewCredits.textContent = set.credits ? `出典：${set.credits}` : '';
  }
}

function applySetForm() {
  if (!editable) return;
  set.emoji = els.emoji.value.trim().slice(0, 2);
  set.title = els.title.value.trim().slice(0, 40) || '無題のセット';
  set.description = els.desc.value.trim().slice(0, 200);
  set.playSeconds = clampNum(num(els.playSeconds.value, 1.5), 0.5, 30);
  set.extendSeconds = clampNum(num(els.extendSeconds.value, 2), 0.5, 30);
  set.difficulty = clampNum(Math.round(num(els.difficulty.value, 2)), 1, 3);
  els.heading.textContent = set.title;
}

async function saveSet() {
  if (!editable) return;
  try {
    await storage.saveUserSet(set);
    upsertUserSet(set);
    els.formStatus.textContent = '保存しました';
    setTimeout(() => { if (els.formStatus.textContent === '保存しました') els.formStatus.textContent = ''; }, 1500);
  } catch (e) {
    console.error(e);
    toastError('保存できませんでした。端末の空き容量を確認してください。');
  }
}

async function cloneSet() {
  try {
    const copy = schema.cloneSetForEditing(set);
    await storage.saveUserSet(copy);
    upsertUserSet(copy);
    toastOk('複製しました。自作セットとして編集できます。');
    navigate('set', { id: copy.id });
  } catch (e) {
    console.error(e);
    toastError('複製できませんでした。');
  }
}

async function deleteSet() {
  if (!window.confirm(`「${set.title}」を削除しますか？\n保存した音源も削除されます。`)) return;
  try {
    await storage.deleteUserSet(set.id);
    removeUserSet(set.id);
    toast('削除しました');
    navigate('home');
  } catch (e) {
    console.error(e);
    toastError('削除できませんでした。');
  }
}

function exportSet() {
  try {
    const { json, droppedLocalSources } = schema.exportSet(set);
    els.exportText.value = json;
    let exportedId = set.id;
    try { exportedId = JSON.parse(json).id || set.id; } catch (e) { /* 整形 JSON のはずだが念のため */ }
    exportFileName = `${String(exportedId).replace(/[^a-z0-9-]/gi, '') || 'set'}.json`;
    els.exportNote.textContent = droppedLocalSources > 0
      ? `端末ファイル・録音の音源 ${droppedLocalSources} 件は持ち出せないため「未設定」になります。`
      : 'YouTube の音源はそのまま含まれます。';
    openDialog(els.dlgExport);
  } catch (e) {
    console.error(e);
    toastError('書き出しできませんでした。');
  }
}

// 共有シート（ファイル共有に対応していれば）→ ダメなら従来のダウンロード
async function downloadOrShareExport() {
  const text = els.exportText.value;
  try {
    if (navigator.share && typeof navigator.canShare === 'function' && typeof File === 'function') {
      const file = new File([text], exportFileName, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `イントロどん「${set.title}」` });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          console.warn('共有に失敗したのでダウンロードします', e);
        }
      }
    }
  } catch (e) { console.warn(e); }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: exportFileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 問題リスト ----------
function renderQuestions() {
  clear(els.qList);
  const qs = set.questions || [];
  els.qEmpty.hidden = qs.length > 0;
  qs.forEach((q, i) => {
    const li = fromTemplate('tpl-q-item');
    $('.q-no', li).textContent = String(i + 1);
    $('.q-answer', li).textContent = q.answer;
    $('.q-sub', li).textContent = q.subtitle || (q.hints && q.hints.length ? `ヒント ${q.hints.length} 件` : '');
    const kind = sourceKind(q);
    const badge = $('.q-badge', li);
    badge.dataset.kind = kind;
    badge.textContent = SOURCE_LABEL[kind];
    const btn = $('[data-action="edit"]', li);
    btn.addEventListener('click', () => openQuestionDialog(q.id));
    els.qList.append(li);
  });
  els.playSet.disabled = qs.length === 0;
}

// ---------- 問題編集モーダル ----------
function lastTab() {
  try {
    const v = localStorage.getItem(LAST_TAB_KEY);
    return ['youtube', 'file', 'record'].includes(v) ? v : 'youtube';
  } catch (e) { return 'youtube'; }
}

function rememberTab(name) {
  try { localStorage.setItem(LAST_TAB_KEY, name); } catch (e) { /* 記憶できなくても続行 */ }
}

function openQuestionDialog(qid) {
  if (!editable) { toast('同梱セットは「複製して編集」から編集できます。'); return; }
  const q = qid ? set.questions.find((x) => x.id === qid) : null;
  editingId = q ? q.id : null;
  draft = q ? JSON.parse(JSON.stringify(q)) : schema.newQuestion({});
  originalBlobId = q && q.source && q.source.type === 'local' ? q.source.blobId : null;
  draftBlobIds = [];
  previewUrls = [];
  els.qTitle.textContent = q ? '問題を編集' : '問題を追加';
  els.qDelete.hidden = !q;
  els.qAnswer.value = draft.answer || '';
  els.qAliases.value = (draft.aliases || []).join(', ');
  els.qSubtitle.value = draft.subtitle || '';
  els.qHints.value = (draft.hints || []).join('\n');
  els.qTrivia.value = draft.trivia || '';
  els.qSearch.value = draft.searchQuery || '';
  els.ytUrl.value = draft.source && draft.source.type === 'youtube' ? draft.source.videoId : '';
  els.ytStart.value = String(draft.source && draft.source.type === 'youtube' ? draft.source.start || 0 : 0);
  els.localStart.value = String(draft.source && draft.source.type === 'local' ? draft.source.start || 0 : 0);
  els.file.value = '';
  showYtError('');
  showQError('');
  const kind = sourceKind(draft);
  selectTab(kind === 'none' ? lastTab() : kind);
  renderSourceStatus();
  updateSearchLinks();
  openDialog(els.dlg);
  els.dlg.scrollTop = 0;
  // 既存の端末音源は試聴用の ObjectURL を先に用意しておく（click 内で同期的に play() するため）
  if (originalBlobId) ensurePreviewUrl(originalBlobId);
}

function onDialogClosed() {
  stopPreview();
  if (rec) stopRecording(true);
  // 保存されなかった新規 blob を掃除
  const keep = draft && draft.source && draft.source.type === 'local' && draft.saved ? draft.source.blobId : null;
  for (const id of draftBlobIds) {
    if (id !== keep) storage.deleteAudio(id).catch(() => {});
  }
  draftBlobIds = [];
  for (const u of previewUrls) { try { URL.revokeObjectURL(u); } catch (e) { /* noop */ } }
  previewUrls = [];
  if (previewAudio) { try { previewAudio.removeAttribute('src'); previewAudio.load(); } catch (e) { /* noop */ } }
  draft = null;
}

function selectTab(name) {
  $$('.tab', els.tabs).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('[data-tab-panel]', els.dlg).forEach((p) => { p.hidden = p.dataset.tabPanel !== name; });
}

function renderSourceStatus() {
  const kind = sourceKind(draft);
  let text = '未設定（「別アプリで再生」モードで遊べます）';
  if (kind === 'youtube') text = `YouTube：${draft.source.videoId}（${draft.source.start || 0}秒から）`;
  else if (kind === 'local' || kind === 'record') {
    const d = draft.source.duration ? `・${formatClock(draft.source.duration)}` : '';
    text = `${SOURCE_LABEL[kind]}：${draft.source.name || draft.source.blobId}${d}`;
  }
  els.qSourceStatus.textContent = text;
  els.qSourceStatus.dataset.kind = kind;
  els.clearSource.hidden = kind === 'none';
  els.preview.hidden = !(kind === 'local' || kind === 'record');
  els.localStartRow.hidden = !(kind === 'local' || kind === 'record');
  if (kind === 'local' || kind === 'record') els.localStart.value = String(draft.source.start || 0);
}

function updateSearchLinks() {
  const links = searchLinks({ answer: els.qAnswer.value.trim(), searchQuery: els.qSearch.value.trim() });
  els.linkYt.href = links.youtube;
  els.linkAm.href = links.apple;
}

function showYtError(msg) { els.ytError.textContent = msg; els.ytError.hidden = !msg; }
function showQError(msg) { els.qError.textContent = msg; els.qError.hidden = !msg; }

function applyYouTube() {
  const id = schema.parseYouTubeId(els.ytUrl.value.trim());
  if (!id) { showYtError('YouTube の URL または 11 文字の動画 ID を入力してください。'); return; }
  const start = clampNum(Math.floor(num(els.ytStart.value, 0)), 0, 36000);
  stopPreview();
  draft.source = { type: 'youtube', videoId: id, start };
  els.ytUrl.value = id;
  showYtError('');
  renderSourceStatus();
  toastOk('YouTube の動画を設定しました');
}

async function pasteYouTube() {
  let text = '';
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') throw new Error('unsupported');
    text = (await navigator.clipboard.readText()) || '';
  } catch (e) {
    toastError('クリップボードを読めませんでした。URL を入力欄に貼り付けてください。');
    els.ytUrl.focus();
    return;
  }
  if (!draft) return;
  text = text.trim();
  if (!text) { toast('クリップボードが空です。'); return; }
  els.ytUrl.value = text.slice(0, 200);
  if (schema.parseYouTubeId(text)) applyYouTube();
  else showYtError('クリップボードの内容は YouTube の URL ではないようです。');
}

// blob を取得した時点で試聴用 ObjectURL を用意する（保存時には捨てる）
function registerPreviewUrl(blob, blobId) {
  const url = URL.createObjectURL(blob);
  previewUrls.push(url);
  if (draft && draft.source && draft.source.type === 'local' && draft.source.blobId === blobId) draft.source._previewUrl = url;
  return url;
}

async function ensurePreviewUrl(blobId) {
  const d = draft;
  try {
    const rec_ = await storage.getAudio(blobId);
    if (draft !== d || !rec_ || !rec_.blob) return;
    registerPreviewUrl(rec_.blob, blobId);
  } catch (e) { console.warn(e); }
}

async function onFileChosen() {
  const f = els.file.files && els.file.files[0];
  if (!f) return;
  els.file.value = '';
  if (f.size > MAX_FILE_BYTES) {
    toastError(`ファイルが大きすぎます（${(f.size / 1048576).toFixed(0)}MB）。50MB 以下のファイルを選んでください。`);
    return;
  }
  if (f.type && !/^(audio|video)\//.test(f.type)) {
    toastError('音声ファイルを選んでください。');
    return;
  }
  const d = draft;
  let blobId = null;
  try {
    const duration = await probeDuration(f);
    blobId = await storage.putAudio({ blob: f, mimeType: f.type || 'application/octet-stream', name: f.name, duration });
    if (draft !== d) {
      // await の間にモーダルが閉じられた：孤児 blob を消す
      storage.deleteAudio(blobId).catch(() => {});
      return;
    }
    draftBlobIds.push(blobId);
    stopPreview();
    draft.source = { type: 'local', blobId, start: 0, name: f.name, duration };
    registerPreviewUrl(f, blobId);
    renderSourceStatus();
    toastOk('ファイルを保存しました');
  } catch (e) {
    console.error(e);
    if (draft === d) toastError('ファイルを保存できませんでした。');
  }
}

// ---------- 録音 ----------
async function toggleRecord() {
  if (rec) { await stopRecording(false); return; }
  // AudioContext はタップの同期区間で作る（iOS）
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !recAudioCtx) recAudioCtx = new AC();
    if (recAudioCtx && recAudioCtx.state === 'suspended') recAudioCtx.resume().catch(() => {});
  } catch (e) { recAudioCtx = null; }
  const r = createRecorder({ onLevel: (v) => { recLevelValue = clampNum(num(v, 0), 0, 1); }, audioContext: recAudioCtx });
  rec = r;
  recLevelValue = -1;
  els.recBtn.disabled = true;
  els.recBtn.textContent = 'マイク準備中…';
  try {
    await r.start();
  } catch (e) {
    console.error(e);
    if (rec === r) {
      rec = null;
      toastError(e && e.message ? e.message : '録音を開始できませんでした。マイクの許可を確認してください。');
    }
    els.recBtn.disabled = false;
    els.recBtn.textContent = '● 録音開始';
    return;
  }
  els.recBtn.disabled = false;
  if (rec !== r) return; // 待っている間に中止された
  stopPreview();
  recStartedAt = Date.now();
  els.recBtn.dataset.recording = 'true';
  els.recBtn.textContent = '■ 停止';
  els.recTime.textContent = '0:00';
  startLevelMeter();
  recTimer = setInterval(() => {
    const sec = (Date.now() - recStartedAt) / 1000;
    els.recTime.textContent = formatClock(sec);
    if (sec >= MAX_RECORD_SEC) stopRecording(false);
  }, 200);
}

async function stopRecording(discard) {
  const r = rec;
  rec = null;
  clearInterval(recTimer);
  recTimer = null;
  stopLevelMeter();
  els.recBtn.disabled = false;
  els.recBtn.dataset.recording = 'false';
  els.recBtn.textContent = '● 録音開始';
  if (!r) return;
  if (discard && typeof r.cancel === 'function') {
    try { r.cancel(); } catch (e) { /* noop */ }
    return;
  }
  const d = draft;
  let result = null;
  try { result = await r.stop(); } catch (e) { console.error(e); }
  if (discard || !result || !result.blob) {
    if (!discard && draft === d) toastError('録音に失敗しました。');
    return;
  }
  try {
    const dt = new Date();
    const name = `録音 ${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const duration = num(result.duration, 0) || (Date.now() - recStartedAt) / 1000;
    const blobId = await storage.putAudio({ blob: result.blob, mimeType: result.mimeType || result.blob.type, name, duration });
    if (draft !== d || !draft) {
      // await の間にモーダルが閉じられた：孤児 blob を消す
      storage.deleteAudio(blobId).catch(() => {});
      return;
    }
    draftBlobIds.push(blobId);
    stopPreview();
    draft.source = { type: 'local', blobId, start: 0, name, duration };
    registerPreviewUrl(result.blob, blobId);
    renderSourceStatus();
    toastOk(`録音しました（${formatClock(duration)}）`);
  } catch (e) {
    console.error(e);
    if (draft === d) toastError('録音を保存できませんでした。');
  }
}

// レベルメーター：レコーダーの onLevel を優先。無ければ stream から自前で計測、それも無ければ簡易アニメ。
function startLevelMeter() {
  let analyser = null;
  let data = null;
  try {
    const stream = rec && rec.stream;
    if (stream && recAudioCtx) {
      const src = recAudioCtx.createMediaStreamSource(stream);
      analyser = recAudioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      data = new Uint8Array(analyser.fftSize);
    }
  } catch (e) { analyser = null; }
  const tick = () => {
    let level = 0;
    if (recLevelValue >= 0) {
      level = recLevelValue;
    } else if (analyser) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      level = Math.min(1, Math.sqrt(sum / data.length) * 3);
    } else {
      level = 0.3 + 0.2 * Math.abs(Math.sin(Date.now() / 300));
    }
    els.recLevel.style.width = `${Math.round(level * 100)}%`;
    recLevelRaf = requestAnimationFrame(tick);
  };
  recLevelRaf = requestAnimationFrame(tick);
}

function stopLevelMeter() {
  cancelAnimationFrame(recLevelRaf);
  recLevelRaf = 0;
  els.recLevel.style.width = '0%';
  if (recAudioCtx) { recAudioCtx.close().catch(() => {}); recAudioCtx = null; }
}

// ---------- 試聴（端末・録音のみ、3秒） ----------
// iOS では click ハンドラ内で同期的に play() を呼ぶ必要があるため、ここでは await しない。
function previewSource() {
  stopPreview();
  if (!draft || !draft.source || draft.source.type !== 'local') return;
  const url = draft.source._previewUrl;
  if (!url) {
    toast('音源を読み込み中です。もう一度タップしてください。');
    ensurePreviewUrl(draft.source.blobId);
    return;
  }
  const a = previewAudio;
  const start = clampNum(num(els.localStart.value, 0), 0, 36000);
  const seek = () => { try { a.currentTime = start; } catch (e) { /* noop */ } };
  if (a.getAttribute('src') !== url) {
    a.src = url;
    a.addEventListener('loadedmetadata', seek, { once: true });
  } else if (a.readyState >= 1) {
    seek();
  } else {
    a.addEventListener('loadedmetadata', seek, { once: true });
  }
  let p = null;
  try { p = a.play(); } catch (e) { toastError('試聴できませんでした。'); return; }
  if (p && typeof p.catch === 'function') {
    p.catch((e) => {
      if (e && e.name === 'AbortError') return;
      console.warn(e);
      toastError('試聴できませんでした。');
    });
  }
  els.preview.dataset.playing = 'true';
  previewTimer = setTimeout(stopPreview, PREVIEW_MS);
}

function stopPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  if (els && els.preview) els.preview.dataset.playing = 'false';
  if (!previewAudio) return;
  try { previewAudio.pause(); } catch (e) { /* noop */ }
}

// ---------- 保存・削除 ----------
async function saveQuestion() {
  const answer = els.qAnswer.value.trim();
  if (!answer) { showQError('答えを入力してください。'); els.qAnswer.focus(); return; }
  if (rec) await stopRecording(false);
  if (!draft) return;
  stopPreview();
  const split = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  draft.answer = answer.slice(0, 80);
  draft.aliases = split(els.qAliases.value, /[,、，]/);
  draft.subtitle = els.qSubtitle.value.trim().slice(0, 120);
  draft.hints = split(els.qHints.value, /\n/).slice(0, 5);
  draft.trivia = els.qTrivia.value.trim().slice(0, 300);
  draft.searchQuery = els.qSearch.value.trim();
  if (draft.source && draft.source.type === 'local') {
    draft.source.start = clampNum(num(els.localStart.value, 0), 0, 36000);
  }
  // 保存用の問題：作業用のプロパティ（saved / _previewUrl）は捨てる
  const { saved, ...q } = draft;
  void saved;
  if (q.source && q.source.type === 'local') {
    const { _previewUrl, ...src } = q.source;
    void _previewUrl;
    q.source = src;
  }
  const i = set.questions.findIndex((x) => x.id === editingId);
  const questions = set.questions.slice();
  if (i >= 0) questions[i] = q; else questions.push(q);
  try {
    // 保存に成功してから set と draft.saved に反映する
    await storage.saveUserSet({ ...set, questions });
  } catch (e) {
    console.error(e);
    toastError('保存できませんでした。');
    return;
  }
  if (!draft) return; // 保存中にモーダルが閉じられた（blob は onDialogClosed が掃除済み）
  set.questions = questions;
  upsertUserSet(set);
  draft.saved = true;
  // 差し替えられた古い端末音源を削除
  const newBlobId = q.source && q.source.type === 'local' ? q.source.blobId : null;
  if (originalBlobId && originalBlobId !== newBlobId) storage.deleteAudio(originalBlobId).catch(() => {});
  closeDialog(els.dlg);
  renderQuestions();
  renderHead();
  toastOk('保存しました');
}

async function deleteQuestion() {
  if (!editingId) return;
  const q = set.questions.find((x) => x.id === editingId);
  if (!q || !window.confirm(`「${q.answer}」を削除しますか？`)) return;
  const questions = set.questions.filter((x) => x.id !== editingId);
  try {
    await storage.saveUserSet({ ...set, questions });
    set.questions = questions;
    upsertUserSet(set);
    if (q.source && q.source.type === 'local') storage.deleteAudio(q.source.blobId).catch(() => {});
    closeDialog(els.dlg);
    renderQuestions();
    renderHead();
    toast('削除しました');
  } catch (e) {
    console.error(e);
    toastError('削除できませんでした。');
  }
}
