/**
 * PIXM1 — a Morse-transport bitmap.
 *
 * The on-air form is letters and digits only. Spaces, newlines, and
 * punctuation are optional; decoders that split every character still
 * round-trip because the parser deletes them. The letter O is not used,
 * and a "1" heard as "I" is accepted inside numbers. Canonical description:
 * morse-radio/README.md.
 *
 * Frame, after uppercasing and deleting everything that is not A–Z or 0–9:
 *
 *   PIXM1 + WW + HH + ROWS + C + AAAAAA + END
 *
 *   WW, HH   width and height, 2 digits, 01–64
 *   ROWS     concatenated run-length rows
 *   C        checksum marker
 *   AAAAAA   six-digit Fletcher-style checksum
 *   END      end marker (required)
 *
 * A run is W or B plus a decimal length (W = white / 0, B = black / 1).
 * Runs fill each row to exactly `width`, then the next row starts.
 * Rows are concatenated with no separator.
 *
 * Checksum over row-major bits (black = 1):
 *   a = 0; b = 0
 *   for each bit: a = (a + bit) mod 255; b = (b + a) mod 255
 *   checksum = pad3(a) + pad3(b)
 */

export const PIX_MAX = 64;

export function fletcher(bits) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < bits.length; i++) {
    a = (a + (bits[i] ? 1 : 0)) % 255;
    b = (b + a) % 255;
  }
  return String(a).padStart(3, "0") + String(b).padStart(3, "0");
}

function rleRow(bits, w, y) {
  let i = 0;
  let out = "";
  while (i < w) {
    const black = bits[y * w + i] ? 1 : 0;
    let j = i + 1;
    while (j < w && (bits[y * w + j] ? 1 : 0) === black) j++;
    out += (black ? "B" : "W") + String(j - i);
    i = j;
  }
  return out;
}

export function encodeImage(bits, w, h) {
  w = w | 0;
  h = h | 0;
  if (w < 1 || h < 1 || w > PIX_MAX || h > PIX_MAX) {
    throw new Error(`Image must be 1–${PIX_MAX} pixels on each side`);
  }
  if (!bits || bits.length !== w * h) throw new Error("Bitmap length does not match width×height");
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(rleRow(bits, w, y));
  const words = ["PIXM1", String(w).padStart(2, "0"), String(h).padStart(2, "0"), ...rows, "C" + fletcher(bits), "END"];
  return { text: words.join(" "), compact: words.join(""), words, checksum: fletcher(bits) };
}

function dig(s) {
  return s.replace(/O/g, "0").replace(/I/g, "1");
}

/**
 * Find every valid PIXM1 frame in Morse-decoded text or hand-typed text.
 * @returns {{w:number,h:number,bits:Uint8Array,checksum:string,end:number}[]}
 */
export function decodeImages(input) {
  const compact = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const frames = [];
  let i = 0;
  while (i < compact.length) {
    const a = compact.indexOf("PIXM1", i);
    const b = compact.indexOf("PIXMI", i);
    let h = -1;
    if (a >= 0 && b >= 0) h = Math.min(a, b);
    else h = a >= 0 ? a : b;
    if (h < 0) break;
    const parsed = parseAt(compact, h);
    if (parsed) {
      frames.push(parsed);
      i = parsed.end;
    } else i = h + 5;
  }
  return frames;
}

function parseAt(compact, h) {
  let p = h + 5;
  if (p + 4 > compact.length) return null;
  const ww = dig(compact.slice(p, p + 2));
  const hh = dig(compact.slice(p + 2, p + 4));
  if (!/^\d\d$/.test(ww) || !/^\d\d$/.test(hh)) return null;
  const w = +ww;
  const ht = +hh;
  if (w < 1 || w > PIX_MAX || ht < 1 || ht > PIX_MAX) return null;
  p += 4;
  const bits = new Uint8Array(w * ht);
  let count = 0;
  while (count < bits.length) {
    if (p >= compact.length) return null;
    const color = compact[p];
    if (color !== "W" && color !== "B") return null;
    p++;
    let num = "";
    while (p < compact.length && /[0-9OI]/.test(compact[p])) {
      num += compact[p];
      p++;
    }
    if (!num) return null;
    const len = +dig(num);
    if (!Number.isInteger(len) || len < 1 || count + len > bits.length) return null;
    const bit = color === "B" ? 1 : 0;
    for (let k = 0; k < len; k++) bits[count++] = bit;
  }
  if (compact[p] !== "C") return null;
  p++;
  let ck = "";
  while (ck.length < 6 && p < compact.length && /[0-9OI]/.test(compact[p])) {
    ck += compact[p];
    p++;
  }
  ck = dig(ck);
  if (!/^\d{6}$/.test(ck) || ck !== fletcher(bits)) return null;
  if (!compact.startsWith("END", p)) return null;
  return { w, h: ht, bits, checksum: ck, end: p + 3 };
}

/**
 * Grayscale (0–255, length w*h) → 1-bit bitmap, 1 = black.
 * Threshold: samples darker than `threshold` become black.
 * Floyd–Steinberg when dither is true.
 */
export function toBits(gray, w, h, threshold = 128, dither = true) {
  const g = Float32Array.from(gray);
  const bits = new Uint8Array(w * h);
  const thr = Number(threshold);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = g[i];
      const black = old < thr ? 1 : 0;
      bits[i] = black;
      if (!dither) continue;
      const err = old - (black ? 0 : 255);
      const add = (xx, yy, f) => {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
        g[yy * w + xx] += err * f;
      };
      add(x + 1, y, 7 / 16);
      add(x - 1, y + 1, 3 / 16);
      add(x, y + 1, 5 / 16);
      add(x + 1, y + 1, 1 / 16);
    }
  }
  return bits;
}

/** True when decoded text already contains a PIXM1 header, even if the frame is unfinished. */
export function hasImageHeader(input) {
  const c = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.includes("PIXM1") || c.includes("PIXMI");
}
