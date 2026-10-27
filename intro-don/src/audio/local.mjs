/**
 * 端末ファイル / 録音（Blob）再生 adapter と MediaRecorder 録音（イントロどん 音声担当）
 * - createLocalAdapter(): <audio playsinline preload="auto"> 1 要素を使い回し、Blob → ObjectURL で再生。
 *   前の ObjectURL は revoke。play() は同期的に audio.play() を呼ぶ（iOS の自動再生制限対策）。
 *   unlock() は無音 WAV を play()→pause() して iOS のオーディオを解放する。
 *   release() は ObjectURL を revoke して src を外す（player.mjs が adapter を切り替えるときに呼ぶ）。
 * - createRecorder(): getUserMedia → MediaRecorder。mimeType は audio/mp4 → webm;opus → webm の順で選ぶ。
 *   duration は performance.now() の差分で計測（Blob の duration は Infinity になることがある）。
 *   getUserMedia 待ち中に cancel()/stop() されても、解決後に track を止めてマイクを解放する。
 *   audioContext を外から渡せる（UI がタップの同期区間で生成したものを使う。渡されたものは close しない）。
 * - DOM / navigator はトップレベルで参照しない（Node のテストで import しても落ちない）。
 */

/** MediaRecorder の mimeType 候補（iOS Safari は audio/mp4 のみ） */
export const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

export const MIC_DENIED_MESSAGE = 'マイクを使用できません。ブラウザの設定でマイクの許可を確認してください';
export const MIC_NOT_FOUND_MESSAGE = 'マイクが見つかりません';
export const RECORDER_UNSUPPORTED_MESSAGE = 'このブラウザは録音に対応していません';
export const LEVEL_INTERVAL_MS = 60;

/** <audio> の MediaError.code → 日本語 */
const MEDIA_ERROR_MESSAGES = {
  1: '再生が中断されました',
  2: '音源の読み込みに失敗しました（通信エラー）',
  3: 'この音源はデコードできません（ファイルが壊れている可能性があります）',
  4: 'この形式の音源はこの端末では再生できません',
};

/**
 * MediaRecorder.isTypeSupported を使って mimeType を選ぶ。どれも非対応なら ''（ブラウザ既定）。
 * @param {(type: string) => boolean} [isTypeSupported] テスト用に差し替え可能
 */
export function pickMimeType(isTypeSupported = defaultIsTypeSupported) {
  for (const type of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch { /* 古いブラウザで例外になっても次へ */ }
  }
  return '';
}

function defaultIsTypeSupported(type) {
  const MR = globalThis.MediaRecorder;
  return !!(MR && typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(type));
}

/**
 * 無音の WAV（8kHz / 8bit / mono / 約 50ms）を data URL で作る。iOS のオーディオ解放用。
 * ファイルを同梱しなくて済むように実行時に生成する。
 */
export function makeSilentWavDataUrl(sampleCount = 400) {
  const header = 44;
  const bytes = new Uint8Array(header + sampleCount);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
  const u32 = (off, v) => { bytes[off] = v & 255; bytes[off + 1] = (v >> 8) & 255; bytes[off + 2] = (v >> 16) & 255; bytes[off + 3] = (v >>> 24) & 255; };
  const u16 = (off, v) => { bytes[off] = v & 255; bytes[off + 1] = (v >> 8) & 255; };
  str(0, 'RIFF'); u32(4, 36 + sampleCount); str(8, 'WAVE');
  str(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, 1); u32(24, 8000); u32(28, 8000); u16(32, 1); u16(34, 8);
  str(36, 'data'); u32(40, sampleCount);
  bytes.fill(128, header); // 8bit PCM の無音は 128
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof globalThis.btoa === 'function'
    ? globalThis.btoa(bin)
    : Buffer.from(bin, 'binary').toString('base64');
  return `data:audio/wav;base64,${b64}`;
}

