/**
 * YouTube IFrame Player API adapter（イントロどん 音声担当）
 * - loadYouTubeApi(): window.YT があれば再利用、なければ iframe_api を <script> で遅延ロード。
 *   オフライン（navigator.onLine === false）と 8 秒タイムアウトは日本語メッセージで reject。
 * - createYouTubeAdapter(): prepare=cueVideoById、play=seekTo→playVideo、stop=pauseVideo。
 *   再生開始の検知は PLAYING 状態で行い、player.mjs の停止タイマーはそこから数える。
 * - 動画の見た目（サムネ・タイトル）はネタバレなので UI 側が不透明オーバーレイで覆う。
 *   adapter は display:none / visibility:hidden / 音量 0 にしない（iOS で再生されないため）。
 */

export const YT_API_URL = 'https://www.youtube.com/iframe_api';
export const YT_LOAD_TIMEOUT_MS = 8000;
export const YT_LOAD_ERROR_MESSAGE = 'YouTube を読み込めません。通信環境を確認してください';

/** YT.PlayerState と同じ値（API ロード前でも参照できるように定数化） */
export const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/** onError のコード → 日本語メッセージ */
export const YT_ERROR_MESSAGES = {
  2: '動画の指定が正しくありません（動画IDを確認してください）',
  5: 'この動画はブラウザで再生できません',
  100: '動画が見つかりません（削除済みか非公開の可能性があります）',
  101: 'この動画は埋め込み再生が許可されていません',
  150: 'この動画は埋め込み再生が許可されていません',
};

export function youtubeErrorMessage(code) {
  return YT_ERROR_MESSAGES[code] || `YouTube の再生でエラーが発生しました（コード ${String(code)}）`;
}

// window ごとのロード中 Promise（同時に複数回呼ばれても <script> を 1 つにする）
const loadingByWindow = new WeakMap();

/** 実行環境（テストではフェイクの window/document/navigator を注入する） */
function resolveEnv(env) {
  return {
    window: env?.window ?? globalThis.window,
    document: env?.document ?? globalThis.document,
    navigator: env?.navigator ?? globalThis.navigator,
    setTimeout: env?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout: env?.clearTimeout ?? ((id) => globalThis.clearTimeout(id)),
  };
}

/**
 * IFrame API を読み込み、window.YT を返す。
 * @param {{ timeoutMs?: number, env?: object }} [opts]
 * @returns {Promise<object>} YT 名前空間
 */
export function loadYouTubeApi({ timeoutMs = YT_LOAD_TIMEOUT_MS, env = null } = {}) {
  const E = resolveEnv(env);
  const win = E.window;
  if (!win || !E.document) return Promise.reject(new Error(YT_LOAD_ERROR_MESSAGE));

  // 既にロード済みなら再利用
  if (win.YT && typeof win.YT.Player === 'function') return Promise.resolve(win.YT);

  // オフラインは即座に失敗させる（8 秒待たせない）
  if (E.navigator && E.navigator.onLine === false) return Promise.reject(new Error(YT_LOAD_ERROR_MESSAGE));

  const cached = loadingByWindow.get(win);
  if (cached) return cached;

  const promise = new Promise((resolve, reject) => {
    const doc = E.document;
    let done = false;
    let script = null;
    let pollId = null;

    const finish = (ok, value) => {
      if (done) return;
      done = true;
      E.clearTimeout(timer);
      if (pollId != null) E.clearTimeout(pollId);
      if (ok) {
        resolve(value);
      } else {
        // 失敗したら次回の呼び出しで再試行できるようにキャッシュと <script> を捨てる
        loadingByWindow.delete(win);
        if (script && script.parentNode && typeof script.parentNode.removeChild === 'function') {
          try { script.parentNode.removeChild(script); } catch { /* 無視 */ }
        }
        reject(value);
      }
    };

    const timer = E.setTimeout(() => finish(false, new Error(YT_LOAD_ERROR_MESSAGE)), timeoutMs);

    // 他のコードが設定していたコールバックがあれば連鎖させる
    const prev = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') { try { prev(); } catch { /* 無視 */ } }
      finish(true, win.YT);
    };

    // コールバックが他所で上書きされた場合の保険として YT.Player の出現をポーリング
    const poll = () => {
      if (done) return;
      if (win.YT && typeof win.YT.Player === 'function') { finish(true, win.YT); return; }
      pollId = E.setTimeout(poll, 200);
    };
    pollId = E.setTimeout(poll, 200);

    // <script> が既にあれば（他コードがロード中）追加しない
    script = typeof doc.querySelector === 'function' ? doc.querySelector(`script[src="${YT_API_URL}"]`) : null;
    if (!script) {
      script = doc.createElement('script');
      script.src = YT_API_URL;
      script.async = true;
      script.onerror = () => finish(false, new Error(YT_LOAD_ERROR_MESSAGE));
      const parent = doc.head || doc.documentElement || doc.body;
      parent.appendChild(script);
    }
  });

  loadingByWindow.set(win, promise);
  return promise;
}

/**
 * YouTube adapter を作る。
 * @param {object} opts
 * @param {HTMLElement} opts.mountEl iframe を描画する要素。内部に子要素を作って iframe に置き換えるので mountEl 自体は残る。
 *   UI 側は mountEl にサイズを与え、その上に不透明オーバーレイを重ねること。
 * @param {() => void} [opts.onPlaying] PLAYING 状態になった
 * @param {() => void} [opts.onPaused]
 * @param {() => void} [opts.onEnded]
 * @param {(err: Error) => void} [opts.onError]
 * @param {Function} [opts.loadApi] テスト用（既定 loadYouTubeApi）
 * @param {number} [opts.timeoutMs] onReady / cue 待ちのタイムアウト
 */
