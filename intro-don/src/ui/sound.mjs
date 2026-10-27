// 早押しブザー等の短い効果音（Web Audio、素材不要）。AudioContext は初回タップで生成する。

let ctx = null;

export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch (e) { /* 効果音は任意 */ }
}

function tone({ freq = 880, ms = 150, type = 'square', gain = 0.25, at = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

const BUZZ_FREQS = [880, 660, 1046, 784];

// プレイヤーごとに音程を変えたブザー音
export function buzzSound(index = 0) {
  unlockAudio();
  const f = BUZZ_FREQS[index % BUZZ_FREQS.length];
  tone({ freq: f, ms: 120 });
  tone({ freq: f * 1.5, ms: 220, at: 0.12 });
}

export function correctSound() {
  unlockAudio();
  tone({ freq: 1046, ms: 120, type: 'sine', gain: 0.3 });
  tone({ freq: 1568, ms: 260, type: 'sine', gain: 0.3, at: 0.13 });
}

export function wrongSound() {
  unlockAudio();
  tone({ freq: 196, ms: 350, type: 'sawtooth', gain: 0.2 });
}

export function tickSound() {
  unlockAudio();
  tone({ freq: 1200, ms: 40, type: 'sine', gain: 0.12 });
}
