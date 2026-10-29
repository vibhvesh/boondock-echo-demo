/**
 * Element-timing Morse decoder with a light auto-WPM tracker.
 * Feed mark/gap durations in milliseconds (from a tone detector or from
 * an ideal timeline). Call finish() after the last gap so the final
 * character is committed.
 */

import { lookupSymbol } from "./morse.js";

export class CwDecoder {
  /**
   * @param {{wpm?: number, auto?: boolean}} [opts]
   * `wpm` is the element speed hint (character speed), not the slowed
   * Farnsworth text speed.
   */
  constructor(opts = {}) {
    const wpm = Math.max(5, Number(opts.wpm) || 18);
    this.auto = opts.auto !== false;
    this.ditMs = 1200 / wpm;
    this.dahMs = this.ditMs * 3;
    this.text = "";
    this._sym = "";
    this._breaks = [];
  }

  get wpm() {
    return 1200 / this.ditMs;
  }

  /** Dots and dashes of the character still being received. */
  get partial() {
    return this._sym;
  }

  reset() {
    this.text = "";
    this._sym = "";
    this._breaks = [];
  }

  setHint(wpm) {
    const d = 1200 / Math.max(5, wpm);
    this.ditMs = d;
    this.dahMs = d * 3;
  }

  feed(kind, ms) {
    if (!(ms > 6)) return;
    if (kind === "mark") {
      const cut = (this.ditMs + this.dahMs) / 2;
      const isDah = ms >= cut;
      this._sym += isDah ? "-" : ".";
      if (this.auto) {
        if (isDah) this.dahMs = this.dahMs * 0.75 + ms * 0.25;
        else this.ditMs = this.ditMs * 0.75 + ms * 0.25;
        if (this.dahMs < this.ditMs * 2.2) this.dahMs = this.ditMs * 3;
        if (this.ditMs < 15) this.ditMs = 15;
      }
      return;
    }
    if (ms < this.ditMs * 2) return;
    this._commit();
    if (this._isWordGap(ms)) {
      this._space();
    } else {
      this._breaks.push(ms);
      if (this._breaks.length > 24) this._breaks.shift();
    }
  }

  finish() {
    this._commit();
  }

  _commit() {
    if (!this._sym) return;
    this.text += lookupSymbol(this._sym);
    this._sym = "";
  }

  _space() {
    if (this.text && !this.text.endsWith(" ")) this.text += " ";
  }

  _isWordGap(ms) {
    const dit = this.ditMs;
    const breaks = this._breaks;
    if (!breaks.length) {
      if (ms >= 5 * dit && ms <= 8.5 * dit) return true;
      if (ms >= 16 * dit) return true;
      return false;
    }
    const sorted = [...breaks].sort((a, b) => a - b);
    const half = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.6)));
    const charGap = half[Math.floor((half.length - 1) / 2)];
    const classic = ms >= 5 * dit && ms <= 8.5 * dit && charGap < 4.5 * dit;
    const relative = ms > charGap * 1.8 && ms > 4 * dit;
    return classic || relative;
  }
}

export function decodeEdges(edges, opts = {}) {
  const dec = new CwDecoder(opts);
  for (const e of edges) dec.feed(e.kind, e.ms);
  dec.finish();
  return { text: dec.text.replace(/\s+/g, " ").trim(), wpm: dec.wpm, decoder: dec };
}