export function createYouTubeAdapter({
  mountEl,
  onPlaying = null,
  onPaused = null,
  onEnded = null,
  onError = null,
  loadApi = loadYouTubeApi,
  timeoutMs = YT_LOAD_TIMEOUT_MS,
  env = null,
} = {}) {
  const E = resolveEnv(env);
  let player = null;          // YT.Player
  let creating = null;        // 作成中の Promise
  let pendingCue = null;      // { resolve, reject, timer }
  let holder = null;          // mountEl の中に作る要素（YT.Player がこれを iframe に置き換える）
  let destroyed = false;

  const safe = (fn, ...args) => { if (typeof fn === 'function') { try { fn(...args); } catch { /* 無視 */ } } };

  function settleCue(ok, value) {
    if (!pendingCue) return;
    const p = pendingCue;
    pendingCue = null;
    E.clearTimeout(p.timer);
    if (ok) p.resolve(value); else p.reject(value);
  }

  function handleStateChange(event) {
    const s = event && event.data;
    if (s === PlayerState.CUED) settleCue(true);
    else if (s === PlayerState.PLAYING) safe(onPlaying);
    else if (s === PlayerState.PAUSED) safe(onPaused);
    else if (s === PlayerState.ENDED) safe(onEnded);
  }

  function handleError(event) {
    const code = event && event.data;
    const err = new Error(youtubeErrorMessage(code));
    err.code = code;
    if (pendingCue) settleCue(false, err);
    safe(onError, err);
  }

  /** YT.Player を 1 回だけ作る（onReady まで待つ） */
  function ensurePlayer(YT) {
    if (player) return Promise.resolve(player);
    if (creating) return creating;
    creating = new Promise((resolve, reject) => {
      if (!mountEl || typeof mountEl.appendChild !== 'function') {
        reject(new Error('YouTube の表示先が見つかりません'));
        return;
      }
      const doc = E.document || mountEl.ownerDocument;
      holder = doc.createElement('div');
      mountEl.appendChild(holder);

      const timer = E.setTimeout(() => {
        creating = null;
        reject(new Error(YT_LOAD_ERROR_MESSAGE));
      }, timeoutMs);

      let created = null;
      created = new YT.Player(holder, {
        width: '100%',
        height: '100%',
        playerVars: {
          playsinline: 1,
          controls: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          fs: 0,
          iv_load_policy: 3,
          origin: E.window && E.window.location ? E.window.location.origin : undefined,
        },
        events: {
          onReady: (ev) => {
            E.clearTimeout(timer);
            player = created || (ev && ev.target) || null;
            creating = null;
            // iframe を mount 要素いっぱいに描画（display:none 等は使わない）
            try {
              const iframe = typeof player.getIframe === 'function' ? player.getIframe() : null;
              if (iframe && iframe.style) {
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                iframe.style.display = 'block';
                iframe.style.border = '0';
              }
            } catch { /* 無視 */ }
            resolve(player);
          },
          onStateChange: handleStateChange,
          onError: (e) => {
            // 作成中のエラーは prepare を失敗させる
            if (!player) {
              E.clearTimeout(timer);
              creating = null;
              const code = e && e.data;
              const err = new Error(youtubeErrorMessage(code));
              err.code = code;
              reject(err);
              return;
            }
            handleError(e);
          },
        },
      });
    });
    return creating;
  }

  return {
    kind: 'youtube',

    /** 動画を cue する。CUED 状態になるか onError まで待つ（タイムアウトはエラー扱い） */
    async prepare(source) {
      if (destroyed) throw new Error('プレイヤーは破棄されています');
      if (!source || !source.videoId) throw new Error('YouTube の動画IDが設定されていません');
      if (E.navigator && E.navigator.onLine === false) throw new Error(YT_LOAD_ERROR_MESSAGE);

      const YT = await loadApi({ timeoutMs, env });
      const p = await ensurePlayer(YT);
      if (destroyed) throw new Error('プレイヤーは破棄されています');

      settleCue(false, new Error('別の問題の準備が始まりました'));
      await new Promise((resolve, reject) => {
        const timer = E.setTimeout(() => {
          pendingCue = null;
          reject(new Error(YT_LOAD_ERROR_MESSAGE));
        }, timeoutMs);
        pendingCue = { resolve, reject, timer };
        try {
          p.cueVideoById({ videoId: source.videoId, startSeconds: Number(source.start) || 0 });
        } catch (e) {
          settleCue(false, e instanceof Error ? e : new Error('動画を読み込めません'));
        }
      });
    },

    /** タップハンドラから同期的に呼ばれる。seekTo → playVideo */
    play({ start = 0 } = {}) {
      if (!player) throw new Error('動画の準備ができていません');
      player.seekTo(Math.max(0, Number(start) || 0), true);
      player.playVideo();
    },

    stop() {
      if (!player) return;
      try { player.pauseVideo(); } catch { /* 無視 */ }
    },

    /** YouTube は iframe 側の制御なので解放処理はない（local の <audio> が担当） */
    unlock() {},

    /** テスト・デバッグ用 */
    getPlayer() { return player; },

    destroy() {
      destroyed = true;
      settleCue(false, new Error('プレイヤーは破棄されています'));
      if (player) { try { player.destroy(); } catch { /* 無視 */ } }
      player = null;
      creating = null;
      if (holder && holder.parentNode && typeof holder.parentNode.removeChild === 'function') {
        try { holder.parentNode.removeChild(holder); } catch { /* 無視 */ }
      }
      holder = null;
    },
  };
}
