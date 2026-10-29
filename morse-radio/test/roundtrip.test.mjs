import assert from "node:assert/strict";
import test from "node:test";
import {
  ITU,
  PROSIGN_CODES,
  applyAffixes,
  decodeMorse,
  lookupSymbol,
  prepareMessage,
  timelineFromTokens,
  timingParams,
  tokenize,
  tokensToMorse,
} from "../js/morse.js";
import { decodeImages, encodeImage, fletcher, toBits } from "../js/imageproto.js";
import { ToneTracker, goertzelPower, renderPcm } from "../js/tone.js";
import { decodeEdges } from "../js/cwdecode.js";

test("letters, digits, and punctuation round-trip", () => {
  for (const text of ["HELLO WORLD", "CQ DX 599", "OK, 73?", "TEST (NET) = 5"]) {
    const { morse, unknown } = prepareMessage(text, { wpm: 18, prosign: "" });
    assert.deepEqual(unknown, []);
    assert.equal(decodeMorse(morse), text);
  }
});

test("prosigns and the plus sign", () => {
  assert.equal(decodeMorse(prepareMessage("<AR>", { prosign: "" }).morse), "<AR>");
  assert.equal(decodeMorse(prepareMessage("<SK>", { prosign: "" }).morse), "<SK>");
  assert.equal(decodeMorse(prepareMessage("+", { prosign: "" }).morse), "<AR>");
  assert.equal(lookupSymbol(PROSIGN_CODES.AR), "<AR>");
  assert.equal(lookupSymbol(PROSIGN_CODES.SK), "<SK>");
  assert.equal(decodeMorse(prepareMessage("<BT>", { prosign: "" }).morse), "=");
  assert.equal(decodeMorse(prepareMessage("<KN>", { prosign: "" }).morse), "(");
});

test("unknown characters are reported and skipped", () => {
  const { morse, unknown } = prepareMessage("HI😀", { prosign: "" });
  assert.equal(decodeMorse(morse), "HI");
  assert.ok(unknown.length >= 1);
});

test("whitespace collapses to a single word gap", () => {
  assert.equal(decodeMorse(tokensToMorse(tokenize("A  \nB").tokens)), "A B");
});

test("PARIS is 50 units and one minute at the stated WPM", () => {
  for (const wpm of [12, 18, 25]) {
    const { tokens } = tokenize("PARIS");
    const tl = timelineFromTokens([...tokens, { kind: "word" }], wpm, wpm);
    const units = tl.events.reduce((a, e) => a + e.dur / tl.dit, 0);
    assert.ok(Math.abs(units - 50) < 1e-6, `units ${units}`);
    assert.ok(Math.abs(tl.seconds - 60 / wpm) < 1e-9, `seconds ${tl.seconds}`);
  }
});

test("Farnsworth keeps element speed and still lands on overall WPM", () => {
  const overall = 10;
  const chars = 20;
  const p = timingParams(overall, chars);
  assert.ok(Math.abs(p.dit - 1.2 / chars) < 1e-12);
  const { tokens } = tokenize("PARIS");
  const tl = timelineFromTokens([...tokens, { kind: "word" }], overall, chars);
  assert.ok(Math.abs(tl.seconds - 60 / overall) < 1e-6);
  assert.ok(tl.charGap > 3 * tl.dit * 2, "gaps should be stretched");
});

test("every ITU character has its own pattern", () => {
  const owner = new Map();
  for (const [ch, code] of Object.entries(ITU)) {
    assert.equal(owner.has(code), false, `${ch} collides with ${owner.get(code)} on ${code}`);
    owner.set(code, ch);
  }
  assert.equal(ITU["+"], PROSIGN_CODES.AR);
  assert.equal(ITU["="], PROSIGN_CODES.BT);
  assert.equal(ITU["("], PROSIGN_CODES.KN);
});

test("callsign prefix and end prosign wrap a payload", () => {
  const msg = prepareMessage("TEST", { callsign: "VU2ABC", prosign: "AR", wpm: 15 });
  assert.equal(msg.payload, "VU2ABC TEST <AR>");
  assert.equal(decodeMorse(msg.morse), "VU2ABC TEST <AR>");
});

test("PIXM1 worked example and checksum", () => {
  const bits = Uint8Array.from([1, 0, 0, 1]);
  assert.equal(fletcher(bits), "002005");
  const frame = encodeImage(bits, 2, 2);
  assert.equal(frame.text, "PIXM1 02 02 B1W1 W1B1 C002005 END");
  assert.equal(frame.compact, "PIXM10202B1W1W1B1C002005END");
  const [back] = decodeImages(frame.text);
  assert.equal(back.w, 2);
  assert.equal(back.h, 2);
  assert.deepEqual(Array.from(back.bits), [1, 0, 0, 1]);
});

test("image round-trip survives spaces, case, O/0, and I/1", () => {
  for (const [w, h] of [[8, 8], [16, 16], [32, 24]]) {
    const bits = Uint8Array.from({ length: w * h }, (_, i) => ((i * 17 + h) % 5 === 0 ? 1 : 0));
    const messy = encodeImage(bits, w, h).text
      .toLowerCase()
      .replace(/0/g, "O")
      .replace(/1/g, "I")
      .split("")
      .join(" ");
    const frames = decodeImages(`noise ${messy}\nthanks`);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].w, w);
    assert.equal(frames[0].h, h);
    assert.deepEqual(Array.from(frames[0].bits), Array.from(bits));
  }
});