function mediaErrorToError(audio) {
  const code = audio && audio.error && audio.error.code;
  const e = new Error(MEDIA_ERROR_MESSAGES[code] || '音源を再生できません');
  e.code = code;
  return e;
}

function playRejectionToError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return new Error('再生がブロックされました。画面をタップしてからもう一度お試しください');
  if (name === 'NotSupportedError') return new Error('この形式の音源はこの端末では再生できません');
  if (name === 'AbortError') return null; // 自分で pause/再読込した時に出る。エラー扱いしない
  const e = new Error('音源を再生できません');
  e.cause = err;
  return e;
}

/**
 * local adapter を作る。
 * @param {object} opts
 * @param {(blobId: string) => Promise<{blob: Blob, mimeType?: string}>} opts.getAudio
 * @param {() => void} [opts.onPlaying] 実際に音が出始めた（playing イベント）
 * @param {(currentTimeSec: number) => void} [opts.onTimeUpdate]
 * @param {() => void} [opts.onEnded]
 * @param {(err: Error) => void} [opts.onError]
 * @param {object} [opts.env] テスト用 { document, URL, setTimeout, clearTimeout }
 * @param {number} [opts.loadTimeoutMs] メタデータ待ちの上限（超えても ready 扱い。iOS はタップ前に読み込まないことがある）
 */
