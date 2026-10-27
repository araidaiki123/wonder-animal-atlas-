/**
 * 音声モジュールのテスト（node --test）。
 * DOM / YouTube API はフェイクで置き換え、タイマー計算・状態遷移・mimeType 選択・
 * API ロードのタイムアウト / オフライン処理などを検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlayer, computeStopAt, computeProgress, shouldStopByTime, toError, PROGRESS_INTERVAL_MS,
  PLAY_START_TIMEOUT_MS, PLAY_START_TIMEOUT_MESSAGE,
} from '../src/audio/player.mjs';
import {
  loadYouTubeApi, createYouTubeAdapter, youtubeErrorMessage, PlayerState,
  YT_LOAD_ERROR_MESSAGE, YT_API_URL,
} from '../src/audio/youtube.mjs';
import {
  pickMimeType, MIME_CANDIDATES, makeSilentWavDataUrl, createLocalAdapter, createRecorder,
  computeLevel, MIC_DENIED_MESSAGE,
} from '../src/audio/local.mjs';

// ---------------------------------------------------------------------------
// テスト用ユーティリティ
// ---------------------------------------------------------------------------

/** 手動で進められるフェイクタイマー（player.mjs の timers / youtube.mjs の env に渡す） */
function fakeTimers() {
  let now = 1000;
  let seq = 0;
  const timeouts = new Map();   // id -> { at, fn }
  const intervals = new Map();  // id -> { next, every, fn }
  const api = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { next: now + ms, every: ms, fn }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    /** ms だけ時間を進め、期限が来たタイマーを時刻順に実行 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let best = null;
        for (const [id, t] of timeouts) if (t.at <= target && (!best || t.at < best.at)) best = { id, at: t.at, fn: t.fn, kind: 'timeout' };
        for (const [id, t] of intervals) if (t.next <= target && (!best || t.next < best.at)) best = { id, at: t.next, fn: t.fn, kind: 'interval' };
        if (!best) break;
        now = best.at;
        if (best.kind === 'timeout') timeouts.delete(best.id);
        else { const t = intervals.get(best.id); if (t) t.next += t.every; }
        best.fn();
      }
      now = target;
    },
    pendingCount: () => timeouts.size + intervals.size,
  };
  return api;
}

/** 最小限のイベントターゲット（<audio> や document のフェイク用） */
class FakeEventTarget {
  constructor() { this._l = new Map(); }
  addEventListener(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); }
  removeEventListener(ev, fn) { this._l.get(ev)?.delete(fn); }
  dispatch(ev) { for (const fn of [...(this._l.get(ev) || [])]) fn({ type: ev, target: this }); }
}

/** <audio> のフェイク */
class FakeAudio extends FakeEventTarget {
  constructor() {
    super();
    this.src = '';
    this.currentTime = 0;
    this.paused = true;
    this.attrs = {};
    this.calls = [];
    this.style = {};
    this.playResult = 'resolve';   // 'resolve' | 'reject-notallowed'
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = ''; }
  load() { this.calls.push('load'); }
  play() {
    this.calls.push(`play@${this.currentTime}`);
    this.paused = false;
    if (this.playResult === 'reject-notallowed') {
      const e = new Error('NotAllowed'); e.name = 'NotAllowedError';
      return Promise.reject(e);
    }
    return Promise.resolve();
  }
  pause() { this.calls.push('pause'); this.paused = true; }
}

function fakeDocument(audio) {
  return {
    createElement(tag) {
      if (tag === 'audio') return audio || new FakeAudio();
      const el = new FakeEventTarget();
      el.tagName = tag.toUpperCase();
      el.children = [];
      el.parentNode = null;
      el.style = {};
      el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
      el.removeChild = (c) => { el.children = el.children.filter((x) => x !== c); c.parentNode = null; };
      return el;
    },
    querySelector() { return null; },
    head: null,
  };
}

/** player.mjs に注入するフェイク adapter。hooks を外から叩けるようにする */
function fakeAdapterFactory(log, opts = {}) {
  const instances = [];
  const factory = (hooks, ctx) => {
    const a = {
      kind: opts.kind || 'fake',
      hooks,
      ctx,
      prepared: null,
      destroyed: false,
      async prepare(source) {
        log.push(`prepare:${source.type}`);
        if (opts.prepareError) throw opts.prepareError;
        this.prepared = source;
      },
      play({ start }) { log.push(`play:${start}`); if (opts.playThrows) throw opts.playThrows; },
      stop() { log.push('stop'); },
      unlock() { log.push('unlock'); },
      release() { log.push(`release:${this.kind}`); },
      destroy() { log.push('destroy'); this.destroyed = true; },
    };
    instances.push(a);
    return a;
  };
  factory.instances = instances;
  return factory;
}

function makePlayer(opts = {}) {
  const log = [];
  const events = [];
  const timers = fakeTimers();
  const youtube = fakeAdapterFactory(log, { kind: 'youtube', ...(opts.youtube || {}) });
  const local = fakeAdapterFactory(log, { kind: 'local', ...(opts.local || {}) });
  const player = createPlayer({
    youtubeMount: { id: 'mount' },
    getAudio: opts.getAudio || (async () => ({ blob: {}, mimeType: 'audio/mp4' })),
    onStateChange: (s, d) => events.push([s, d]),
    adapters: { youtube, local },
    timers,
  });
  return { player, log, events, timers, youtube, local };
}

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

test('computeStopAt: 秒 → ms を足す / 不正値は例外', () => {
  assert.equal(computeStopAt(1000, 1.5), 2500);
  assert.equal(computeStopAt(0, 30), 30000);
  assert.throws(() => computeStopAt(0, 0), TypeError);
  assert.throws(() => computeStopAt(0, NaN), TypeError);
  assert.throws(() => computeStopAt(0, -1), TypeError);
});

