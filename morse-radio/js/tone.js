/**
 * Click-free CW sidetone rendering and Goertzel tone tracking.
 * Shared by the browser player and the Node round-trip tests.
 */

export function goertzelPower(samples, sampleRate, freq, offset = 0, length = samples.length - offset) {
  const N = length | 0;
  if (N <= 0) return 0;
  const k = Math.round((N * freq) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / N;
}

/**
 * Render a Morse timeline to mono PCM.
 * Gain rises and falls linearly over `attack` seconds so the speaker
 * never sees a step (which is what makes a CW sidetone click).
 */
export function renderPcm(events, opts = {}) {
  const sampleRate = opts.sampleRate ?? 16000;
  const freq = opts.freq ?? 600;
  const volume = opts.volume ?? 0.7;
  const attack = opts.attack ?? 0.005;
  const lead = opts.lead ?? 0.02;
  const pad = opts.pad ?? 0.45;
  const toneDur = events.reduce((a, e) => a + e.dur, 0);
  const total = lead + toneDur + pad;
  const n = Math.max(1, Math.ceil(total * sampleRate));
  const pcm = new Float32Array(n);
  const twoPiF = 2 * Math.PI * freq;
  let t0 = lead;
  for (const e of events) {
    const t1 = t0 + e.dur;
    if (e.on && e.dur > 0) {
      const a = Math.min(attack, e.dur / 3);
      const i0 = Math.max(0, Math.floor(t0 * sampleRate));
      const i1 = Math.min(n, Math.ceil(t1 * sampleRate));
      for (let i = i0; i < i1; i++) {
        const t = i / sampleRate;
        if (t < t0 || t >= t1) continue;
        const u = t - t0;
        const v = t1 - t;
        let g = 1;
        if (u < a) g = u / a;
        else if (v < a) g = Math.max(0, v / a);
        pcm[i] = g * volume * Math.sin(twoPiF * t);
      }
    }
    t0 = t1;
  }
  return { pcm, sampleRate, seconds: total };
}

/**
 * Streaming narrow-band CW detector. Feed mic or rendered PCM.
 * `finish()` flushes the open mark/gap.
 */
export class ToneTracker {
  constructor(sampleRate, freq, opts = {}) {
    this.sampleRate = sampleRate;
    this.freq = freq;
    this.win = Math.max(16, Math.round((opts.winSec ?? 0.012) * sampleRate));
    this.hop = Math.max(1, Math.round((opts.hopSec ?? 0.004) * sampleRate));
    if (this.hop >= this.win) this.hop = Math.max(1, this.win >> 1);
    this.marginDb = opts.marginDb ?? 10;
    this.buf = new Float32Array(this.win);
    this.len = 0;
    this.floor = opts.floorDb ?? -100;
    this.tone = false;
    this.pendingKind = null;
    this.pendingSamples = 0;
    this.edges = [];
    this.level = 0;
    this.db = -120;
    this.frames = 0;
    this.calLeft = Math.round((opts.calibrateSec ?? 0) * sampleRate);
    this.calDbs = [];
  }

  setFreq(freq) {
    this.freq = freq;
  }

  setMargin(db) {
    this.marginDb = db;
  }

  push(chunk) {
    const data = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk);
    let o = 0;
    while (o < data.length) {
      const take = Math.min(this.win - this.len, data.length - o);
      this.buf.set(data.subarray(o, o + take), this.len);
      this.len += take;
      o += take;
      if (this.len === this.win) {
        this._frame();
        this.buf.copyWithin(0, this.hop);
        this.len -= this.hop;
      }
    }
  }

  _frame() {
    const power = goertzelPower(this.buf, this.sampleRate, this.freq, 0, this.win);
    const db = 10 * Math.log10(power + 1e-12);
    this.db = db;
    this.level = Math.max(0, Math.min(1, (db + 90) / 80));
    const credit = this.frames === 0 ? this.win : this.hop;
    this.frames++;
    if (this.calLeft > 0) {
      this.calDbs.push(db);
      this.calLeft -= credit;
      if (this.calLeft <= 0 && this.calDbs.length) {
        const s = [...this.calDbs].sort((a, b) => a - b);
        this.floor = s[Math.floor(s.length * 0.6)];
        this.calDbs = [];
      }
      this._advance(false, credit);
      return;
    }
    const onThr = this.floor + this.marginDb;
    const offThr = this.floor + this.marginDb * 0.45;
    let next = this.tone;
    if (!this.tone && db >= onThr) next = true;
    else if (this.tone && db <= offThr) next = false;
    if (!next) this.floor = this.floor * 0.9 + db * 0.1;
    this._advance(next, credit);
    this.tone = next;
  }

  _advance(tone, samples) {
    const kind = tone ? "mark" : "gap";
    if (this.pendingKind == null) {
      this.pendingKind = kind;
      this.pendingSamples = samples;
      return;
    }
    if (kind === this.pendingKind) {
      this.pendingSamples += samples;
      return;
    }
    this.edges.push({ kind: this.pendingKind, ms: (this.pendingSamples / this.sampleRate) * 1000 });
    this.pendingKind = kind;
    this.pendingSamples = samples;
  }

  drain() {
    const e = this.edges;
    this.edges = [];
    return e;
  }

  /** Flush the open run and return every edge not yet drained. */
  finish() {
    if (this.pendingKind != null && this.pendingSamples > 0) {
      this.edges.push({ kind: this.pendingKind, ms: (this.pendingSamples / this.sampleRate) * 1000 });
      this.pendingKind = null;
      this.pendingSamples = 0;
    }
    return this.drain();
  }
}