export function createLocalAdapter({
  getAudio = null,
  onPlaying = null,
  onEnded = null,
  onTimeUpdate = null,
  onError = null,
  env = null,
  loadTimeoutMs = 3000,
} = {}) {
  const E = {
    document: env?.document ?? globalThis.document,
    URL: env?.URL ?? globalThis.URL,
    setTimeout: env?.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout: env?.clearTimeout ?? ((id) => globalThis.clearTimeout(id)),
  };
  let audio = null;
  let currentUrl = null;     // revoke 用
  let pendingStart = null;   // メタデータ未取得で currentTime を設定できなかった時の退避
  let unlocking = false;     // unlock 中の AbortError 等を無視するため
  let destroyed = false;

  const safe = (fn, ...args) => { if (typeof fn === 'function') { try { fn(...args); } catch { /* 無視 */ } } };

  const listeners = {
    playing: () => { if (!unlocking) safe(onPlaying); },
    timeupdate: () => { if (!unlocking && audio) safe(onTimeUpdate, audio.currentTime); },
    ended: () => { if (!unlocking) safe(onEnded); },
    error: () => { if (!unlocking && audio && audio.src) safe(onError, mediaErrorToError(audio)); },
    loadedmetadata: () => {
      if (pendingStart != null && audio) {
        try { audio.currentTime = pendingStart; } catch { /* 無視 */ }
        pendingStart = null;
      }
    },
  };

  /** <audio> を 1 回だけ作る（DOM 参照はここで初めて行う） */
  function ensureAudio() {
    if (audio) return audio;
    if (!E.document) throw new Error('この環境では音声を再生できません');
    audio = E.document.createElement('audio');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.playsInline = true;
    audio.preload = 'auto';
    for (const [ev, fn] of Object.entries(listeners)) audio.addEventListener(ev, fn);
    return audio;
  }

  function revoke() {
    if (currentUrl && E.URL && typeof E.URL.revokeObjectURL === 'function') {
      try { E.URL.revokeObjectURL(currentUrl); } catch { /* 無視 */ }
    }
    currentUrl = null;
  }

  /** src を差し替えてメタデータ取得を待つ（エラーは reject、タイムアウトは ready 扱い） */
  function loadUrl(url) {
    const a = ensureAudio();
    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        a.removeEventListener('loadedmetadata', onOk);
        a.removeEventListener('canplay', onOk);
        a.removeEventListener('error', onErr);
        E.clearTimeout(timer);
      };
      const onOk = () => { if (done) return; done = true; cleanup(); resolve(); };
      const onErr = () => { if (done) return; done = true; cleanup(); reject(mediaErrorToError(a)); };
      const timer = E.setTimeout(onOk, loadTimeoutMs);
      a.addEventListener('loadedmetadata', onOk);
      a.addEventListener('canplay', onOk);
      a.addEventListener('error', onErr);
      try { a.pause(); } catch { /* 無視 */ }
      a.src = url;
      try { a.load(); } catch { /* 無視 */ }
    });
  }

  return {
    kind: 'local',

    /** getAudio(blobId) → ObjectURL → <audio>.src。前の ObjectURL は revoke */
    async prepare(source) {
      if (destroyed) throw new Error('プレイヤーは破棄されています');
      if (!source || !source.blobId) throw new Error('音源が設定されていません');
      if (typeof getAudio !== 'function') throw new Error('音源の読み込み手段がありません');
      if (!E.URL || typeof E.URL.createObjectURL !== 'function') throw new Error('この環境では音声を再生できません');
      ensureAudio();   // DOM が無い環境はここで日本語エラー

      const rec = await getAudio(source.blobId);
      const blob = rec && (rec.blob || (typeof Blob !== 'undefined' && rec instanceof Blob ? rec : null));
      if (!blob) throw new Error('音源データが見つかりません（削除された可能性があります）');

      revoke();
      currentUrl = E.URL.createObjectURL(blob);
      pendingStart = null;
      await loadUrl(currentUrl);
    },

    /** タップハンドラから同期的に呼ばれる。currentTime=start; play() */
    play({ start = 0 } = {}) {
      const a = ensureAudio();
      if (!a.src) throw new Error('音源の準備ができていません');
      const startSec = Math.max(0, Number(start) || 0);
      unlocking = false;   // unlock() と同じタップ内で呼ばれても playing イベントを取りこぼさない
      try {
        a.currentTime = startSec;
        pendingStart = null;
      } catch {
        pendingStart = startSec;   // メタデータ未取得。loadedmetadata で設定する
      }
      const p = a.play();          // ← 同期呼び出し
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          const e = playRejectionToError(err);
          if (e) safe(onError, e);
        });
      }
    },

    stop() {
      if (!audio) return;
      try { audio.pause(); } catch { /* 無視 */ }
    },

    /**
     * iOS のオーディオ解放。初回タップ内で同期的に play() し、直後に pause() する。
     * src が未設定なら無音 WAV を一時的に使い、終わったら元に戻す。失敗は握りつぶす。
     */
    unlock() {
      let a;
      try { a = ensureAudio(); } catch { return Promise.resolve(); }
      const hadSrc = !!a.src;
      const silent = hadSrc ? null : makeSilentWavDataUrl();
      unlocking = true;
      let p;
      try {
        if (silent) a.src = silent;
        p = a.play();
        a.pause();
      } catch {
        p = null;
      }
      const done = () => {
        // その間に prepare() が本物の src を設定していたら触らない
        if (silent && audio === a && a.src === silent) {
          try { a.removeAttribute('src'); a.load(); } catch { /* 無視 */ }
        }
        unlocking = false;
      };
      if (p && typeof p.then === 'function') return p.then(done, done);
      done();
      return Promise.resolve();
    },

    /**
     * 音源を手放す（ObjectURL を revoke し src を外す）。<audio> 要素とリスナーは残すので、
     * 次の prepare() でそのまま使える。player.mjs が別種別の adapter に切り替えるときに呼ぶ。
     */
    release() {
      pendingStart = null;
      if (audio) {
        try { audio.pause(); } catch { /* 無視 */ }
        try { audio.removeAttribute('src'); audio.load(); } catch { /* 無視 */ }
      }
      revoke();
    },

    /** テスト・デバッグ用 */
    getElement() { return audio; },

    destroy() {
      destroyed = true;
      if (audio) {
        try { audio.pause(); } catch { /* 無視 */ }
        for (const [ev, fn] of Object.entries(listeners)) audio.removeEventListener(ev, fn);
        try { audio.removeAttribute('src'); audio.load(); } catch { /* 無視 */ }
      }
      revoke();
      audio = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 録音
// ---------------------------------------------------------------------------

function userMediaErrorToError(err) {
  const name = err && err.name;
  let e;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') e = new Error(MIC_DENIED_MESSAGE);
  else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') e = new Error(MIC_NOT_FOUND_MESSAGE);
  else if (name === 'NotReadableError' || name === 'TrackStartError') e = new Error('マイクを開けません。他のアプリが使用中の可能性があります');
  else e = new Error('録音を開始できません');
  e.cause = err;
  return e;
}

/**
 * マイク録音を作る。start() はタップハンドラ内から呼ぶ（権限ダイアログと AudioContext のため）。
 * @param {object} [opts]
 * @param {(level: number) => void} [opts.onLevel] 0..1 の入力レベル（約 60ms ごと。AudioContext が無ければ呼ばれない）
 * @param {AudioContext} [opts.audioContext] UI がタップの同期区間で生成した AudioContext。渡された場合はレベル計測に使い、close しない
 * @param {object} [opts.env] テスト用 { navigator, MediaRecorder, AudioContext, performance, setInterval, clearInterval, isTypeSupported }
 */
export function createRecorder({ onLevel = null, audioContext = null, env = null } = {}) {
  const E = {
    navigator: env?.navigator ?? globalThis.navigator,
    MediaRecorder: env?.MediaRecorder ?? globalThis.MediaRecorder,
    AudioContext: env?.AudioContext ?? (globalThis.AudioContext || globalThis.webkitAudioContext),
    performance: env?.performance ?? globalThis.performance,
    setInterval: env?.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms)),
    clearInterval: env?.clearInterval ?? ((id) => globalThis.clearInterval(id)),
    isTypeSupported: env?.isTypeSupported ?? null,
  };
  const now = () => (E.performance && typeof E.performance.now === 'function' ? E.performance.now() : Date.now());

  let stream = null;
  let recorder = null;
  let chunks = [];
  let mimeType = '';
  let startedAt = 0;
  let audioCtx = null;
  let ownsCtx = false;      // 自分で new した AudioContext だけ close する
  let levelTimer = null;
  let state = 'inactive';   // 'inactive' | 'requesting' | 'recording'
  let requestSeq = 0;       // getUserMedia 待ち中の cancel() 検知用

  function startLevelMeter(mediaStream) {
    if (typeof onLevel !== 'function') return;
    const external = audioContext && typeof audioContext.createMediaStreamSource === 'function';
    if (!external && typeof E.AudioContext !== 'function') return;
    try {
      if (external) {
        audioCtx = audioContext;
        ownsCtx = false;
      } else {
        audioCtx = new E.AudioContext();
        ownsCtx = true;
      }
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);   // destination には繋がない（ハウリング防止）
      const buf = new Uint8Array(analyser.fftSize);
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        try { const r = audioCtx.resume(); if (r && r.catch) r.catch(() => {}); } catch { /* 無視 */ }
      }
      levelTimer = E.setInterval(() => {
        try {
          analyser.getByteTimeDomainData(buf);
          onLevel(computeLevel(buf));
        } catch { /* 無視 */ }
      }, LEVEL_INTERVAL_MS);
    } catch {
      if (ownsCtx && audioCtx) { try { const r = audioCtx.close(); if (r && r.catch) r.catch(() => {}); } catch { /* 無視 */ } }
      audioCtx = null;   // AudioContext が無い / 失敗 → レベル表示は省略
      ownsCtx = false;
    }
  }

  function stopLevelMeter() {
    if (levelTimer != null) { E.clearInterval(levelTimer); levelTimer = null; }
    if (audioCtx) {
      if (ownsCtx) {
        try { const r = audioCtx.close(); if (r && r.catch) r.catch(() => {}); } catch { /* 無視 */ }
      }
      audioCtx = null;
      ownsCtx = false;
    }
  }

  function stopTracks(mediaStream) {
    if (!mediaStream) return;
    try { for (const track of mediaStream.getTracks()) track.stop(); } catch { /* 無視 */ }
  }

  function releaseStream() {
    if (stream) {
      stopTracks(stream);
      stream = null;
    }
  }

  function cleanup() {
    stopLevelMeter();
    releaseStream();
    recorder = null;
    state = 'inactive';
  }

  return {
    get state() { return state; },
    get mimeType() { return mimeType; },

    /**
     * 権限取得 → MediaRecorder.start()。権限拒否は日本語メッセージの Error で reject。
     * getUserMedia 待ち中に cancel()/stop() されたら、取得した track を止めて reject する（マイクを掴んだままにしない）。
     */
    async start() {
      if (state === 'recording' || state === 'requesting') return;
      const nav = E.navigator;
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || typeof E.MediaRecorder !== 'function') {
        throw new Error(RECORDER_UNSUPPORTED_MESSAGE);
      }
      const seq = ++requestSeq;
      state = 'requesting';
      let got;
      try {
        got = await nav.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (seq === requestSeq) state = 'inactive';
        throw userMediaErrorToError(err);
      }
      if (seq !== requestSeq || state !== 'requesting') {
        // 待っている間に cancel()/stop() された
        stopTracks(got);
        throw new Error('録音を中止しました');
      }
      stream = got;
      const isSupported = E.isTypeSupported
        || ((type) => typeof E.MediaRecorder.isTypeSupported === 'function' && E.MediaRecorder.isTypeSupported(type));
      mimeType = pickMimeType(isSupported);
      chunks = [];
      try {
        recorder = mimeType ? new E.MediaRecorder(stream, { mimeType }) : new E.MediaRecorder(stream);
      } catch (err) {
        releaseStream();
        state = 'inactive';
        const e = new Error('録音を開始できません');
        e.cause = err;
        throw e;
      }
      recorder.ondataavailable = (ev) => { if (ev && ev.data && ev.data.size > 0) chunks.push(ev.data); };
      try {
        recorder.start();   // timeslice なし（Safari の audio/mp4 は分割チャンクが不安定なため）
      } catch (err) {
        recorder = null;
        releaseStream();
        state = 'inactive';
        const e = new Error('録音を開始できません');
        e.cause = err;
        throw e;
      }
      startedAt = now();
      state = 'recording';
      startLevelMeter(stream);
    },

    /** 停止して { blob, mimeType, duration(秒) } を返す。track は停止する */
    stop() {
      if (!recorder || state !== 'recording') {
        // getUserMedia 待ち中なら、解決後に start() 側が track を止める
        requestSeq++;
        cleanup();
        return Promise.reject(new Error('録音していません'));
      }
      const rec = recorder;
      return new Promise((resolve, reject) => {
        const finish = () => {
          const duration = Math.max(0, (now() - startedAt) / 1000);
          const type = rec.mimeType || mimeType || (chunks[0] && chunks[0].type) || '';
          let blob;
          try {
            blob = new Blob(chunks, type ? { type } : undefined);
          } catch (err) {
            cleanup();
            reject(err);
            return;
          }
          cleanup();
          resolve({ blob, mimeType: type, duration });
        };
        rec.onstop = finish;
        rec.onerror = (ev) => {
          cleanup();
          const e = new Error('録音中にエラーが発生しました');
          e.cause = ev && (ev.error || ev);
          reject(e);
        };
        try {
          if (rec.state === 'inactive') finish();
          else rec.stop();
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
    },

    /** 結果を捨てて停止。getUserMedia 待ち中でも有効（解決後に track を止めて start() を reject する） */
    cancel() {
      requestSeq++;
      const rec = recorder;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        try { if (rec.state !== 'inactive') rec.stop(); } catch { /* 無視 */ }
      }
      chunks = [];
      cleanup();
    },
  };
}

/** 時間領域データ（0..255、128 が無音）から 0..1 のレベルを計算する（RMS、見た目用にやや強調） */
export function computeLevel(timeDomainBytes) {
  const n = timeDomainBytes.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (timeDomainBytes[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return Math.min(1, rms * 3);
}