test("bad checksum and truncated frames are rejected", () => {
  assert.equal(decodeImages("PIXM1 02 02 B1W1 W1B1 C000000 END").length, 0);
  assert.equal(decodeImages("PIXM10202B1W1").length, 0);
  assert.equal(decodeImages("just a voice note").length, 0);
});

test("affixed image traffic still rebuilds", () => {
  const frame = encodeImage(Uint8Array.from([1, 1, 1, 1]), 2, 2);
  const msg = prepareMessage(frame.text, { callsign: "M1ABC", prosign: "SK", wpm: 20 });
  const frames = decodeImages(decodeMorse(msg.morse));
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0].bits), [1, 1, 1, 1]);
});

test("threshold and dither", () => {
  const hard = toBits(Float32Array.from([0, 255, 0, 255]), 2, 2, 128, false);
  assert.deepEqual(Array.from(hard), [1, 0, 1, 0]);
  const same = toBits(Float32Array.from([0, 255, 0, 255]), 2, 2, 128, true);
  assert.deepEqual(Array.from(same), [1, 0, 1, 0]);
  const ramp = new Float32Array(64);
  for (let i = 0; i < 64; i++) ramp[i] = (i % 8) * 32;
  const bits = toBits(ramp, 8, 8, 140, true);
  assert.ok(bits.some((b) => b === 1) && bits.some((b) => b === 0));
  const [back] = decodeImages(encodeImage(bits, 8, 8).text);
  assert.deepEqual(Array.from(back.bits), Array.from(bits));
});

test("ideal element timing decodes standard and Farnsworth text", () => {
  for (const [wpm, fw, text] of [[18, 18, "HELLO WORLD"], [10, 20, "CQ DE TEST"], [15, 15, "SOS 73"]]) {
    const prep = prepareMessage(text, { wpm, farnsworth: fw, prosign: "" });
    const edges = prep.events.map((e) => ({ kind: e.on ? "mark" : "gap", ms: e.dur * 1000 }));
    const { text: out } = decodeEdges(edges, { wpm: prep.charWpm, auto: true });
    assert.equal(out, text);
  }
});

test("sidetone envelope has no step and is silent in the lead-in", () => {
  const prep = prepareMessage("HI", { wpm: 18, prosign: "", farnsworth: 18 });
  const { pcm, sampleRate } = renderPcm(prep.events, { sampleRate: 8000, freq: 600, volume: 0.7, lead: 0.02, pad: 0.2 });
  assert.ok(Math.abs(pcm[0]) < 1e-6);
  let maxStep = 0;
  let peak = 0;
  for (let i = 1; i < pcm.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(pcm[i] - pcm[i - 1]));
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  assert.ok(peak > 0.5, `peak ${peak}`);
  assert.ok(maxStep < 0.55, `step ${maxStep}`);
});

test("Goertzel prefers the sidetone over a neighbor", () => {
  const n = 800;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * 600 * i) / 8000);
  const on = goertzelPower(pcm, 8000, 600);
  const off = goertzelPower(pcm, 8000, 1100);
  assert.ok(on > off * 20, `on ${on} off ${off}`);
});

function decodePcm(pcm, sampleRate, freq, wpm) {
  const tr = new ToneTracker(sampleRate, freq, {
    marginDb: 12,
    winSec: 0.01,
    hopSec: 0.004,
    calibrateSec: 0,
    floorDb: -120,
  });
  tr.push(pcm);
  const edges = tr.finish();
  return { ...decodeEdges(edges, { wpm, auto: true }), edges };
}

test("rendered CW audio decodes back to text", () => {
  const text = "CQ SOS";
  const prep = prepareMessage(text, { wpm: 16, farnsworth: 16, prosign: "" });
  const { pcm, sampleRate } = renderPcm(prep.events, {
    sampleRate: 8000,
    freq: 650,
    volume: 0.6,
    lead: 0.05,
    pad: 0.7,
    attack: 0.004,
  });
  const { text: out, edges } = decodePcm(pcm, sampleRate, 650, 16);
  assert.equal(out, text, `edges ${JSON.stringify(edges.slice(0, 12))} … n=${edges.length}`);
});

test("rendered image frame decodes from the sidetone", () => {
  const bits = Uint8Array.from([1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0]);
  const frame = encodeImage(bits, 4, 4);
  const prep = prepareMessage(frame.text, { wpm: 18, farnsworth: 18, prosign: "" });
  const { pcm, sampleRate } = renderPcm(prep.events, {
    sampleRate: 8000,
    freq: 600,
    volume: 0.65,
    lead: 0.04,
    pad: 0.8,
    attack: 0.004,
  });
  const { text: out, edges } = decodePcm(pcm, sampleRate, 600, 18);
  const frames = decodeImages(out);
  assert.equal(frames.length, 1, `decoded "${out}" from ${edges.length} edges`);
  assert.deepEqual(Array.from(frames[0].bits), Array.from(bits));
});