test('computeProgress: 経過と残りを 0 以上に丸める', () => {
  assert.deepEqual(computeProgress(1000, 1000, 3000), { elapsedMs: 0, remainingMs: 2000 });
  assert.deepEqual(computeProgress(1500, 1000, 3000), { elapsedMs: 500, remainingMs: 1500 });
  assert.deepEqual(computeProgress(3000, 1000, 3000), { elapsedMs: 2000, remainingMs: 0 });
  assert.deepEqual(computeProgress(9999, 1000, 3000), { elapsedMs: 2000, remainingMs: 0 });
  assert.deepEqual(computeProgress(500, 1000, 3000), { elapsedMs: 0, remainingMs: 2500 });
  assert.deepEqual(computeProgress(1000.4, 1000, 1100.6), { elapsedMs: 0, remainingMs: 100 });
});

test('shouldStopByTime: 再生位置が start+seconds に達したら true', () => {
  assert.equal(shouldStopByTime(1.4, 0, 1.5), false);
  assert.equal(shouldStopByTime(1.5, 0, 1.5), true);
  assert.equal(shouldStopByTime(11.5, 10, 1.5), true);
  assert.equal(shouldStopByTime(11.0, 10, 1.5), false);
  assert.equal(shouldStopByTime(1.46, 0, 1.5, 0.05), true);
  assert.equal(shouldStopByTime(NaN, 0, 1.5), false);
});

test('toError: 文字列 / 任意値を日本語メッセージの Error にする', () => {
  const e = new Error('x');
  assert.equal(toError(e), e);
  assert.equal(toError('だめ').message, 'だめ');
  assert.equal(toError(undefined).message, '音源を再生できません');
  assert.equal(toError({ code: 1 }, '別のメッセージ').message, '別のメッセージ');
});

// ---------------------------------------------------------------------------
// local.mjs: mimeType / 無音 WAV / レベル
// ---------------------------------------------------------------------------

