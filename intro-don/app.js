// イントロどん UI コントローラ：起動、画面登録、ルーター、Service Worker、共有ターゲット
import * as schema from './src/schema.mjs';
import * as storage from './src/storage.mjs';
import { $, clear, el, openDialog, closeDialog, bindDialogClose } from './src/ui/dom.mjs';
import { toast, toastError, toastOk } from './src/ui/toast.mjs';
import { state, refreshSets, upsertUserSet } from './src/ui/state.mjs';
import { registerScreen, startRouter, navigate } from './src/ui/router.mjs';
import { initHome, render as renderHome, updateOffline } from './src/ui/home.mjs';
import { initSetEditor } from './src/ui/set-editor.mjs';
import { initSetup } from './src/ui/setup.mjs';
import { initPlay } from './src/ui/play.mjs';
import { initResult } from './src/ui/result.mjs';

async function boot() {
  // 設定とセット一覧
  try { state.settings = (await storage.loadSettings()) || {}; } catch (e) { state.settings = {}; }
  await refreshSets();

  registerScreen('home', initHome());
  registerScreen('set', initSetEditor());
  registerScreen('setup', initSetup());
  registerScreen('play', initPlay());
  registerScreen('result', initResult());

  updateOffline();
  bindViewportHeight();
  startRouter();

  handleShareTarget();
  registerServiceWorker();

  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
  });
}

// ---------- visualViewport の高さを CSS 変数 --vvh に反映（iOS のキーボード表示中もダイアログが収まるように） ----------
function bindViewportHeight() {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv && Number.isFinite(vv.height) ? vv.height : window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--vvh', `${Math.round(h)}px`);
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
}

// ---------- Web Share Target：?url= / ?text= / ?title= から YouTube を拾う ----------
function handleShareTarget() {
  const params = new URL(location.href).searchParams;
  if (!params.has('url') && !params.has('text') && !params.has('title')) return;
  let videoId = null;
  for (const key of ['url', 'text', 'title']) {
    const v = params.get(key);
    if (!v) continue;
    videoId = schema.parseYouTubeId(v.trim());
    if (!videoId) {
      const m = v.match(/https?:\/\/\S+/);
      if (m) videoId = schema.parseYouTubeId(m[0]);
    }
    if (videoId) break;
  }
  // クエリは消してリロードで再表示されないようにする
  history.replaceState(null, '', location.pathname + (location.hash || ''));
  if (!videoId) { toast('共有された内容から YouTube の動画を見つけられませんでした。'); return; }
  openShareDialog(videoId, params.get('title') || '');
}

function openShareDialog(videoId, titleHint) {
  const dlg = $('#dlg-share');
  const form = $('#share-form');
  const select = $('#share-set-select');
  const answer = $('#share-answer');
  const err = $('#share-error');
  $('#share-video-id').textContent = videoId;
  clear(select);
  for (const s of state.userSets) select.append(el('option', { value: s.id, text: `${s.emoji || '🎵'} ${s.title}` }));
  select.append(el('option', { value: '__new__', text: '＋ 新しいセットを作る' }));
  if (state.settings.lastSetId && state.userSets.some((s) => s.id === state.settings.lastSetId)) select.value = state.settings.lastSetId;
  // 共有元のタイトルを既定値として入れておく（required と placeholder の矛盾を避ける）
  answer.value = titleHint ? titleHint.trim().slice(0, 80) : '';
  answer.placeholder = '曲名など';
  err.hidden = true;
  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    bindDialogClose(dlg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = answer.value.trim();
      if (!a) { err.textContent = '答えを入力してください。'; err.hidden = false; return; }
      try {
        let set = state.userSets.find((s) => s.id === select.value);
        if (!set) set = schema.newUserSet({ title: '共有した動画', emoji: '📺' });
        const q = schema.newQuestion({ answer: a.slice(0, 80), source: { type: 'youtube', videoId: $('#share-video-id').textContent, start: 0 } });
        set.questions.push(q);
        await storage.saveUserSet(set);
        upsertUserSet(set);
        closeDialog(dlg);
        toastOk(`「${set.title}」に追加しました`);
        renderHome();
        navigate('set', { id: set.id });
      } catch (ex) {
        console.error(ex);
        err.textContent = '追加できませんでした。';
        err.hidden = false;
      }
    });
  }
  openDialog(dlg);
}

// ---------- Service Worker：登録と更新通知 ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  // 初回インストール時の clients.claim() でもリロードしないよう、利用者が「再読み込み」を押したときだけ reload する
  let wantReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wantReload) return;
    wantReload = false;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const notify = (worker) => {
      toast('新しいバージョンがあります。', {
        duration: 0,
        action: { label: '再読み込み', onClick: () => { wantReload = true; worker.postMessage({ type: 'SKIP_WAITING' }); } },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) notify(w);
      });
    });
  }).catch((e) => { console.warn('Service Worker を登録できませんでした', e); });
}

boot().catch((e) => {
  console.error(e);
  toastError('アプリを起動できませんでした。再読み込みしてください。');
});
