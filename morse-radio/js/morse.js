/**
 * International Morse (ITU) encode, decode, and Farnsworth timing.
 * Pure module: safe to import from Node tests and the browser.
 *
 * Farnsworth spacing follows the KE3Z / ARRL unit split: a standard PARIS
 * word is 50 units, of which 31 are inside characters and 19 are the
 * inter-character and word gaps. Elements run at the character speed;
 * only those 19 gap units are stretched to hit the overall WPM.
 */

export const ITU = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.",
  G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..",
  M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.",
  S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
  Y: "-.--", Z: "--..",
  0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
  5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.",
  "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-",
  "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-",
  "+": ".-.-.", "-": "-....-", "_": "..--.-", '"': ".-..-.",
  "$": "...-..-", "@": ".--.-.",
};

/** Prosigns sent as one character (no intra-letter gap). */
export const PROSIGN_CODES = {
  AR: ".-.-.",
  SK: "...-.-",
  BT: "-...-",
  KN: "-.--.",
};

let reverseMap;

export function lookupSymbol(symbol) {
  if (!reverseMap) {
    reverseMap = Object.create(null);
    for (const [ch, code] of Object.entries(ITU)) {
      if (!reverseMap[code]) reverseMap[code] = ch;
    }
    reverseMap[PROSIGN_CODES.AR] = "<AR>";
    reverseMap[PROSIGN_CODES.SK] = "<SK>";
  }
  return reverseMap[symbol] || "\uFFFD";
}

/**
 * @param {number} wpm overall text speed
 * @param {number} [farnsworth] character speed; values at or below wpm use standard spacing
 */
export function timingParams(wpm = 18, farnsworth = 0) {
  const overall = clamp(Number(wpm) || 18, 5, 60);
  const requested = Number(farnsworth) || 0;
  const charWpm = Math.max(overall, requested);
  const dit = 1.2 / charWpm;
  if (charWpm === overall) {
    return { dit, dah: 3 * dit, elGap: dit, charGap: 3 * dit, wordGap: 7 * dit, wpm: overall, charWpm };
  }
  const wordSeconds = 60 / overall;
  const scale = (wordSeconds - 31 * dit) / (19 * dit);
  const s = Math.max(1, scale);
  return {
    dit,
    dah: 3 * dit,
    elGap: dit,
    charGap: 3 * dit * s,
    wordGap: 7 * dit * s,
    wpm: overall,
    charWpm,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Tokenize text into Morse characters and word gaps.
 * Prosigns: <AR> <SK> <BT> <KN> or [AR] [SK] [BT] [KN]. "+" is AR.
 * Returns unknown characters (emoji, Devanagari, etc.) instead of inventing codes.
 */
export function tokenize(text) {
  const src = String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const tokens = [];
  const unknown = [];
  let i = 0;
  let pendingGap = false;
  const pushChar = (code, ch) => {
    if (pendingGap && tokens.length) tokens.push({ kind: "word" });
    pendingGap = false;
    tokens.push({ kind: "char", code, ch });
  };
  while (i < src.length) {
    const m = /^[\[<](AR|SK|BT|KN)[\]>]/.exec(src.slice(i));
    if (m && PROSIGN_CODES[m[1]]) {
      pushChar(PROSIGN_CODES[m[1]], `<${m[1]}>`);
      i += m[0].length;
      continue;
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (/[\s]/.test(ch)) {
      pendingGap = true;
      continue;
    }
    if (ch === "+") {
      pushChar(PROSIGN_CODES.AR, "<AR>");
      continue;
    }
    const code = ITU[ch];
    if (!code) {
      unknown.push(ch);
      continue;
    }
    pushChar(code, ch);
  }
  return { tokens, unknown };
}

export function tokensToMorse(tokens) {
  const words = [];
  let buf = [];
  for (const t of tokens) {
    if (t.kind === "word") {
      if (buf.length) words.push(buf.join(" "));
      buf = [];
    } else buf.push(t.code);
  }
  if (buf.length) words.push(buf.join(" "));
  return words.join(" / ");
}

export function decodeMorse(morse) {
  const src = String(morse ?? "").trim();
  if (!src) return "";
  return src
    .split(/\s*\/\s*/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((word) => word.split(/\s+/).filter(Boolean).map(lookupSymbol).join(""))
    .join(" ")
    .replace(/ +/g, " ")
    .trim();
}

export function timelineFromTokens(tokens, wpm, farnsworth) {
  const p = timingParams(wpm, farnsworth);
  const events = [];
  const add = (on, dur) => {
    if (dur <= 0) return;
    const prev = events[events.length - 1];
    if (prev && prev.on === on) prev.dur += dur;
    else events.push({ on, dur });
  };
  let prevChar = false;
  for (const t of tokens) {
    if (t.kind === "word") {
      add(false, p.wordGap);
      prevChar = false;
      continue;
    }
    if (prevChar) add(false, p.charGap);
    const parts = t.code.split("");
    parts.forEach((s, idx) => {
      if (idx) add(false, p.elGap);
      add(true, s === "-" ? p.dah : p.dit);
    });
    prevChar = true;
  }
  const seconds = events.reduce((a, e) => a + e.dur, 0);
  return { events, seconds, ...p };
}

export function applyAffixes(text, { callsign = "", prosign = "" } = {}) {
  let t = String(text ?? "").trim();
  const cs = String(callsign ?? "").trim();
  if (cs) t = t ? `${cs} ${t}` : cs;
  const p = String(prosign ?? "").toUpperCase();
  if (p === "AR" || p === "SK" || p === "BT" || p === "KN") {
    const tag = `<${p}>`;
    if (!t.toUpperCase().endsWith(tag)) t = t ? `${t} ${tag}` : tag;
  }
  return t;
}

/** Full payload: affixes, Morse string, timing, and characters that cannot be sent. */
export function prepareMessage(text, opts = {}) {
  const payload = applyAffixes(text, opts);
  const { tokens, unknown } = tokenize(payload);
  const tl = timelineFromTokens(tokens, opts.wpm ?? 18, opts.farnsworth ?? 0);
  return {
    payload,
    tokens,
    unknown,
    morse: tokensToMorse(tokens),
    seconds: tl.seconds,
    events: tl.events,
    dit: tl.dit,
    charWpm: tl.charWpm,
    wpm: tl.wpm,
  };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r} s`;
  return `${m} min ${r} s`;
}