test('pickMimeType: audio/mp4 → webm;opus → webm → 既定("") の順', () => {
  assert.deepEqual(MIME_CANDIDATES, ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
  assert.equal(pickMimeType(() => true), 'audio/mp4');
  assert.equal(pickMimeType((t) => t.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(pickMimeType((t) => t === 'audio/webm'), 'audio/webm');
  assert.equal(pickMimeType(() => false), '');
  assert.equal(pickMimeType(() => { throw new Error('old browser'); }), '');
});

test('pickMimeType: 既定の isTypeSupported は MediaRecorder が無い環境でも落ちない', () => {
  assert.equal(pickMimeType(), '');
});

test('makeSilentWavDataUrl: RIFF/WAVE ヘッダ付きの無音 data URL', () => {
  const url = makeSilentWavDataUrl();
  assert.ok(url.startsWith('data:audio/wav;base64,'));
  const bytes = Buffer.from(url.slice('data:audio/wav;base64,'.length), 'base64');
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
  assert.equal(bytes.toString('latin1', 8, 12), 'WAVE');
  assert.equal(bytes.toString('latin1', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  assert.ok(bytes.subarray(44).every((b) => b === 128));
});

test('computeLevel: 無音は 0、フルスイングは 1 に飽和', () => {
  assert.equal(computeLevel(new Uint8Array(0)), 0);
  assert.equal(computeLevel(new Uint8Array(64).fill(128)), 0);
  const loud = new Uint8Array(64); for (let i = 0; i < 64; i++) loud[i] = i % 2 ? 255 : 1;
  assert.equal(computeLevel(loud), 1);
  const quiet = new Uint8Array(64); for (let i = 0; i < 64; i++) quiet[i] = i % 2 ? 136 : 120;
  const lv = computeLevel(quiet);
  assert.ok(lv > 0 && lv < 0.5, String(lv));
});

// ---------------------------------------------------------------------------
// local.mjs: adapter
// ---------------------------------------------------------------------------

function makeLocal(opts = {}) {
  const audio = new FakeAudio();
  const timers = fakeTimers();
  const urls = { created: [], revoked: [] };
  const URL = {
    createObjectURL: (blob) => { const u = `blob:fake/${urls.created.length + 1}`; urls.created.push([u, blob]); return u; },
    revokeObjectURL: (u) => urls.revoked.push(u),
  };
  const events = [];
  const adapter = createLocalAdapter({
    getAudio: opts.getAudio || (async (id) => ({ blob: { id }, mimeType: 'audio/mp4' })),
    onPlaying: () => events.push('playing'),
    onTimeUpdate: (t) => events.push(`time:${t}`),
    onEnded: () => events.push('ended'),
    onError: (e) => events.push(`error:${e.message}`),
    env: { document: fakeDocument(audio), URL, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    loadTimeoutMs: 3000,
  });
  return { adapter, audio, timers, urls, events };
}

test('local adapter: <audio> は playsinline / preload=auto で 1 要素だけ作る', async () => {
  const { adapter, audio } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  assert.equal(adapter.getElement(), audio);
  assert.ok('playsinline' in audio.attrs);
  assert.equal(audio.playsInline, true);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.src, 'blob:fake/1');
});

test('local adapter: prepare は getAudio → createObjectURL、前の ObjectURL を revoke', async () => {
  const { adapter, audio, urls } = makeLocal();
  let p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('canplay');
  await p;
  assert.deepEqual(urls.revoked, []);
  p = adapter.prepare({ type: 'local', blobId: 'b2' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  assert.deepEqual(urls.revoked, ['blob:fake/1']);
  assert.equal(audio.src, 'blob:fake/2');
  assert.equal(urls.created[1][1].id, 'b2');
});

test('local adapter: メタデータが来なくてもタイムアウトで ready 扱い（iOS はタップ前に読み込まない）', async () => {
  const { adapter, timers } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  timers.advance(3000);
  await p; // 解決すること
});

test('local adapter: getAudio が空を返したら日本語エラー、error イベントも reject', async () => {
  const a = makeLocal({ getAudio: async () => null });
  await assert.rejects(a.adapter.prepare({ type: 'local', blobId: 'b1' }), /音源データが見つかりません/);

  const b = makeLocal();
  const p = b.adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  b.audio.error = { code: 4 };
  b.audio.dispatch('error');
  await assert.rejects(p, /この形式の音源はこの端末では再生できません/);
});

test('local adapter: play は currentTime=start して同期的に play()、stop は pause()', async () => {
  const { adapter, audio, events } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  audio.calls.length = 0;
  adapter.play({ start: 2.5 });
  assert.deepEqual(audio.calls, ['play@2.5']);   // await なしで呼ばれている
  audio.dispatch('playing');
  audio.currentTime = 3.1;
  audio.dispatch('timeupdate');
  adapter.stop();
  assert.deepEqual(audio.calls, ['play@2.5', 'pause']);
  assert.deepEqual(events, ['playing', 'time:3.1']);
});

test('local adapter: play() の拒否（NotAllowedError）は日本語メッセージで onError', async () => {
  const { adapter, audio, events } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  audio.playResult = 'reject-notallowed';
  adapter.play({ start: 0 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.length, 1);
  assert.match(events[0], /^error:再生がブロックされました/);
});

test('local adapter: unlock は無音 WAV を play→pause し、終わったら src を外す', async () => {
  const { adapter, audio, events } = makeLocal();
  await adapter.unlock();
  assert.deepEqual(audio.calls, ['play@0', 'pause', 'load']);
  assert.equal(audio.src, '');
  assert.deepEqual(events, []);   // unlock 中のイベントは通知しない
});

test('local adapter: unlock 中に prepare が src を設定したら消さない', async () => {
  const { adapter, audio } = makeLocal();
  const u = adapter.unlock();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await Promise.all([u, p]);
  assert.equal(audio.src, 'blob:fake/1');
});

test('local adapter: 準備済みなら unlock は src を変えずに play→pause、失敗しても例外を出さない', async () => {
  const { adapter, audio } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  audio.calls.length = 0;
  audio.playResult = 'reject-notallowed';
  await adapter.unlock();
  assert.deepEqual(audio.calls, ['play@0', 'pause']);
  assert.equal(audio.src, 'blob:fake/1');
});

test('local adapter: destroy で pause / revoke / src 解除', async () => {
  const { adapter, audio, urls } = makeLocal();
  const p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  adapter.destroy();
  assert.deepEqual(urls.revoked, ['blob:fake/1']);
  assert.equal(audio.src, '');
  assert.equal(adapter.getElement(), null);
  await assert.rejects(adapter.prepare({ type: 'local', blobId: 'b2' }), /破棄/);
});

test('local adapter: release は revoke + src 解除、要素は残して次の prepare で再利用できる', async () => {
  const { adapter, audio, urls } = makeLocal();
  let p = adapter.prepare({ type: 'local', blobId: 'b1' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  audio.calls.length = 0;
  adapter.release();
  assert.deepEqual(urls.revoked, ['blob:fake/1']);
  assert.equal(audio.src, '');
  assert.deepEqual(audio.calls, ['pause', 'load']);
  assert.equal(adapter.getElement(), audio);
  assert.throws(() => adapter.play({ start: 0 }), /準備ができていません/);
  // 2 回呼んでも revoke は重複しない
  adapter.release();
  assert.deepEqual(urls.revoked, ['blob:fake/1']);
  p = adapter.prepare({ type: 'local', blobId: 'b2' });
  await Promise.resolve(); await Promise.resolve();
  audio.dispatch('loadedmetadata');
  await p;
  assert.equal(audio.src, 'blob:fake/2');
});

// ---------------------------------------------------------------------------
// local.mjs: recorder
// ---------------------------------------------------------------------------

class FakeMediaRecorder {
  static created = [];
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType || 'audio/fake';
    this.state = 'inactive';
    FakeMediaRecorder.created.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: { size: 3, type: this.mimeType } });
    this.onstop?.();
  }
}

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks };
}

function makeRecorder(opts = {}) {
  const timers = fakeTimers();
  let now = 0;
  const levels = [];
  const stream = fakeStream();
  const ctxLog = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; ctxLog.push('new'); }
    createMediaStreamSource() { return { connect: () => ctxLog.push('connect') }; }
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: (buf) => buf.fill(opts.sample ?? 128) }; }
    close() { ctxLog.push('close'); return Promise.resolve(); }
  }
  const recorder = createRecorder({
    onLevel: (v) => levels.push(v),
    audioContext: opts.audioContext || null,
    env: {
      navigator: { mediaDevices: { getUserMedia: opts.getUserMedia || (async () => stream) } },
      MediaRecorder: FakeMediaRecorder,
      AudioContext: opts.noAudioContext ? undefined : FakeAudioContext,
      performance: { now: () => now },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isTypeSupported: opts.isTypeSupported || ((t) => t === 'audio/mp4'),
    },
  });
  return { recorder, timers, levels, stream, ctxLog, FakeAudioContext, setNow: (v) => { now = v; } };
}

test('createRecorder: start → stop で { blob, mimeType, duration } を返し track を止める', async () => {
  FakeMediaRecorder.created.length = 0;
  const { recorder, stream, setNow, timers, levels, ctxLog } = makeRecorder();
  await recorder.start();
  assert.equal(recorder.state, 'recording');
  assert.deepEqual(FakeMediaRecorder.created[0].options, { mimeType: 'audio/mp4' });
  timers.advance(180);
  assert.equal(levels.length, 3);       // 約 60ms ごと
  assert.equal(levels[0], 0);           // 無音
  setNow(2345);
  const result = await recorder.stop();
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(result.duration, 2.345);
  assert.ok(result.blob instanceof Blob);
  assert.equal(result.blob.type, 'audio/mp4');
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(recorder.state, 'inactive');
  assert.deepEqual(ctxLog, ['new', 'connect', 'close']);
  assert.equal(timers.pendingCount(), 0);
});

test('createRecorder: 権限拒否は日本語メッセージで reject', async () => {
  const denied = new Error('denied'); denied.name = 'NotAllowedError';
  const { recorder } = makeRecorder({ getUserMedia: async () => { throw denied; } });
  await assert.rejects(recorder.start(), (e) => e.message === MIC_DENIED_MESSAGE && e.cause === denied);
  const notFound = new Error('nf'); notFound.name = 'NotFoundError';
  const r2 = makeRecorder({ getUserMedia: async () => { throw notFound; } });
  await assert.rejects(r2.recorder.start(), /マイクが見つかりません/);
});

test('createRecorder: AudioContext が無ければレベル通知を省略、mimeType 非対応なら既定で作る', async () => {
  FakeMediaRecorder.created.length = 0;
  const { recorder, timers, levels } = makeRecorder({ noAudioContext: true, isTypeSupported: () => false });
  await recorder.start();
  timers.advance(500);
  assert.deepEqual(levels, []);
  assert.equal(FakeMediaRecorder.created[0].options, undefined);
  const r = await recorder.stop();
  assert.equal(r.mimeType, 'audio/fake'); // recorder.mimeType を採用
});

test('createRecorder: 録音していない時の stop は reject、cancel は結果を捨てる', async () => {
  const { recorder, stream } = makeRecorder();
  await assert.rejects(recorder.stop(), /録音していません/);
  await recorder.start();
  recorder.cancel();
  assert.equal(recorder.state, 'inactive');
  assert.equal(stream.tracks[0].stopped, true);
});

test('createRecorder: 非対応環境では日本語エラー', async () => {
  const recorder = createRecorder({ env: { navigator: {}, MediaRecorder: undefined } });
  await assert.rejects(recorder.start(), /このブラウザは録音に対応していません/);
});

test('createRecorder: getUserMedia 待ち中の cancel() は解決後に track を止めて start() を reject', async () => {
  let resolveMedia;
  const stream = fakeStream();
  const { recorder } = makeRecorder({ getUserMedia: () => new Promise((r) => { resolveMedia = r; }) });
  const p = recorder.start();
  await Promise.resolve();
  assert.equal(recorder.state, 'requesting');
  recorder.cancel();
  assert.equal(recorder.state, 'inactive');
  resolveMedia(stream);
  await assert.rejects(p, /録音を中止しました/);
  assert.equal(stream.tracks[0].stopped, true, 'マイクが解放される');
  assert.equal(recorder.state, 'inactive');
  // その後の start() は普通に動く
  const again = makeRecorder();
  await again.recorder.start();
  assert.equal(again.recorder.state, 'recording');
  again.recorder.cancel();
});

test('createRecorder: getUserMedia 待ち中の stop() も同様にマイクを解放する', async () => {
  let resolveMedia;
  const stream = fakeStream();
  const { recorder } = makeRecorder({ getUserMedia: () => new Promise((r) => { resolveMedia = r; }) });
  const p = recorder.start();
  await assert.rejects(recorder.stop(), /録音していません/);
  resolveMedia(stream);
  await assert.rejects(p, /録音を中止しました/);
  assert.equal(stream.tracks[0].stopped, true);
});

test('createRecorder: recorder.start() が throw したら stream を解放して reject', async () => {
  class ThrowingRecorder extends FakeMediaRecorder {
    start() { throw new Error('boom'); }
  }
  const stream = fakeStream();
  const recorder = createRecorder({
    env: {
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
      MediaRecorder: ThrowingRecorder,
      isTypeSupported: () => true,
    },
  });
  await assert.rejects(recorder.start(), (e) => /録音を開始できません/.test(e.message) && e.cause.message === 'boom');
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(recorder.state, 'inactive');
  // MediaRecorder のコンストラクタが throw した場合も同様
  class BadCtor { constructor() { throw new Error('ctor'); } }
  const s2 = fakeStream();
  const r2 = createRecorder({ env: { navigator: { mediaDevices: { getUserMedia: async () => s2 } }, MediaRecorder: BadCtor, isTypeSupported: () => true } });
  await assert.rejects(r2.start(), /録音を開始できません/);
  assert.equal(s2.tracks[0].stopped, true);
});

test('createRecorder: 外から渡した audioContext を使い、close しない', async () => {
  const log = [];
  const external = {
    state: 'suspended',
    resume() { log.push('resume'); return Promise.resolve(); },
    createMediaStreamSource() { return { connect: () => log.push('connect') }; },
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: (buf) => buf.fill(128) }; },
    close() { log.push('close'); return Promise.resolve(); },
  };
  const { recorder, timers, levels, ctxLog } = makeRecorder({ audioContext: external });
  await recorder.start();
  timers.advance(120);
  assert.equal(levels.length, 2);
  await recorder.stop();
  assert.deepEqual(log, ['connect', 'resume']);   // close は呼ばれない
  assert.deepEqual(ctxLog, []);                     // 内部で new AudioContext しない
  assert.equal(timers.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// youtube.mjs: API ロード
// ---------------------------------------------------------------------------

function fakeWindow({ YT = null, onLine = true } = {}) {
  const scripts = [];
  const head = { children: [], appendChild(s) { this.children.push(s); s.parentNode = this; scripts.push(s); return s; }, removeChild(s) { this.children = this.children.filter((x) => x !== s); } };
  const win = { YT, location: { origin: 'https://example.test' } };
  const doc = { head, createElement: (tag) => ({ tagName: tag, parentNode: null }), querySelector: () => null };
  const timers = fakeTimers();
  const env = { window: win, document: doc, navigator: { onLine }, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  return { win, doc, env, timers, scripts };
}

test('loadYouTubeApi: window.YT があれば script を追加せず再利用', async () => {
  const YT = { Player: function Player() {} };
  const { env, scripts } = fakeWindow({ YT });
  assert.equal(await loadYouTubeApi({ env }), YT);
  assert.equal(scripts.length, 0);
});

test('loadYouTubeApi: オフラインは即 reject（日本語メッセージ）', async () => {
  const { env, scripts } = fakeWindow({ onLine: false });
  await assert.rejects(loadYouTubeApi({ env }), (e) => e.message === YT_LOAD_ERROR_MESSAGE);
  assert.equal(scripts.length, 0);
});

test('loadYouTubeApi: script を遅延ロードし onYouTubeIframeAPIReady で解決。同時呼び出しは 1 本にまとめる', async () => {
  const { win, env, scripts } = fakeWindow();
  const p1 = loadYouTubeApi({ env });
  const p2 = loadYouTubeApi({ env });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, YT_API_URL);
  assert.equal(scripts[0].async, true);
  const YT = { Player: function Player() {} };
  win.YT = YT;
  win.onYouTubeIframeAPIReady();
  assert.equal(await p1, YT);
  assert.equal(await p2, YT);
});

test('loadYouTubeApi: 8 秒で reject し、script を除去して再試行できる', async () => {
  const { win, env, timers, scripts, doc } = fakeWindow();
  const p = loadYouTubeApi({ env });
  timers.advance(7999);
  timers.advance(1);
  await assert.rejects(p, (e) => e.message === YT_LOAD_ERROR_MESSAGE);
  assert.equal(doc.head.children.length, 0);
  // 再試行 → 新しい script
  const p2 = loadYouTubeApi({ env });
  assert.equal(scripts.length, 2);
  win.YT = { Player: function Player() {} };
  timers.advance(200);   // ポーリングで検出
  assert.equal(await p2, win.YT);
});

test('loadYouTubeApi: script の onerror で reject、既存コールバックは連鎖して呼ぶ', async () => {
  const { win, env, scripts } = fakeWindow();
  let prevCalled = 0;
  win.onYouTubeIframeAPIReady = () => { prevCalled++; };
  const p = loadYouTubeApi({ env });
  scripts[0].onerror();
  await assert.rejects(p, (e) => e.message === YT_LOAD_ERROR_MESSAGE);

  const w2 = fakeWindow();
  w2.win.onYouTubeIframeAPIReady = () => { prevCalled++; };
  const p2 = loadYouTubeApi({ env: w2.env });
  w2.win.YT = { Player: function Player() {} };
  w2.win.onYouTubeIframeAPIReady();
  await p2;
  assert.equal(prevCalled, 1);
});

test('loadYouTubeApi: window が無い環境（Node）でも例外ではなく reject', async () => {
  await assert.rejects(loadYouTubeApi({ env: { window: undefined, document: undefined } }), (e) => e.message === YT_LOAD_ERROR_MESSAGE);
});

test('youtubeErrorMessage: 2/5/100/101/150 は日本語、未知のコードも日本語', () => {
  for (const c of [2, 5, 100, 101, 150]) assert.match(youtubeErrorMessage(c), /[ぁ-んァ-ン一-龥]/);
  assert.match(youtubeErrorMessage(999), /コード 999/);
});

// ---------------------------------------------------------------------------
// youtube.mjs: adapter（フェイク YT.Player）
// ---------------------------------------------------------------------------

function makeYouTubeAdapter(opts = {}) {
  const players = [];
  class FakeYTPlayer {
    constructor(el, config) {
      this.el = el; this.config = config; this.calls = [];
      this.iframe = { style: {} };
      players.push(this);
      if (!opts.manualReady) Promise.resolve().then(() => this.ready());
    }
    ready() { this.config.events.onReady({ target: this }); }
    state(s) { this.config.events.onStateChange({ data: s, target: this }); }
    error(code) { this.config.events.onError({ data: code, target: this }); }
    getIframe() { return this.iframe; }
    cueVideoById(arg) { this.calls.push(['cue', arg]); }
    seekTo(sec, ahead) { this.calls.push(['seekTo', sec, ahead]); }
    playVideo() { this.calls.push(['playVideo']); }
    pauseVideo() { this.calls.push(['pauseVideo']); }
    destroy() { this.calls.push(['destroy']); }
  }
  const YT = { Player: FakeYTPlayer, PlayerState };
  const { env, timers } = fakeWindow({ YT });
  const mount = fakeDocument().createElement('div');
  const events = [];
  const adapter = createYouTubeAdapter({
    mountEl: mount,
    onPlaying: () => events.push('playing'),
    onPaused: () => events.push('paused'),
    onEnded: () => events.push('ended'),
    onError: (e) => events.push(`error:${e.message}`),
    loadApi: opts.loadApi || (() => loadYouTubeApi({ env })),
    env,
  });
  return { adapter, players, mount, events, timers };
}

/** cue を自動で CUED にする prepare 補助 */
async function prepareYT(ctx, source) {
  const p = ctx.adapter.prepare(source);
  // loadApi → ensurePlayer(onReady) → cue まで microtask を進める
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const player = ctx.players[ctx.players.length - 1];
  player.state(PlayerState.CUED);
  await p;
  return player;
}

test('youtube adapter: prepare は YT.Player を指定の playerVars で 1 回だけ作り cueVideoById する', async () => {
  const ctx = makeYouTubeAdapter();
  const player = await prepareYT(ctx, { type: 'youtube', videoId: 'dQw4w9WgXcQ', start: 12 });
  assert.equal(ctx.players.length, 1);
  assert.equal(player.config.width, '100%');
  assert.equal(player.config.height, '100%');
  assert.deepEqual(player.config.playerVars, {
    playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3,
    origin: 'https://example.test',
  });
  assert.deepEqual(player.calls, [['cue', { videoId: 'dQw4w9WgXcQ', startSeconds: 12 }]]);
  // mount 要素自体は残り、子要素が YT.Player に渡される
  assert.equal(player.el.parentNode, ctx.mount);
  assert.deepEqual(player.iframe.style, { width: '100%', height: '100%', display: 'block', border: '0' });

  // 2 問目は同じ player で cue
  await prepareYT(ctx, { type: 'youtube', videoId: 'AAAAAAAAAAA' });
  assert.equal(ctx.players.length, 1);
  assert.deepEqual(player.calls[1], ['cue', { videoId: 'AAAAAAAAAAA', startSeconds: 0 }]);
});

test('youtube adapter: play は seekTo(start,true) → playVideo、stop は pauseVideo、PLAYING で onPlaying', async () => {
  const ctx = makeYouTubeAdapter();
  const player = await prepareYT(ctx, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  player.calls.length = 0;
  ctx.adapter.play({ start: 3 });
  assert.deepEqual(player.calls, [['seekTo', 3, true], ['playVideo']]);
  player.state(PlayerState.BUFFERING);
  assert.deepEqual(ctx.events, []);
  player.state(PlayerState.PLAYING);
  assert.deepEqual(ctx.events, ['playing']);
  ctx.adapter.stop();
  assert.deepEqual(player.calls[2], ['pauseVideo']);
  player.state(PlayerState.PAUSED);
  player.state(PlayerState.ENDED);
  assert.deepEqual(ctx.events, ['playing', 'paused', 'ended']);
});

test('youtube adapter: 再生不可（onError 150）は日本語メッセージで onError / cue 中なら prepare が reject', async () => {
  const ctx = makeYouTubeAdapter();
  const player = await prepareYT(ctx, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  player.error(150);
  assert.deepEqual(ctx.events, ['error:この動画は埋め込み再生が許可されていません']);

  const p = ctx.adapter.prepare({ type: 'youtube', videoId: 'BBBBBBBBBBB' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  player.error(100);
  await assert.rejects(p, /動画が見つかりません/);
});

test('youtube adapter: cue が CUED にならなければタイムアウトで reject', async () => {
  const ctx = makeYouTubeAdapter();
  const p = ctx.adapter.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  ctx.timers.advance(8000);
  await assert.rejects(p, (e) => e.message === YT_LOAD_ERROR_MESSAGE);
});

test('youtube adapter: API ロード失敗は日本語メッセージで reject、videoId 無しも reject', async () => {
  const ctx = makeYouTubeAdapter({ loadApi: () => Promise.reject(new Error(YT_LOAD_ERROR_MESSAGE)) });
  await assert.rejects(ctx.adapter.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' }), (e) => e.message === YT_LOAD_ERROR_MESSAGE);
  await assert.rejects(ctx.adapter.prepare({ type: 'youtube' }), /動画IDが設定されていません/);
  assert.throws(() => ctx.adapter.play({ start: 0 }), /準備ができていません/);
});

test('youtube adapter: onReady が来なければタイムアウト、destroy で player.destroy()', async () => {
  const ctx = makeYouTubeAdapter({ manualReady: true });
  const p = ctx.adapter.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(ctx.mount.children.length, 1);
  ctx.timers.advance(8000);
  await assert.rejects(p, (e) => e.message === YT_LOAD_ERROR_MESSAGE);
  // 作りかけの player は destroy され、holder は mount から除去される
  assert.deepEqual(ctx.players[0].calls, [['destroy']]);
  assert.equal(ctx.mount.children.length, 0);
  assert.equal(ctx.adapter.getPlayer(), null);
  // 遅れて来た onReady は無視（player にならない）
  ctx.players[0].ready();
  assert.equal(ctx.adapter.getPlayer(), null);
  assert.throws(() => ctx.adapter.play({ start: 0 }), /準備ができていません/);
  // 再試行すると新しい player を作る（holder も 1 つだけ）
  const p2 = ctx.adapter.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(ctx.players.length, 2);
  assert.equal(ctx.mount.children.length, 1);
  ctx.players[1].ready();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  ctx.players[1].state(PlayerState.CUED);
  await p2;
  assert.equal(ctx.adapter.getPlayer(), ctx.players[1]);

  const ctx2 = makeYouTubeAdapter();
  const player = await prepareYT(ctx2, { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  ctx2.adapter.destroy();
  assert.deepEqual(player.calls.at(-1), ['destroy']);
  assert.equal(ctx2.adapter.getPlayer(), null);
  await assert.rejects(ctx2.adapter.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' }), /破棄/);
});

// ---------------------------------------------------------------------------
// player.mjs: 状態遷移（フェイク adapter + フェイクタイマー）
// ---------------------------------------------------------------------------

test('player: 初期状態は idle / none、prepare(null) で none', async () => {
  const { player, events } = makePlayer();
  assert.equal(player.state, 'idle');
  assert.equal(player.kind, 'none');
  assert.equal(player.lastError, null);
  await player.prepare(null);
  assert.equal(player.state, 'none');
  assert.equal(player.kind, 'none');
  assert.deepEqual(events, [['none', {}]]);
  assert.equal(await player.play({ seconds: 1.5 }), false);
});

test('player: prepare は source.type で adapter を選び loading → ready', async () => {
  const { player, events, log, youtube, local } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  assert.equal(player.state, 'ready');
  assert.equal(player.kind, 'youtube');
  assert.deepEqual(events.map((e) => e[0]), ['loading', 'ready']);
  assert.deepEqual(log, ['prepare:youtube']);
  assert.equal(youtube.instances[0].ctx.youtubeMount.id, 'mount');

  await player.prepare({ type: 'local', blobId: 'b1' });
  assert.equal(player.kind, 'local');
  assert.equal(typeof local.instances[0].ctx.getAudio, 'function');
  // 同じ種別は adapter を使い回す
  await player.prepare({ type: 'youtube', videoId: 'AAAAAAAAAAA' });
  assert.equal(youtube.instances.length, 1);
  assert.equal(local.instances.length, 1);
});

test('player: 未対応の type は error', async () => {
  const { player, events } = makePlayer();
  await player.prepare({ type: 'spotify' });
  assert.equal(player.state, 'error');
  assert.match(player.lastError.message, /未対応の音源種別/);
  assert.equal(events.at(-1)[1].error, player.lastError);
});

test('player: prepare 失敗は error + lastError（日本語）', async () => {
  const err = new Error('YouTube を読み込めません。通信環境を確認してください');
  const { player, events } = makePlayer({ youtube: { prepareError: err } });
  await player.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  assert.equal(player.state, 'error');
  assert.equal(player.lastError, err);
  assert.deepEqual(events.at(-1), ['error', { error: err }]);
  // prepare をやり直せば lastError はクリアされる
  const ok = makePlayer();
  await ok.player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(ok.player.lastError, null);
});

test('player: play は adapter.play を同期的に呼び、PLAYING 検知から seconds を数えて自動停止する', async () => {
  const { player, events, log, timers, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'dQw4w9WgXcQ' });
  events.length = 0;

  const promise = player.play({ start: 5, seconds: 1.5 });
  // ← await していないのに adapter.play が呼ばれている（iOS のため）
  assert.deepEqual(log.at(-1), 'play:5');
  assert.equal(player.state, 'playing');
  assert.deepEqual(events[0], ['playing', { remainingMs: 1500, elapsedMs: 0, buffering: true }]);

  // バッファ待ち 700ms はカウントしない
  timers.advance(700);
  assert.equal(events.length, 1);
  youtube.instances[0].hooks.onPlaying();
  assert.equal(await promise, true);
  assert.deepEqual(events[1], ['playing', { remainingMs: 1500, elapsedMs: 0 }]);

  timers.advance(PROGRESS_INTERVAL_MS * 3);
  assert.deepEqual(events.at(-1), ['playing', { remainingMs: 1200, elapsedMs: 300 }]);

  timers.advance(1200);
  assert.equal(player.state, 'ready');
  assert.deepEqual(events.at(-1), ['ready', {}]);
  assert.equal(log.at(-1), 'stop');
  assert.equal(timers.pendingCount(), 0);
  // 2 回目の onPlaying（再バッファ後）は無視
  youtube.instances[0].hooks.onPlaying();
  assert.equal(player.state, 'ready');
});

test('player: 進捗通知は約 100ms 間隔で remainingMs が単調減少', async () => {
  const { player, events, timers, local } = makePlayer();
  await player.prepare({ type: 'local', blobId: 'b1' });
  events.length = 0;
  player.play({ start: 0, seconds: 1 });
  local.instances[0].hooks.onPlaying();
  timers.advance(1000);
  const playing = events.filter((e) => e[0] === 'playing' && !e[1].buffering);
  assert.equal(playing.length, 10);   // 0,100,...,900ms（1000ms 時点は ready）
  for (let i = 1; i < playing.length; i++) assert.equal(playing[i][1].remainingMs, playing[i - 1][1].remainingMs - 100);
  assert.deepEqual(events.at(-1), ['ready', {}]);
});

test('player: stop() で手動停止 → ready、再生中でなければ何もしない', async () => {
  const { player, events, log, timers, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  player.stop();
  assert.equal(log.includes('stop'), false);
  const p = player.play({ seconds: 3 });
  youtube.instances[0].hooks.onPlaying();
  timers.advance(500);
  player.stop();
  assert.equal(await p, true);
  assert.equal(player.state, 'ready');
  assert.deepEqual(events.at(-1), ['ready', {}]);
  assert.equal(log.at(-1), 'stop');
  assert.equal(timers.pendingCount(), 0);
});

test('player: バッファ中に stop() すると play() は false で解決', async () => {
  const { player, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  const p = player.play({ seconds: 3 });
  player.stop();
  assert.equal(await p, false);
  assert.equal(player.state, 'ready');
  youtube.instances[0].hooks.onPlaying();   // 遅れて来ても無視
  assert.equal(player.state, 'ready');
});

test('player: local は timeupdate でも停止（setTimeout 遅延の保険）、ended でも停止', async () => {
  const { player, timers, local, log } = makePlayer();
  await player.prepare({ type: 'local', blobId: 'b1' });
  player.play({ start: 10, seconds: 2 });
  const hooks = local.instances[0].hooks;
  hooks.onPlaying();
  hooks.onTimeUpdate(11.9);
  assert.equal(player.state, 'playing');
  hooks.onTimeUpdate(12.0);
  assert.equal(player.state, 'ready');
  assert.equal(timers.pendingCount(), 0);

  player.play({ start: 0, seconds: 5 });
  hooks.onPlaying();
  hooks.onEnded();
  assert.equal(player.state, 'ready');
  assert.equal(log.filter((l) => l === 'stop').length, 2);
});

test('player: 再生中の onError は error に遷移しタイマーを止める、play が同期例外でも error', async () => {
  const { player, events, timers, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  const p = player.play({ seconds: 2 });
  youtube.instances[0].hooks.onPlaying();
  const err = new Error('この動画は埋め込み再生が許可されていません');
  youtube.instances[0].hooks.onError(err);
  assert.equal(await p, true);
  assert.equal(player.state, 'error');
  assert.equal(player.lastError, err);
  assert.deepEqual(events.at(-1), ['error', { error: err }]);
  assert.equal(timers.pendingCount(), 0);
  // error 状態からは play できない
  assert.equal(await player.play({ seconds: 1 }), false);

  const thrown = new Error('動画の準備ができていません');
  const t = makePlayer({ youtube: { playThrows: thrown } });
  await t.player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(await t.player.play({ seconds: 1 }), false);
  assert.equal(t.player.state, 'error');
  assert.equal(t.player.lastError, thrown);
});

test('player: 不正な seconds は error、loading 中の play は false', async () => {
  const { player } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(await player.play({ seconds: 0 }), false);
  assert.equal(player.state, 'error');
  assert.match(player.lastError.message, /再生秒数/);

  const slow = makePlayer();
  const pending = slow.player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(slow.player.state, 'loading');
  assert.equal(await slow.player.play({ seconds: 1 }), false);
  await pending;
  assert.equal(slow.player.state, 'ready');
});

test('player: 再生中に play() し直すと最初から数え直す', async () => {
  const { player, timers, youtube, log } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  const p1 = player.play({ start: 0, seconds: 1 });
  youtube.instances[0].hooks.onPlaying();
  timers.advance(500);
  const p2 = player.play({ start: 0, seconds: 2 });
  assert.equal(await p1, true);
  assert.equal(log.filter((l) => l === 'stop').length, 1);
  youtube.instances[0].hooks.onPlaying();
  timers.advance(1500);
  assert.equal(player.state, 'playing');
  timers.advance(500);
  assert.equal(player.state, 'ready');
  assert.equal(await p2, true);
});

test('player: 再生中に prepare すると停止してから次の準備、古い prepare の結果は無視', async () => {
  let release;
  const slowLog = [];
  const slowFactory = (hooks) => ({
    hooks,
    prepare: () => new Promise((r) => { release = r; }),
    play() {}, stop() { slowLog.push('stop'); }, unlock() {}, destroy() {},
  });
  const fastLog = [];
  const fastFactory = (hooks) => ({ hooks, async prepare() {}, play() {}, stop() {}, unlock() {}, destroy() { fastLog.push('destroy'); } });
  const events = [];
  const timers = fakeTimers();
  const player = createPlayer({ adapters: { youtube: slowFactory, local: fastFactory }, timers, onStateChange: (s) => events.push(s) });

  const first = player.prepare({ type: 'youtube', videoId: 'x' });
  const second = player.prepare({ type: 'local', blobId: 'b' });
  await second;
  assert.equal(player.state, 'ready');
  assert.equal(player.kind, 'local');
  release();
  await first;
  assert.equal(player.state, 'ready');   // 古い prepare は ready を再通知しない
  assert.deepEqual(events, ['loading', 'loading', 'ready']);

  player.play({ seconds: 1 });
  assert.equal(player.state, 'playing');
  const third = player.prepare(null);
  assert.equal(player.state, 'none');
  await third;
  assert.equal(timers.pendingCount(), 0);
});

test('player: unlock は各 adapter の unlock を呼び、失敗を握りつぶす', async () => {
  const { player, log } = makePlayer();
  player.unlock();
  assert.deepEqual(log, ['unlock', 'unlock']);
  assert.equal(player.state, 'idle');
  const bad = createPlayer({ adapters: { local: () => ({ unlock() { throw new Error('x'); }, destroy() {} }), youtube: () => ({ unlock: () => Promise.reject(new Error('y')), destroy() {} }) } });
  assert.doesNotThrow(() => bad.player ? bad.player.unlock() : bad.unlock());
  await Promise.resolve();
});

test('player: destroy は全 adapter を破棄し idle に戻る、onStateChange の例外は無視', async () => {
  const { player, log, timers, youtube, local } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  player.unlock();
  player.play({ seconds: 1 });
  youtube.instances[0].hooks.onPlaying();
  player.destroy();
  assert.equal(player.state, 'idle');
  assert.equal(player.kind, 'none');
  assert.equal(timers.pendingCount(), 0);
  assert.equal(youtube.instances[0].destroyed, true);
  assert.equal(local.instances[0].destroyed, true);
  assert.equal(log.filter((l) => l === 'destroy').length, 2);

  const throwing = createPlayer({ adapters: { youtube: fakeAdapterFactory([]) }, onStateChange: () => { throw new Error('UI bug'); } });
  await throwing.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(throwing.state, 'ready');
});

test('player: 再生開始が 4 秒以内に来なければ watchdog が error にし、play() は false で解決', async () => {
  const { player, events, log, timers, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  events.length = 0;
  const p = player.play({ start: 0, seconds: 1.5 });
  assert.equal(PLAY_START_TIMEOUT_MS, 4000);
  timers.advance(PLAY_START_TIMEOUT_MS - 1);
  assert.equal(player.state, 'playing');
  timers.advance(1);
  assert.equal(await p, false);
  assert.equal(player.state, 'error');
  assert.equal(player.lastError.message, PLAY_START_TIMEOUT_MESSAGE);
  assert.match(player.lastError.message, /動画枠を直接タップ/);
  assert.deepEqual(events.at(-1), ['error', { error: player.lastError }]);
  assert.equal(log.at(-1), 'stop');
  assert.equal(timers.pendingCount(), 0);
  // 遅れて PLAYING が来ても無視
  youtube.instances[0].hooks.onPlaying();
  assert.equal(player.state, 'error');
});

test('player: 再生開始が来れば watchdog は解除され、stop()/prepare() でも clear される', async () => {
  const { player, timers, youtube } = makePlayer();
  await player.prepare({ type: 'youtube', videoId: 'x' });
  // 開始が来た → 以後 4 秒経っても error にならない
  const p1 = player.play({ seconds: 10 });
  timers.advance(3000);
  youtube.instances[0].hooks.onPlaying();
  assert.equal(await p1, true);
  timers.advance(5000);
  assert.equal(player.state, 'playing');
  player.stop();
  assert.equal(player.state, 'ready');
  assert.equal(timers.pendingCount(), 0);

  // バッファ中に stop() → watchdog も消える
  const p2 = player.play({ seconds: 1 });
  player.stop();
  assert.equal(await p2, false);
  assert.equal(timers.pendingCount(), 0);
  timers.advance(10000);
  assert.equal(player.state, 'ready');

  // バッファ中に prepare() → watchdog も消える
  player.play({ seconds: 1 });
  assert.equal(timers.pendingCount(), 1);
  await player.prepare({ type: 'youtube', videoId: 'y' });
  assert.equal(timers.pendingCount(), 0);
  timers.advance(10000);
  assert.equal(player.state, 'ready');

  // 再生中に play() し直すと watchdog も張り直す（古い方は消える）
  player.play({ seconds: 1 });
  timers.advance(3000);
  player.play({ seconds: 1 });
  timers.advance(1500);
  assert.equal(player.state, 'playing', '新しい watchdog は 4 秒を数え直す');
  timers.advance(2500);
  assert.equal(player.state, 'error');
});

test('player: prepare で adapter を切り替えると前の adapter の release() を呼ぶ', async () => {
  const { player, log } = makePlayer();
  await player.prepare({ type: 'local', blobId: 'b1' });
  assert.equal(log.includes('release:local'), false);
  await player.prepare({ type: 'local', blobId: 'b2' });
  assert.equal(log.includes('release:local'), false, '同じ adapter なら release しない');
  await player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(log.filter((l) => l === 'release:local').length, 1);
  assert.equal(log.includes('release:youtube'), false);
  await player.prepare(null);
  assert.equal(log.filter((l) => l === 'release:youtube').length, 1, 'none に切り替えても release');
  await player.prepare({ type: 'local', blobId: 'b3' });
  assert.equal(player.state, 'ready', 'release 後も再度 prepare できる');
  // release が無い adapter でも落ちない
  const bare = createPlayer({ adapters: { youtube: () => ({ async prepare() {}, play() {}, stop() {}, destroy() {} }), local: () => ({ async prepare() {}, play() {}, stop() {}, destroy() {} }) } });
  await bare.prepare({ type: 'youtube', videoId: 'x' });
  await bare.prepare({ type: 'local', blobId: 'b' });
  assert.equal(bare.state, 'ready');
});

test('player: 既定 adapter で import しても DOM 無しで落ちず、local の prepare は日本語エラー', async () => {
  const events = [];
  const player = createPlayer({ onStateChange: (s, d) => events.push([s, d]), getAudio: async () => ({ blob: {} }) });
  await player.prepare({ type: 'local', blobId: 'b' });
  assert.equal(player.state, 'error');
  assert.match(player.lastError.message, /この環境では音声を再生できません/);
  await player.prepare({ type: 'youtube', videoId: 'x' });
  assert.equal(player.state, 'error');
  assert.equal(player.lastError.message, YT_LOAD_ERROR_MESSAGE);
  player.unlock();
  player.destroy();
});
