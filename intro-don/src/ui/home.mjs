// 1. ホーム：セット一覧、自作セット作成、JSON 読み込み、圏外バナー
import * as schema from '../schema.mjs';
import * as storage from '../storage.mjs';
import { $, clear, fromTemplate, openDialog, closeDialog, bindDialogClose } from './dom.mjs';
import { toastError, toastOk } from './toast.mjs';
import { state, refreshSets, upsertUserSet, sourceStats, difficultyStars } from './state.mjs';
import { navigate } from './router.mjs';
import { startQuick } from './setup.mjs';

let els;

export function initHome() {
  els = {
    section: $('[data-screen="home"]'),
    builtinList: $('#builtin-list'),
    builtinEmpty: $('#builtin-empty'),
    userList: $('#user-list'),
    userEmpty: $('#user-empty'),
    offline: $('#offline-banner'),
    usage: $('#storage-usage'),
    dlgImport: $('#dlg-import'),
    importForm: $('#import-form'),
    importFile: $('#import-file'),
    importText: $('#import-text'),
    importError: $('#import-error'),
  };

  $('#btn-new-set').addEventListener('click', createNewSet);
  $('#btn-import').addEventListener('click', () => {
    els.importText.value = '';
    els.importFile.value = '';
    showImportError('');
    openDialog(els.dlgImport);
  });
  bindDialogClose(els.dlgImport);
  els.importFile.addEventListener('change', async () => {
    const f = els.importFile.files && els.importFile.files[0];
    if (!f) return;
    try { els.importText.value = await f.text(); showImportError(''); }
    catch (e) { showImportError('ファイルを読めませんでした。'); }
  });
  els.importForm.addEventListener('submit', (e) => { e.preventDefault(); doImport(); });

  window.addEventListener('online', updateOffline);
  window.addEventListener('offline', updateOffline);

  return { el: els.section, enter, leave };
}

async function enter() {
  updateOffline();
  render();
  updateUsage();
  return true;
}

function leave() {}

export function updateOffline() {
  if (!els) return;
  els.offline.hidden = navigator.onLine !== false;
}

async function updateUsage() {
  try {
    const u = await storage.estimateUsage();
    if (u && typeof u.usage === 'number') {
      const mb = (n) => (n / 1048576).toFixed(1);
      els.usage.textContent = `端末の保存領域：${mb(u.usage)} MB 使用` + (u.quota ? ` / 約 ${mb(u.quota)} MB` : '');
    } else {
      els.usage.textContent = '';
    }
  } catch (e) { els.usage.textContent = ''; }
}

export function render() {
  if (!els) return;
  renderList(els.builtinList, state.builtinSets);
  els.builtinEmpty.hidden = !(state.builtinSets.length === 0);
  renderList(els.userList, state.userSets);
  els.userEmpty.hidden = state.userSets.length > 0;
}

function renderList(container, sets) {
  clear(container);
  for (const set of sets) {
    const card = fromTemplate('tpl-set-card');
    $('.set-emoji', card).textContent = set.emoji || '🎵';
    $('.set-title', card).textContent = set.title;
    const st = sourceStats(set);
    $('.set-meta', card).textContent = `${st.total}曲・${difficultyStars(set.difficulty)}・🎧 ${st.withSource}/${st.total}`;
    $('[data-action="open"]', card).addEventListener('click', () => navigate('set', { id: set.id }));
    // 「🎧 聴く」：きがるモードで設定画面を経由せず即スタート
    const listenBtn = $('[data-action="listen"]', card);
    listenBtn.disabled = st.total === 0;
    listenBtn.addEventListener('click', () => startQuick(set, { mode: 'casual' }));
    const playBtn = $('[data-action="play"]', card);
    playBtn.disabled = st.total === 0;
    playBtn.addEventListener('click', () => navigate('setup', { id: set.id }));
    container.append(card);
  }
}

async function createNewSet() {
  try {
    const set = schema.newUserSet({ title: '新しいセット', emoji: '🎵' });
    await storage.saveUserSet(set);
    upsertUserSet(set);
    navigate('set', { id: set.id });
  } catch (e) {
    console.error(e);
    toastError('セットを作成できませんでした。');
  }
}

function showImportError(msg) {
  els.importError.textContent = msg;
  els.importError.hidden = !msg;
}

async function doImport() {
  const text = els.importText.value.trim();
  if (!text) { showImportError('JSON ファイルを選ぶか、テキストを貼り付けてください。'); return; }
  let result;
  // 同梱セットと同じ id は "user-" に付け替えてもらう（同梱カードの乗っ取り防止）
  try { result = schema.importSet(text, { builtinIds: state.builtinSets.map((s) => s.id) }); }
  catch (e) { result = { ok: false, errors: [String(e && e.message || e)] }; }
  if (!result || !result.ok) {
    const errs = (result && result.errors) || ['読み込めませんでした。'];
    showImportError('読み込めませんでした：' + errs.slice(0, 3).join(' / '));
    return;
  }
  // 念のため UI 側でも同梱 id との衝突を弾く（schema 側の付け替えが効かなかった場合の保険）
  if (state.builtinSets.some((b) => b.id === result.set.id)) {
    showImportError('読み込めませんでした：同梱セットと同じ ID です。');
    return;
  }
  // 同じ ID の自作セットがあれば上書き確認
  const existing = state.userSets.find((u) => u.id === result.set.id);
  if (existing && !window.confirm(`同じIDのセットを上書きしますか？\n「${existing.title}」→「${result.set.title}」`)) return;
  try {
    await storage.saveUserSet(result.set);
    upsertUserSet(result.set);
    closeDialog(els.dlgImport);
    toastOk(`「${result.set.title}」を読み込みました（${result.set.questions.length}問）`);
    render();
    navigate('set', { id: result.set.id });
  } catch (e) {
    console.error(e);
    showImportError('保存できませんでした。端末の空き容量を確認してください。');
  }
}

export async function reloadAndRender() {
  await refreshSets();
  render();
}

