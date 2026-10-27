/**
 * 統一プレイヤー（イントロどん 音声担当）
 * - 音源種別（youtube / local）ごとの adapter を切り替え、N 秒だけ再生して自動停止する。
 * - UI は createPlayer() が返す Player だけを使い、adapter の存在を意識しない。
 * - 停止タイマーは「実際に再生が始まった瞬間」（YouTube: PLAYING 状態 / local: playing イベント）から数え、
 *   バッファ待ちの時間を含めない。進捗は約 100ms ごとに onStateChange('playing', {...}) で通知する。
 * - 再生開始が PLAY_START_TIMEOUT_MS（4 秒）以内に来なければ watchdog が 'error' にする（iOS で iframe の
 *   playVideo() が黙って無視された場合などに、UI が「再生中」のまま固まらないようにする）。
 * - DOM / window はトップレベルで参照しない（Node のテストで import しても落ちない）。
 */
import { createYouTubeAdapter } from './youtube.mjs';
import { createLocalAdapter } from './local.mjs';

/** Player.state が取りうる値 */
export const STATES = ['idle', 'loading', 'ready', 'warming', 'playing', 'error', 'none'];

/** 進捗通知の間隔（ms） */
export const PROGRESS_INTERVAL_MS = 100;

/** play() から再生開始（PLAYING / playing イベント）までの待ち時間の上限（ms）。超えたら 'error' */
export const PLAY_START_TIMEOUT_MS = 4000;

/** watchdog が発火したときのメッセージ（UI はこの文言をそのまま表示してよい） */
export const PLAY_START_TIMEOUT_MESSAGE = '再生が始まりませんでした。動画枠の中央を1回タップしてから、もう一度「どん！」を押してください';

/** 既定の adapter ファクトリ（テストではフェイクに差し替える） */
export const DEFAULT_ADAPTERS = {
  youtube: (hooks, ctx) => createYouTubeAdapter({ mountEl: ctx.youtubeMount, ...hooks }),
  local: (hooks, ctx) => createLocalAdapter({ getAudio: ctx.getAudio, ...hooks }),
};

// ---------------------------------------------------------------------------
// 純粋関数（テスト対象）
// ---------------------------------------------------------------------------

/**
 * 停止予定時刻（ms）を計算する。
 * @param {number} nowMs 現在時刻（performance.now() 基準）
 * @param {number} seconds 再生秒数
 */
export function computeStopAt(nowMs, seconds) {
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) throw new TypeError('seconds は正の数で指定してください');
  return nowMs + sec * 1000;
}

/**
 * 経過 / 残り時間（ms）を計算する。残りは 0 未満にならず、経過は全体を超えない。
 * @returns {{ elapsedMs: number, remainingMs: number }}
 */
export function computeProgress(nowMs, startedAtMs, stopAtMs) {
  const total = Math.max(0, stopAtMs - startedAtMs);
  const elapsed = Math.min(total, Math.max(0, nowMs - startedAtMs));
  const remaining = Math.max(0, stopAtMs - nowMs);
  return { elapsedMs: Math.round(elapsed), remainingMs: Math.round(remaining) };
}

/**
 * 音声の再生位置（秒）から「もう止めるべきか」を判定する（local の timeupdate 用）。
 * setTimeout が遅延した場合の保険。toleranceSec ぶん早めに止めてもよい。
 */
export function shouldStopByTime(currentTimeSec, startSec, seconds, toleranceSec = 0) {
  if (!Number.isFinite(currentTimeSec)) return false;
  return currentTimeSec >= startSec + seconds - toleranceSec;
}

