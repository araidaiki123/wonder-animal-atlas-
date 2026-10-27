// 2. セット詳細／編集 + 問題編集モーダル（音源：YouTube URL / 端末ファイル / 録音）
import * as schema from '../schema.mjs';
import * as storage from '../storage.mjs';
import { createRecorder } from '../audio/local.mjs';
import { $, $$, el, clear, fromTemplate, openDialog, closeDialog, bindDialogClose, num, clampNum, formatClock, debounce, probeDuration } from './dom.mjs';
import { toast, toastError, toastOk } from './toast.mjs';
import { state, findSet, upsertUserSet, removeUserSet, sourceKind, SOURCE_LABEL, sourceStats, difficultyStars, searchLinks } from './state.mjs';
import { navigate } from './router.mjs';

const MAX_RECORD_SEC = 60;

let els;
let set = null;        // 表示中のセット（自作なら編集対象そのもの）
let editable = false;
let draft = null;      // 問題編集モーダルの作業コピー
let editingId = null;  // 編集中の question.id（新規は null）
let originalBlobId = null;
let draftBlobIds = []; // モーダル中に新規作成した blobId（キャンセル時に掃除）
let rec = null;        // 録音中のレコーダー
let recTimer = null;
let recLevelRaf = 0;
let recStartedAt = 0;
let recAudioCtx = null;
let previewAudio = null;

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

  // 問題モーダル
  bindDialogClose(els.dlg, onDialogClosed);
  els.qForm.addEventListener('submit', (e) => { e.preventDefault(); saveQuestion(); });
  els.qDelete.addEventListener('click', deleteQuestion);
  $$('.tab', els.tabs).forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  els.ytApply.addEventListener('click', applyYouTube);
  els.ytUrl.addEventListener('input', () => showYtError(''));
  els.file.addEventListener('change', onFileChosen);
  els.recBtn.addEventListener('click', toggleRecord);
  els.localStart.addEventListener('change', () => {
    if (draft && draft.source && draft.source.type === 'local') {
      draft.source = { ...draft.source, start: clampNum(num(els.localStart.value, 0), 0, 36000) };
    }
  });
  els.preview.addEventListener('click', previewSource);
  els.clearSource.addEventListener('click', () => { draft.source = null; renderSourceStatus(); });
  [els.qAnswer, els.qSearch].forEach((i) => i.addEventListener('input', updateSearchLinks));

  // 書き出しモーダル
  bindDialogClose(els.dlgExport);
  els.exportCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(els.exportText.value); toastOk('JSON をコピーしました'); }
    catch (e) { els.exportText.select(); toastError('コピーできませんでした。テキストを選択してコピーしてください。'); }
  });
  els.exportDownload.addEventListener('click', () => {
    const blob = new Blob([els.exportText.value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${set.id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

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
    els.exportNote.textContent = droppedLocalSources > 0
      ? `端末ファイル・録音の音源 ${droppedLocalSources} 件は持ち出せないため「未設定」になります。`
      : 'YouTube の音源はそのまま含まれます。';
    openDialog(els.dlgExport);
  } catch (e) {
    console.error(e);
    toastError('書き出しできませんでした。');
  }
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
function openQuestionDialog(qid) {
  if (!editable) { toast('同梱セットは「複製して編集」から編集できます。'); return; }
  const q = qid ? set.questions.find((x) => x.id === qid) : null;
  editingId = q ? q.id : null;
  draft = q ? JSON.parse(JSON.stringify(q)) : schema.newQuestion({});
  originalBlobId = q && q.source && q.source.type === 'local' ? q.source.blobId : null;
  draftBlobIds = [];
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
  selectTab(sourceKind(draft) === 'none' ? 'youtube' : (sourceKind(draft) === 'record' ? 'record' : sourceKind(draft)));
  renderSourceStatus();
  updateSearchLinks();
  openDialog(els.dlg);
  els.dlg.scrollTop = 0;
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
  draft.source = { type: 'youtube', videoId: id, start };
  els.ytUrl.value = id;
  showYtError('');
  renderSourceStatus();
  toastOk('YouTube の動画を設定しました');
}

async function onFileChosen() {
  const f = els.file.files && els.file.files[0];
  if (!f) return;
  try {
    const duration = await probeDuration(f);
    const blobId = await storage.putAudio({ blob: f, mimeType: f.type || 'application/octet-stream', name: f.name, duration });
    draftBlobIds.push(blobId);
    draft.source = { type: 'local', blobId, start: 0, name: f.name, duration };
    renderSourceStatus();
    toastOk('ファイルを保存しました');
  } catch (e) {
    console.error(e);
    toastError('ファイルを保存できませんでした。');
  }
  els.file.value = '';
}

// ---------- 録音 ----------
async function toggleRecord() {
  if (rec) { await stopRecording(false); return; }
  try {
    rec = createRecorder();
    await rec.start();
  } catch (e) {
    console.error(e);
    rec = null;
    toastError('録音を開始できませんでした。マイクの許可を確認してください。');
    return;
  }
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
  els.recBtn.dataset.recording = 'false';
  els.recBtn.textContent = '● 録音開始';
  if (!r) return;
  let result = null;
  try { result = await r.stop(); } catch (e) { console.error(e); }
  if (discard || !result || !result.blob) {
    if (!discard) toastError('録音に失敗しました。');
    return;
  }
  try {
    const d = new Date();
    const name = `録音 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const duration = num(result.duration, 0) || (Date.now() - recStartedAt) / 1000;
    const blobId = await storage.putAudio({ blob: result.blob, mimeType: result.mimeType || result.blob.type, name, duration });
    draftBlobIds.push(blobId);
    if (draft) {
      draft.source = { type: 'local', blobId, start: 0, name, duration };
      renderSourceStatus();
    }
    toastOk(`録音しました（${formatClock(duration)}）`);
  } catch (e) {
    console.error(e);
    toastError('録音を保存できませんでした。');
  }
}

// レベルメーター：レコーダーが stream か getLevel() を公開していればそれを使う。無ければ簡易アニメ。
function startLevelMeter() {
  let analyser = null;
  let data = null;
  try {
    const stream = rec && rec.stream;
    if (stream && (window.AudioContext || window.webkitAudioContext)) {
      recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = recAudioCtx.createMediaStreamSource(stream);
      analyser = recAudioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      data = new Uint8Array(analyser.fftSize);
    }
  } catch (e) { analyser = null; }
  const tick = () => {
    let level = 0;
    if (analyser) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      level = Math.min(1, Math.sqrt(sum / data.length) * 3);
    } else if (rec && typeof rec.getLevel === 'function') {
      level = clampNum(num(rec.getLevel(), 0), 0, 1);
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
async function previewSource() {
  stopPreview();
  if (!draft || !draft.source || draft.source.type !== 'local') return;
  try {
    const rec_ = await storage.getAudio(draft.source.blobId);
    if (!rec_ || !rec_.blob) { toastError('音源が見つかりません。'); return; }
    const url = URL.createObjectURL(rec_.blob);
    previewAudio = document.createElement('audio');
    previewAudio.setAttribute('playsinline', '');
    previewAudio.src = url;
    previewAudio.currentTime = num(els.localStart.value, 0);
    previewAudio.addEventListener('ended', stopPreview);
    await previewAudio.play();
    setTimeout(stopPreview, 3000);
    previewAudio._url = url;
  } catch (e) {
    console.error(e);
    toastError('試聴できませんでした。');
  }
}

function stopPreview() {
  if (!previewAudio) return;
  try { previewAudio.pause(); } catch (e) { /* noop */ }
  if (previewAudio._url) URL.revokeObjectURL(previewAudio._url);
  previewAudio = null;
}

// ---------- 保存・削除 ----------
async function saveQuestion() {
  const answer = els.qAnswer.value.trim();
  if (!answer) { showQError('答えを入力してください。'); els.qAnswer.focus(); return; }
  if (rec) await stopRecording(false);
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
  draft.saved = true;
  const { saved, ...q } = draft;
  const i = set.questions.findIndex((x) => x.id === editingId);
  if (i >= 0) set.questions[i] = q; else set.questions.push(q);
  try {
    await storage.saveUserSet(set);
    upsertUserSet(set);
  } catch (e) {
    console.error(e);
    toastError('保存できませんでした。');
    return;
  }
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
  set.questions = set.questions.filter((x) => x.id !== editingId);
  try {
    await storage.saveUserSet(set);
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