/** 任意の値を日本語メッセージ付きの Error に揃える */
export function toError(err, fallbackMessage = '音源を再生できません') {
  if (err instanceof Error) return err;
  const e = new Error(typeof err === 'string' && err ? err : fallbackMessage);
  e.cause = err;
  return e;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/** 既定のタイマー群（テストで差し替え可能にするため一か所にまとめる） */
function defaultTimers() {
  return {
    now: () => (globalThis.performance && typeof globalThis.performance.now === 'function'
      ? globalThis.performance.now()
      : Date.now()),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  };
}

/**
 * 統一プレイヤーを作る。
 * @param {object} opts
 * @param {HTMLElement} [opts.youtubeMount] YouTube iframe を描画する要素（UI が不透明オーバーレイで覆う）
 * @param {(state: string, detail: object) => void} [opts.onStateChange] 状態 / 進捗通知
 * @param {(blobId: string) => Promise<{blob: Blob, mimeType?: string}>} [opts.getAudio] local 音源の取得（storage への依存を注入）
 * @param {object} [opts.adapters] adapter ファクトリ（テスト用）
 * @param {object} [opts.timers] タイマー群（テスト用）
 */
export function createPlayer({ youtubeMount = null, onStateChange = null, getAudio = null, adapters = DEFAULT_ADAPTERS, timers = null } = {}) {
  const t = { ...defaultTimers(), ...(timers || {}) };
  const ctx = { youtubeMount, getAudio };

  let state = 'idle';
  let kind = 'none';
  let lastError = null;
  let adapter = null;            // 現在の音源の adapter
  const cache = {};              // 種別ごとに 1 つだけ作って使い回す（<audio> や iframe を増やさない）
  let prepareToken = 0;          // prepare の競合（連打・問題スキップ）対策
  let run = null;                // 再生中の情報 { start, seconds, counting, startedAt, stopAt, timeoutId, intervalId, watchdogId, resolve }

  function emit(next, detail = {}) {
    state = next;
    if (typeof onStateChange === 'function') {
      try { onStateChange(next, detail); } catch { /* UI 側の例外でプレイヤーを壊さない */ }
    }
  }

  /**
   * 再生タイマーを片付ける。再生開始前に resolve 待ちの play() Promise があれば `value` で解決する
   * （再生開始後なら startCounting() が true で解決済み）。
   * - 手動 stop() / prepare() / destroy() / 再 play() による中断 … null（既定）
   * - watchdog / エラー … false
   */
  function clearRun(value = null) {
    if (!run) return;
    if (run.timeoutId != null) t.clearTimeout(run.timeoutId);
    if (run.intervalId != null) t.clearInterval(run.intervalId);
    if (run.watchdogId != null) t.clearTimeout(run.watchdogId);
    const { resolve } = run;
    run = null;
    if (resolve) resolve(value);
  }

  function fail(err) {
    lastError = toError(err);
    clearRun(false);
    if (adapter) { try { adapter.stop(); } catch { /* 無視 */ } }
    emit('error', { error: lastError });
  }

  /** 自動停止・手動停止の共通処理 */
  function finish() {
    if (!run) return;
    clearRun();
    if (adapter) { try { adapter.stop(); } catch (e) { fail(e); return; } }
    emit('ready', {});
  }

  function tick() {
    if (!run || !run.counting) return;
    const p = computeProgress(t.now(), run.startedAt, run.stopAt);
    if (p.remainingMs <= 0) { finish(); return; }
    emit('playing', p);
  }

  /** 実際に音が出始めたところからカウント開始（バッファ待ちは含めない） */
  function startCounting() {
    if (!run || run.counting) return;
    const now = t.now();
    if (run.watchdogId != null) { t.clearTimeout(run.watchdogId); run.watchdogId = null; }
    run.counting = true;
    run.startedAt = now;
    run.stopAt = computeStopAt(now, run.seconds);
    run.timeoutId = t.setTimeout(finish, run.stopAt - now);
    run.intervalId = t.setInterval(tick, PROGRESS_INTERVAL_MS);
    const resolve = run.resolve;
    run.resolve = null;
    tick();
    if (resolve) resolve(true);
  }

  // adapter から呼ばれるフック
  const hooks = {
    onPlaying() { startCounting(); },
    onTimeUpdate(currentTimeSec) {
      // setTimeout が遅延（バックグラウンド等）しても再生位置で止める保険
      if (run && run.counting && shouldStopByTime(currentTimeSec, run.start, run.seconds)) finish();
    },
    onEnded() { if (run) finish(); },      // 音源が seconds より短かった
    onError(err) { fail(err); },
  };

  function getAdapter(type) {
    if (!cache[type]) {
      const factory = adapters[type];
      if (typeof factory !== 'function') return null;
      cache[type] = factory(hooks, ctx);
    }
    return cache[type];
  }

  const player = {
    /**
     * 問題遷移時に呼ぶ。youtube: cueVideoById、local: getAudio → ObjectURL。
     * source が null なら 'none'（別アプリで再生モード）。
     */
    async prepare(source) {
      const token = ++prepareToken;
      clearRun();
      if (adapter) {
        if (typeof adapter.cancelWarmUp === 'function') { try { adapter.cancelWarmUp(); } catch { /* 無視 */ } }
        try { adapter.stop(); } catch { /* 無視 */ }
      }
      lastError = null;

      if (!source) {
        if (adapter && typeof adapter.release === 'function') { try { adapter.release(); } catch { /* 無視 */ } }
        adapter = null;
        kind = 'none';
        emit('none', {});
        return;
      }
      const type = source.type;
      const next = getAdapter(type);
      if (!next) {
        adapter = null;
        kind = 'none';
        fail(new Error(`未対応の音源種別です: ${String(type)}`));
        return;
      }
      if (adapter && adapter !== next && typeof adapter.release === 'function') {
        // 別種別に切り替える：前の adapter が掴んでいる ObjectURL 等を手放す
        try { adapter.release(); } catch { /* 無視 */ }
      }
      adapter = next;
      kind = type;
      emit('loading', {});
      try {
        await adapter.prepare(source);
        if (token !== prepareToken) return;   // 途中で別の prepare が走った
        emit('ready', {});
      } catch (e) {
        if (token !== prepareToken) return;
        fail(e);
      }
    },

    /**
     * 必ずユーザー操作（タップ）ハンドラ内から同期的に呼ぶこと（iOS 対策）。
     * 内部で await せずに adapter.play() を即座に呼ぶ。seconds 後に自動停止。
     * 戻り値（reject しない。エラーは onStateChange('error') で通知）:
     *   true  … 実際に再生が始まった
     *   false … 始まらなかった（watchdog / エラー / 準備できていない）
     *   null  … 始まる前に stop() / prepare() / destroy() / 再 play() で中断された（エラーではない）
     */
    play({ start = 0, seconds } = {}) {
      if (state === 'warming') { player.cancelWarmUp(); state = 'ready'; }
      if (!adapter || (state !== 'ready' && state !== 'playing')) {
        return Promise.resolve(false);
      }
      const sec = Number(seconds);
      if (!Number.isFinite(sec) || sec <= 0) {
        fail(new TypeError('再生秒数が不正です'));
        return Promise.resolve(false);
      }
      const startSec = Math.max(0, Number(start) || 0);

      // 再生中に呼ばれたら最初から再生し直す
      if (run) {
        clearRun();
        try { adapter.stop(); } catch { /* 無視 */ }
      }

      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      run = { start: startSec, seconds: sec, counting: false, startedAt: 0, stopAt: 0, timeoutId: null, intervalId: null, watchdogId: null, resolve };
      // watchdog：PLAY_START_TIMEOUT_MS 以内に再生開始が来なければ error（clearRun で必ず clear される）
      run.watchdogId = t.setTimeout(() => {
        if (!run || run.counting) return;
        run.watchdogId = null;
        fail(new Error(PLAY_START_TIMEOUT_MESSAGE));
      }, PLAY_START_TIMEOUT_MS);
      emit('playing', { remainingMs: Math.round(sec * 1000), elapsedMs: 0, buffering: true });
      try {
        adapter.play({ start: startSec });   // ← 同期呼び出し（iOS の自動再生制限を通す）
      } catch (e) {
        fail(e);
      }
      return promise;
    },

    /** 手動停止（「ストップ」）。再生していなければ何もしない */
    stop() {
      if (!run) return;
      finish();
    },

    /**
     * 初回タップで呼ぶ。local 用 <audio> を無音再生して iOS のオーディオを解放する。
     * 失敗は握りつぶす（state は変えない）。
     */
    unlock() {
      for (const type of Object.keys(adapters)) {
        try {
          const a = getAdapter(type);
          if (a && typeof a.unlock === 'function') {
            const r = a.unlock();
            if (r && typeof r.catch === 'function') r.catch(() => {});
          }
        } catch { /* 無視 */ }
      }
    },

    /** 現在の adapter が暖機（iOS 向け：iframe の直接タップ）を必要としているか */
    get needsWarmUp() {
      return !!(adapter && typeof adapter.needsWarmUp === 'function' && adapter.needsWarmUp());
    },

    /**
     * 暖機を開始する（YouTube のみ）。'warming' を通知し、利用者が iframe をタップして
     * 再生→即停止できたら 'ready' に戻して true で解決する。中断・非対応は false。
     */
    async armWarmUp({ start = 0 } = {}) {
      if (!adapter || typeof adapter.armWarmUp !== 'function' || state !== 'ready') return false;
      const token = prepareToken;
      emit('warming', {});
      let ok = false;
      try { ok = await adapter.armWarmUp({ start }); } catch { ok = false; }
      if (token !== prepareToken) return false;      // 途中で別の問題に移った
      if (state === 'warming') emit('ready', {});
      return ok;
    },

    cancelWarmUp() {
      if (adapter && typeof adapter.cancelWarmUp === 'function') adapter.cancelWarmUp();
    },

    skipWarmUp() {
      if (adapter && typeof adapter.markWarmed === 'function') adapter.markWarmed();
    },

    /**
     * 暖機からやり直せる状態に戻す（watchdog で再生が始まらなかったときの復帰用）。
     * 現在の adapter が「暖機済み」と判断している（needsWarmUp() が false。暖機をスキップした後など）場合は
     * その adapter を破棄して作り直し対象にする（iframe も作り直される）。戻り値は作り直したか。
     * いずれの場合も呼び出し側はこの後 prepare() し直すこと。
     */
    resetWarmUp() {
      if (!adapter || typeof adapter.needsWarmUp !== 'function') return false;
      let needs = true;
      try { needs = !!adapter.needsWarmUp(); } catch { needs = true; }
      if (needs) return false;
      prepareToken++;
      clearRun();
      const type = kind;
      try { adapter.destroy(); } catch { /* 無視 */ }
      if (cache[type] === adapter) delete cache[type];
      adapter = null;
      kind = 'none';
      state = 'idle';
      lastError = null;
      return true;
    },

    get state() { return state; },
    get kind() { return kind; },
    get lastError() { return lastError; },

    destroy() {
      prepareToken++;
      clearRun();
      for (const type of Object.keys(cache)) {
        try { cache[type].destroy(); } catch { /* 無視 */ }
        delete cache[type];
      }
      adapter = null;
      kind = 'none';
      state = 'idle';
    },
  };

  return player;
}
