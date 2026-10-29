import { decodeMorse, formatDuration, prepareMessage } from "./morse.js";
import { decodeImages, encodeImage, hasImageHeader, toBits } from "./imageproto.js";
import { ToneTracker, renderPcm } from "./tone.js";
import { CwDecoder, decodeEdges } from "./cwdecode.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
  ptt: 3,
  tail: 0.6,
  wpm: 18,
  fw: 18,
  freq: 600,
  volume: 70,
  callsign: "",
  prosign: "AR",
  res: 16,
  threshold: 128,
  dither: true,
  rxWpm: 18,
  autoWpm: true,
  cwMargin: 12,
  squelchMargin: 9,
  hang: 1.4,
  whisperModel: "Xenova/whisper-tiny",
  whisperLang: "en",
  sttMode: "whisper",
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: "",
};

const NUM_KEYS = ["ptt", "tail", "wpm", "fw", "freq", "volume", "res", "threshold", "rxWpm", "cwMargin", "squelchMargin", "hang", "ttsRate", "ttsPitch"];

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("mr_settings") || "{}"); } catch { /* keep defaults */ }
  const s = { ...DEFAULTS, ...saved };
  for (const key of NUM_KEYS) {
    s[key] = Number(s[key]);
    if (!Number.isFinite(s[key])) s[key] = DEFAULTS[key];
  }
  s.dither = saved.dither == null ? true : !!saved.dither;
  s.autoWpm = saved.autoWpm !== false;
  if (!["", "AR", "SK"].includes(s.prosign)) s.prosign = "AR";
  if (!["whisper", "webspeech"].includes(s.sttMode)) s.sttMode = "whisper";
  if (s.fw < s.wpm) s.fw = s.wpm;
  return s;
}

const settings = loadSettings();
function saveSettings() {
  localStorage.setItem("mr_settings", JSON.stringify(settings));
}

let mode = "cw";
let rxSub = "paste";
let busy = false;
let listening = false;
let listenKind = "";
let txGen = 0;
let player = null;
let keeper = null;
let ctx = null;
let an = null;
let fbuf = null;
let outGain = null;
let stream = null;
let micSrc = null;
let capNode = null;
let micMute = null;
let opening = false;
let openGen = 0;
let workletUrl = "";
let workletOk = false;
let meterLoop = false;
let meterDb = -120;
let lastTx = null;
let sourceBmp = null;
let gray = null;
let frameText = "";
let cwDec = null;
let tracker = null;
let cwShown = "";
let cwWaitNoted = false;
let whisperPipe = null;
let whisperId = "";
let recog = null;
let speechFinal = "";
let voiceQ = [];
let voiceBusy = false;
let dbp = null;

const voiceState = {
  mode: "idle",
  calVals: [],
  calStart: 0,
  floorDb: -90,
  lastDb: -120,
  preroll: [],
  preLen: 0,
  clip: [],
  clipLen: 0,
  aboveMs: 0,
  silMs: 0,
};

function setStatus(text) {
  $("status").textContent = text;
}

function setProg(frac) {
  const bar = $("prog");
  if (frac > 0 && frac < 1) {
    bar.hidden = false;
    $("progBar").style.width = Math.round(frac * 100) + "%";
  } else {
    bar.hidden = true;
    $("progBar").style.width = "0";
  }
}

function setLamp(state) {
  $("lamp").className = "lamp" + (state === "standby" ? "" : " " + state);
  $("lampText").textContent = state === "live" ? "ON AIR" : state === "ptt" ? "PRESS PTT" : "STANDBY";
}

function txOpts() {
  return {
    wpm: settings.wpm,
    farnsworth: settings.fw,
    callsign: settings.callsign,
    prosign: settings.prosign,
  };
}

function tailSec() {
  return Math.max(0.4, Number(settings.tail) || 0);
}

function volumeGain() {
  return Math.max(0.02, Math.min(1, settings.volume / 100));
}

/* ---------- chrome ---------- */

function setMode(next, fromHash = false) {
  if ((busy || listening) && next !== mode) return;
  mode = next;
  document.querySelectorAll(".modes button").forEach((btn) => btn.classList.toggle("on", btn.dataset.mode === mode));
  for (const id of ["cw", "img", "voice", "rx", "log"]) {
    $("view-" + id).hidden = id !== mode;
  }
  if (!fromHash) history.replaceState(null, "", "#" + mode);
  refreshEst();
  chrome();
}

function setRx(sub) {
  if (listening && sub !== rxSub) return;
  rxSub = sub;
  document.querySelectorAll(".submodes button").forEach((btn) => btn.classList.toggle("on", btn.dataset.rx === sub));
  $("rx-paste").hidden = sub !== "paste";
  $("rx-cw").hidden = sub !== "cw";
  $("rx-speech").hidden = sub !== "speech";
  chrome();
}

function chrome() {
  const labels = { cw: "TRANSMIT CW", img: "TRANSMIT IMAGE", voice: "TRANSMIT VOICE", log: "EXPORT ZIP" };
  if (mode === "rx") $("goBtn").textContent = rxSub === "paste" ? "REBUILD" : rxSub === "cw" ? "LISTEN CW" : "LISTEN VOICE";
  else $("goBtn").textContent = labels[mode] || "GO";
  $("goBtn").disabled = busy || listening || opening;
  $("stopBtn").disabled = !(busy || listening || opening);
}

function refreshEst() {
  if (mode === "cw") {
    const msg = prepareMessage($("cwText").value, txOpts());
    $("morsePrev").textContent = msg.morse || "—";
    $("skipped").hidden = msg.unknown.length === 0;
    $("skipped").textContent = msg.unknown.length ? "Skipped (no International Morse): " + msg.unknown.join(" ") : "";
    $("est").textContent = msg.events.length ? `tone ${formatDuration(msg.seconds)} + tail` : "";
    syncFwHint();
    return;
  }
  if (mode === "img") {
    if (!frameText) {
      $("est").textContent = "";
      return;
    }
    const msg = prepareMessage(frameText, txOpts());
    $("est").textContent = `tone ${formatDuration(msg.seconds)} + tail`;
    return;
  }
  if (mode === "voice") {
    const words = $("ttsText").value.trim().split(/\s+/).filter(Boolean).length;
    const sec = words ? words / (2.5 * (settings.ttsRate || 1)) : 0;
    $("est").textContent = sec ? `about ${formatDuration(sec)} of speech` : "";
    return;
  }
  $("est").textContent = "";
}

function syncFwHint() {
  const standard = settings.fw <= settings.wpm;
  $("fwHint").textContent = standard
    ? "Equal to WPM — standard spacing. Raise Farnsworth to keep the characters fast and the gaps slow."
    : `Characters at ${settings.fw} WPM, overall text at ${settings.wpm} WPM.`;
}

function bindRange(id, key, labelId, fmt, after) {
  const el = $(id);
  const paint = () => { $(labelId).textContent = fmt(settings[key]); };
  el.value = String(settings[key]);
  paint();
  el.addEventListener("input", () => {
    settings[key] = Number(el.value);
    if (key === "wpm") {
      $("fw").min = String(settings.wpm);
      if (settings.fw < settings.wpm) {
        settings.fw = settings.wpm;
        $("fw").value = String(settings.fw);
        $("fwV").textContent = String(settings.fw);
      }
    }
    paint();
    saveSettings();
    if (after) after();
    refreshEst();
    if (gray && (key === "threshold")) rebuildBits();
  });
}

/* ---------- meter ---------- */

function ensureAudio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.25;
  fbuf = new Float32Array(an.frequencyBinCount);
  outGain = ctx.createGain();
  outGain.gain.value = 0;
  an.connect(outGain);
  outGain.connect(ctx.destination);
  return ctx;
}

function setAudible(on) {
  if (outGain) outGain.gain.setTargetAtTime(on ? 1 : 0, ensureAudio().currentTime, 0.01);
}

function bandDb() {
  if (!an || !fbuf || !ctx) return -120;
  an.getFloatFrequencyData(fbuf);
  const hz = ctx.sampleRate / an.fftSize;
  const a = Math.max(0, Math.floor(300 / hz));
  const b = Math.min(fbuf.length - 1, Math.ceil(3400 / hz));
  let s = 0;
  for (let i = a; i <= b; i++) s += 10 ** (fbuf[i] / 10);
  const db = 10 * Math.log10(s / (b - a + 1) + 1e-12);
  return Number.isFinite(db) ? db : -120;
}

function paintMeter() {
  meterDb = bandDb();
  const cv = $("meter");
  const g = cv.getContext("2d");
  const W = cv.width;
  const H = cv.height;
  g.fillStyle = "#141f0e";
  g.fillRect(0, 0, W, H);
  const level = Math.max(0, Math.min(1, (meterDb + 100) / 100));
  const N = 30;
  const bw = W / N;
  for (let i = 0; i < N; i++) {
    const x = i * bw;
    const on = x < level * W;
    const f = i / N;
    g.fillStyle = on ? (f > 0.8 ? "#ff5b4a" : f > 0.6 ? "#ffb43a" : "#c8f56a") : "#c8f56a33";
    const h = 10 + (H - 22) * (i / N);
    g.fillRect(x + 3, H - 6 - h, bw - 6, h);
  }
  if (listening && listenKind === "speech" && voiceState.mode !== "cal") {
    const map = (db) => Math.max(0, Math.min(1, (db + 100) / 100)) * W;
    g.fillStyle = "#ffcc00";
    g.fillRect(map(voiceState.floorDb) - 2, 0, 4, H);
    g.fillStyle = "#ff5252";
    g.fillRect(map(voiceState.floorDb + settings.squelchMargin) - 2, 0, 4, H);
  }
  g.fillStyle = "#c8f56a";
  g.font = "bold 22px monospace";
  const label = $("lamp").classList.contains("live") ? "ON AIR" : listening ? "RX" : "STANDBY";
  g.fillText(label, 10, 24);
}

function startMeter() {
  if (meterLoop) return;
  meterLoop = true;
  const loop = () => {
    paintMeter();
    if (meterLoop) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function stopMeter() {
  meterLoop = false;
  paintMeter();
}

/* ---------- transmit ---------- */

function primeSpeech() {
  try {
    const u = new SpeechSynthesisUtterance("\u200b");
    u.volume = 0.01;
    u.rate = 10;
    speechSynthesis.speak(u);
  } catch { /* optional */ }
}

async function sleepAbort(ms, gen) {
  let left = ms;
  while (left > 0) {
    if (gen !== txGen) return false;
    const step = Math.min(100, left);
    await sleep(step);
    left -= step;
  }
  return gen === txGen;
}

function startKeeper() {
  const audio = ensureAudio();
  stopKeeper();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  keeper = osc;
}

function stopKeeper() {
  if (!keeper) return;
  try { keeper.stop(); } catch { /* already stopped */ }
  keeper = null;
}

async function runTx(build) {
  if (busy || listening) return;
  const gen = ++txGen;
  busy = true;
  chrome();
  try {
    const audio = ensureAudio();
    audio.resume();
    startKeeper();
    const job = await build();
    if (!job || gen !== txGen) return;
    audio.resume();
    primeSpeech();
    const secs = Math.max(0, Math.round(settings.ptt));
    if (secs > 0) {
      setLamp("ptt");
      $("arm").hidden = false;
      $("armk").textContent = "PRESS PTT NOW";
      $("arms").textContent = "Hold the radio key. Sound starts at zero. Keep holding through ON AIR.";
      for (let s = secs; s > 0; s--) {
        $("armn").textContent = String(s);
        setStatus(`PRESS PTT NOW — sound in ${s} s`);
        if (!(await sleepAbort(1000, gen))) return;
      }
    }
    setLamp("live");
    $("arm").hidden = false;
    $("armk").textContent = "ON AIR";
    $("arms").textContent = "Keep the radio PTT held until this overlay clears.";
    setAudible(true);
    startMeter();
    try { navigator.vibrate?.(40); } catch { /* no haptics */ }
    const ok = await job.play(gen);
    $("arm").hidden = true;
    $("armk").textContent = "PRESS PTT NOW";
    if (!ok || gen !== txGen) return;
    setStatus("Transmission finished. Release PTT.");
    await logItem(job.record);
  } catch (err) {
    if (gen === txGen) setStatus(err.message || "Transmission failed.");
  } finally {
    $("arm").hidden = true;
    stopKeeper();
    setAudible(false);
    if (gen === txGen) {
      busy = false;
      setLamp("standby");
      stopMeter();
      chrome();
    }
  }
}

function stopAll() {
  txGen++;
  openGen++;
  busy = false;
  opening = false;
  const was = listening;
  listening = false;
  $("arm").hidden = true;
  setLamp("standby");
  setProg(0);
  stopKeeper();
  if (player) {
    try { player.disconnect(); } catch { /* already gone */ }
    try { player.stop(); } catch { /* already ended */ }
    player = null;
  }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  teardownListen();
  setAudible(false);
  stopMeter();
  setStatus(was ? "Receiver stopped." : "Stopped.");
  chrome();
}

async function transmitPrepared(kind, rawText) {
  return runTx(async () => {
    const prep = prepareMessage(rawText, txOpts());
    if (!prep.events.length) {
      setStatus(prep.unknown.length ? "Nothing to send — those characters have no International Morse." : "Nothing to send.");
      return null;
    }
    if (prep.seconds > 180) {
      const ok = confirm(`This transmission is about ${formatDuration(prep.seconds)} of tone. Send it?`);
      if (!ok) {
        setStatus("Transmission cancelled.");
        return null;
      }
    }
    setStatus("Preparing sidetone…");
    await sleep(20);
    const rendered = renderPcm(prep.events, {
      sampleRate: 16000,
      freq: settings.freq,
      volume: volumeGain(),
      attack: 0.005,
      lead: 0.03,
      pad: tailSec(),
    });
    lastTx = {
      pcm: rendered.pcm,
      sampleRate: rendered.sampleRate,
      freq: settings.freq,
      charWpm: prep.charWpm,
      morse: prep.morse,
      text: prep.payload,
    };
    return {
      record: {
        dir: "tx",
        kind,
        text: prep.payload,
        morse: prep.morse,
        seconds: prep.seconds,
        wpm: settings.wpm,
        images: kind === "image" ? imagesFromText(prep.payload) : [],
      },
      async play(gen) {
        const audio = ensureAudio();
        try { await audio.resume(); } catch { /* play the lamp on the wall clock anyway */ }
        stopKeeper();
        const buf = audio.createBuffer(1, rendered.pcm.length, rendered.sampleRate);
        buf.copyToChannel(rendered.pcm, 0);
        const src = audio.createBufferSource();
        src.buffer = buf;
        src.connect(an);
        player = src;
        setAudible(true);
        try { src.start(); } catch { /* lamp still holds for the full tone */ }
        // Some browsers fire onended immediately when the audio device is blocked.
        // The lamp follows the sidetone length either way, so PTT is not dropped early.
        const ms = Math.max(400, Math.ceil((Number.isFinite(buf.duration) ? buf.duration : rendered.seconds) * 1000));
        const started = Date.now();
        while (Date.now() - started < ms) {
          if (gen !== txGen) {
            try { src.stop(); } catch { /* already ended */ }
            player = null;
            return false;
          }
          const left = Math.max(0, Math.ceil((ms - (Date.now() - started)) / 1000));
          $("armn").textContent = String(left);
          setStatus(`ON AIR — ${left} s left, keep PTT held`);
          if (audio.state !== "running") {
            try { await audio.resume(); } catch { /* ignore */ }
          }
          await sleep(200);
        }
        try { src.disconnect(); } catch { /* already ended */ }
        player = null;
        return gen === txGen;
      },
    };
  });
}

function transmitCw() {
  return transmitPrepared("cw", $("cwText").value);
}

function transmitImage() {
  if (!frameText) {
    setStatus("Load an image or the test card first.");
    return;
  }
  return transmitPrepared("image", frameText);
}

function transmitVoice() {
  const text = $("ttsText").value.trim();
  if (!text) {
    setStatus("Type something to say.");
    return;
  }
  if (!window.speechSynthesis) {
    setStatus("This browser has no built-in speech synthesis.");
    return;
  }
  const spoken = [settings.callsign.trim(), text].filter(Boolean).join(". ");
  const record = { dir: "tx", kind: "voice", text: spoken, morse: "", seconds: 0, wpm: 0, images: [] };
  return runTx(async () => ({
    record,
    play(gen) {
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(spoken);
        const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === settings.ttsVoice);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = settings.ttsRate;
        u.pitch = settings.ttsPitch;
        u.volume = Math.max(0.05, volumeGain());
        const started = performance.now();
        let settled = false;
        const keep = setInterval(() => {
          try { speechSynthesis.pause(); speechSynthesis.resume(); } catch { /* ignore */ }
        }, 8000);
        const done = async (ok) => {
          if (settled) return;
          settled = true;
          clearInterval(keep);
          if (!ok || gen !== txGen) return resolve(false);
          record.seconds = (performance.now() - started) / 1000;
          resolve(await sleepAbort(tailSec() * 1000, gen));
        };
        u.onend = () => done(true);
        u.onerror = (event) => {
          const code = event?.error || "";
          if (code === "synthesis-failed" || code === "voice-unavailable" || code === "language-unavailable") {
            setStatus("No speech voice on this device, so nothing was spoken. The PTT countdown still ran.");
          } else if (code !== "canceled" && code !== "interrupted") {
            setStatus("Speech did not play" + (code ? " (" + code + ")" : "") + ".");
          }
          done(false);
        };
        try { speechSynthesis.resume(); speechSynthesis.cancel(); } catch { /* ignore */ }
        setTimeout(() => {
          if (gen !== txGen) return resolve(false);
          speechSynthesis.speak(u);
        }, 40);
      });
    },
  }));
}

/* ---------- image ---------- */

function drawBits(canvas, bits, w, h) {
  const scale = Math.max(1, Math.min(12, Math.floor(280 / w)));
  canvas.width = w * scale;
  canvas.height = h * scale;
  const g = canvas.getContext("2d");
  const img = g.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const black = bits[y * w + x] ? 1 : 0;
      const v = black ? 18 : 232;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * canvas.width + (x * scale + dx)) * 4;
          img.data[i] = v;
          img.data[i + 1] = black ? v : 236;
          img.data[i + 2] = black ? v : 214;
          img.data[i + 3] = 255;
        }
      }
    }
  }
  g.putImageData(img, 0, 0);
}

function drawFrames(host, frames) {
  host.replaceChildren();
  for (const frame of frames) {
    const canvas = document.createElement("canvas");
    canvas.className = "preview";
    drawBits(canvas, frame.bits, frame.w, frame.h);
    host.appendChild(canvas);
  }
}

function bitmapToGray(bmp, res) {
  const side = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - side) / 2;
  const sy = (bmp.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.drawImage(bmp, sx, sy, side, side, 0, 0, res, res);
  const im = g.getImageData(0, 0, res, res);
  const out = new Float32Array(res * res);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.299 * im.data[i * 4] + 0.587 * im.data[i * 4 + 1] + 0.114 * im.data[i * 4 + 2];
  }
  return out;
}

function rebuildBits() {
  if (!gray) return;
  const res = gray.length === settings.res * settings.res ? settings.res : Math.round(Math.sqrt(gray.length));
  const bits = toBits(gray, res, res, settings.threshold, settings.dither);
  const frame = encodeImage(bits, res, res);
  frameText = frame.text;
  $("imgText").value = frame.text;
  drawBits($("preview"), bits, res, res);
  const black = bits.reduce((a, b) => a + (b ? 1 : 0), 0);
  const prep = prepareMessage(frame.text, txOpts());
  $("imgMeta").textContent = `${res}×${res} · ${black} black · checksum ${frame.checksum} · tone ${formatDuration(prep.seconds)}`;
  if (mode === "img") $("est").textContent = `tone ${formatDuration(prep.seconds)} + tail`;
}

async function useBitmap(bmp) {
  if (sourceBmp && sourceBmp !== bmp) {
    try { sourceBmp.close(); } catch { /* already closed */ }
  }
  sourceBmp = bmp;
  gray = bitmapToGray(bmp, settings.res);
  rebuildBits();
  setStatus("Picture ready. TRANSMIT IMAGE plays it as Morse after the PTT countdown.");
}

async function onImageFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    await useBitmap(bmp);
  } catch (err) {
    setStatus("Could not read that image: " + err.message);
  }
}

async function loadTestCard() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const g = canvas.getContext("2d");
  g.fillStyle = "#f4f1e6";
  g.fillRect(0, 0, 320, 200);
  const grd = g.createRadialGradient(150, 100, 16, 150, 100, 110);
  grd.addColorStop(0, "#111");
  grd.addColorStop(1, "#f4f1e6");
  g.fillStyle = grd;
  g.beginPath();
  g.arc(150, 100, 88, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#111";
  g.fillRect(36, 28, 28, 144);
  g.font = "bold 72px sans-serif";
  g.fillText("M", 196, 122);
  await useBitmap(await createImageBitmap(canvas));
}

function imagesFromText(text) {
  return decodeImages(text).map((frame) => ({
    w: frame.w,
    h: frame.h,
    bits: Array.from(frame.bits),
    checksum: frame.checksum,
  }));
}

/* ---------- paste / cw receive ---------- */

function interpretPaste(raw) {
  const body = String(raw ?? "").trim();
  if (!body) return { text: "", frames: [], fromMorse: false, waiting: false };
  const stripped = body.replace(/[\s/|]+/g, "");
  const fromMorse = stripped.length > 0 && /^[.\-]+$/.test(stripped);
  const text = fromMorse ? decodeMorse(body) : body;
  const frames = decodeImages(text);
  return { text, frames, fromMorse, waiting: !frames.length && hasImageHeader(text) };
}

function showPaste(logIt) {
  const result = interpretPaste($("paste").value);
  $("pasteOut").textContent = result.text || "—";
  drawFrames($("pastePics"), result.frames);
  if (!result.text) $("pasteMsg").textContent = "Paste decoded letters, or a string of dots and dashes.";
  else if (result.frames.length) $("pasteMsg").textContent = `Rebuilt ${result.frames.length} picture${result.frames.length > 1 ? "s" : ""}.`;
  else if (result.waiting) $("pasteMsg").textContent = "PIXM1 header found, but the frame is incomplete or the checksum does not match.";
  else $("pasteMsg").textContent = result.fromMorse ? "Decoded as plain text. No picture frame in it." : "Plain text. No picture frame in it.";
  if (logIt && result.text) {
    logItem({
      dir: "rx",
      kind: result.frames.length ? "image-rx" : "paste",
      text: result.text,
      morse: result.fromMorse ? $("paste").value.trim() : "",
      seconds: 0,
      wpm: 0,
      images: result.frames.map((frame) => ({ w: frame.w, h: frame.h, bits: Array.from(frame.bits), checksum: frame.checksum })),
    });
  }
}

function paintCw() {
  if (!cwDec) return;
  const live = (cwDec.text + (cwDec.partial ? " [" + cwDec.partial + "]" : "")).trim();
  $("cwOut").textContent = live || "—";
  $("cwLive").textContent = `Hearing about ${cwDec.wpm.toFixed(0)} WPM element speed.`;
  const frames = decodeImages(cwDec.text);
  const key = frames.map((frame) => frame.checksum).join(",");
  if (key !== cwShown) {
    cwShown = key;
    drawFrames($("cwPics"), frames);
    if (frames.length) setStatus(`Picture rebuilt ${frames[0].w}×${frames[0].h}. Still listening.`);
  } else if (!frames.length && hasImageHeader(cwDec.text) && !cwWaitNoted) {
    cwWaitNoted = true;
    setStatus("Picture header heard — waiting for the rest of the frame.");
  }
}

function clearCw() {
  cwDec = new CwDecoder({ wpm: settings.rxWpm, auto: settings.autoWpm });
  cwShown = "";
  cwWaitNoted = false;
  $("cwOut").textContent = "—";
  $("cwPics").replaceChildren();
}

async function decodeLastSidetone() {
  if (listening || busy || opening) {
    setStatus("Stop the receiver before checking the sidetone.");
    return;
  }
  if (!lastTx) {
    setStatus("Transmit CW or an image first. The sidetone stays in memory for this check.");
    return;
  }
  setMode("rx");
  setRx("cw");
  setStatus("Decoding the last sidetone…");
  await sleep(20);
  const tr = new ToneTracker(lastTx.sampleRate, lastTx.freq, {
    marginDb: settings.cwMargin,
    winSec: 0.01,
    hopSec: 0.004,
    calibrateSec: 0,
    floorDb: -120,
  });
  tr.push(lastTx.pcm);
  const { text, wpm } = decodeEdges(tr.finish(), { wpm: lastTx.charWpm, auto: settings.autoWpm });
  cwDec = new CwDecoder({ wpm, auto: false });
  cwDec.text = text;
  paintCw();
  const frames = decodeImages(text);
  await logItem({
    dir: "rx",
    kind: frames.length ? "image-rx" : "cw-rx",
    text,
    morse: lastTx.morse,
    seconds: 0,
    wpm: Math.round(wpm),
    images: frames.map((frame) => ({ w: frame.w, h: frame.h, bits: Array.from(frame.bits), checksum: frame.checksum })),
  });
  setStatus(text ? `Sidetone decoded near ${wpm.toFixed(0)} WPM.` : "Sidetone produced no characters. Raise the volume or lower the CW margin.");
}

/* ---------- microphone ---------- */

const CAPTURE = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('mr-cap',P);`;

async function ensureWorklet(audio) {
  if (workletOk) return true;
  if (!audio.audioWorklet) return false;
  try {
    if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([CAPTURE], { type: "application/javascript" }));
    await audio.audioWorklet.addModule(workletUrl);
    workletOk = true;
    return true;
  } catch {
    return false;
  }
}

function teardownListen() {
  listening = false;
  try { micSrc && micSrc.disconnect(); } catch { /* ignore */ }
  try { capNode && capNode.disconnect(); } catch { /* ignore */ }
  try { micMute && micMute.disconnect(); } catch { /* ignore */ }
  micSrc = null;
  capNode = null;
  micMute = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (recog) {
    try { recog.onend = null; recog.stop(); } catch { /* ignore */ }
    recog = null;
  }
  tracker = null;
}

async function openMic() {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const audio = ensureAudio();
  await audio.resume();
  stream = media;
  micSrc = audio.createMediaStreamSource(media);
  micSrc.connect(an);
  setAudible(false);
  if (await ensureWorklet(audio)) {
    capNode = new AudioWorkletNode(audio, "mr-cap");
    capNode.port.onmessage = (event) => onCapture(event.data);
  } else {
    capNode = audio.createScriptProcessor(2048, 1, 1);
    capNode.onaudioprocess = (event) => onCapture(new Float32Array(event.inputBuffer.getChannelData(0)));
  }
  micMute = audio.createGain();
  micMute.gain.value = 0;
  micSrc.connect(capNode);
  capNode.connect(micMute);
  micMute.connect(audio.destination);
  return audio;
}

function onCapture(samples) {
  if (!listening) return;
  if (listenKind === "cw" && tracker && cwDec) {
    tracker.push(samples);
    const edges = tracker.drain();
    if (!edges.length) return;
    for (const edge of edges) cwDec.feed(edge.kind, edge.ms);
    paintCw();
    return;
  }
  if (listenKind === "speech") voicePush(samples);
}

async function startCwListen() {
  if (busy || listening || opening) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("This browser has no microphone API.");
    return;
  }
  const gen = ++openGen;
  opening = true;
  chrome();
  clearCw();
  cwDec = new CwDecoder({ wpm: settings.rxWpm, auto: settings.autoWpm });
  try {
    const audio = await openMic();
    if (gen !== openGen) {
      teardownListen();
      return;
    }
    tracker = new ToneTracker(audio.sampleRate, settings.freq, {
      marginDb: settings.cwMargin,
      winSec: 0.012,
      hopSec: 0.004,
      calibrateSec: 0.4,
      floorDb: -55,
    });
    if (gen !== openGen) {
      teardownListen();
      return;
    }
    listening = true;
    listenKind = "cw";
    startMeter();
    setStatus("CW ear open. Key the other radio — characters will land here.");
  } catch (err) {
    teardownListen();
    setStatus("Microphone blocked: " + err.message);
  } finally {
    opening = false;
    chrome();
  }
}

async function stopListenAndLog() {
  if (listenKind === "cw" && cwDec) {
    if (tracker) {
      for (const edge of tracker.finish()) cwDec.feed(edge.kind, edge.ms);
    }
    cwDec.finish();
    paintCw();
    const text = cwDec.text.replace(/\s+/g, " ").trim();
    if (text) {
      const frames = decodeImages(text);
      await logItem({
        dir: "rx",
        kind: frames.length ? "image-rx" : "cw-rx",
        text,
        morse: "",
        seconds: 0,
        wpm: Math.round(cwDec.wpm),
        images: frames.map((frame) => ({ w: frame.w, h: frame.h, bits: Array.from(frame.bits), checksum: frame.checksum })),
      });
    }
  }
  teardownListen();
  stopMeter();
  chrome();
}

/* ---------- voice squelch + whisper ---------- */

function resetVoiceCal() {
  voiceState.mode = "cal";
  voiceState.calVals = [];
  voiceState.calStart = performance.now();
  voiceState.preroll = [];
  voiceState.preLen = 0;
  voiceState.clip = [];
  voiceState.clipLen = 0;
  voiceState.aboveMs = 0;
  voiceState.silMs = 0;
}

function voicePush(samples) {
  const rate = ctx.sampleRate;
  const ms = (samples.length / rate) * 1000;
  const db = bandDb();
  voiceState.lastDb = db;
  const st = voiceState;
  if (st.mode === "cal") {
    st.calVals.push(db);
    const p = (performance.now() - st.calStart) / 2000;
    setProg(Math.min(1, p));
    if (p >= 1) {
      const sorted = [...st.calVals].sort((a, b) => a - b);
      st.floorDb = sorted[Math.floor(sorted.length * 0.6)] || -90;
      st.mode = "idle";
      setProg(0);
      setStatus(`Squelch set. Noise floor ${st.floorDb.toFixed(1)} dB. Listening for voice…`);
    }
    return;
  }
  const thr = st.floorDb + settings.squelchMargin;
  if (st.mode === "idle") {
    st.preroll.push(samples);
    st.preLen += samples.length;
    while (st.preroll.length > 1 && st.preLen - st.preroll[0].length >= 0.3 * rate) {
      st.preLen -= st.preroll.shift().length;
    }
    if (db > thr) {
      st.aboveMs += ms;
      if (st.aboveMs >= 150) {
        st.mode = "rec";
        st.clip = st.preroll.slice();
        st.clipLen = st.preLen;
        st.preroll = [];
        st.preLen = 0;
        st.silMs = 0;
        setStatus("Voice squelch open — recording.");
      }
    } else {
      st.aboveMs = 0;
      if (db < thr - 2) st.floorDb = st.floorDb * 0.995 + db * 0.005;
    }
    return;
  }
  st.clip.push(samples);
  st.clipLen += samples.length;
  if (db > thr - 3) st.silMs = 0;
  else st.silMs += ms;
  if (st.silMs >= settings.hang * 1000 || st.clipLen >= 25 * rate) finishVoiceClip();
}

function finishVoiceClip() {
  const chunks = voiceState.clip.slice();
  const rate = ctx.sampleRate;
  const dur = voiceState.clipLen / rate;
  voiceState.clip = [];
  voiceState.clipLen = 0;
  voiceState.aboveMs = 0;
  voiceState.silMs = 0;
  voiceState.mode = "idle";
  if (dur < 0.7) {
    setStatus("Short burst ignored. Listening…");
    return;
  }
  const n = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Float32Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  voiceQ.push({ samples: all, rate, dur });
  pumpVoice();
}

function resample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    const a = input[j] || 0;
    const b = input[Math.min(input.length - 1, j + 1)] || a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

async function loadWhisper() {
  if (whisperPipe && whisperId === settings.whisperModel) return whisperPipe;
  if (whisperPipe) {
    try { await whisperPipe.dispose(); } catch { /* ignore */ }
    whisperPipe = null;
  }
  setStatus("Loading the speech model. The first run downloads it, then this browser keeps it.");
  const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  whisperPipe = await pipeline("automatic-speech-recognition", settings.whisperModel, {
    quantized: true,
    progress_callback(info) {
      if (info && info.status === "progress" && info.progress != null) {
        setProg(Math.max(0, Math.min(1, info.progress / 100)));
        setStatus(`Downloading ${info.file || "model"}… ${Math.round(info.progress)}%`);
      } else if (info && info.status) {
        setStatus(`Speech model: ${info.status}${info.file ? " " + info.file : ""}`);
      }
    },
  });
  whisperId = settings.whisperModel;
  setProg(0);
  return whisperPipe;
}

async function transcribe(samples, rate) {
  const pipe = await loadWhisper();
  const audio = resample(samples, rate, 16000);
  const opts = { task: "transcribe", chunk_length_s: 30 };
  if (settings.whisperLang) opts.language = settings.whisperLang;
  const result = await pipe(audio, opts);
  return String(result?.text || "").trim();
}

async function pumpVoice() {
  if (voiceBusy) return;
  voiceBusy = true;
  while (voiceQ.length) {
    const job = voiceQ.shift();
    setStatus(`Clip ${job.dur.toFixed(1)} s — transcribing on this device…`);
    try {
      const text = await transcribe(job.samples, job.rate);
      if (text) {
        $("speechOut").textContent = ($("speechOut").textContent && $("speechOut").textContent !== "—"
          ? $("speechOut").textContent + "\n"
          : "") + text;
        await logItem({ dir: "rx", kind: "whisper", text, morse: "", seconds: job.dur, wpm: 0, images: [] });
        setStatus("Heard voice. Listening…");
      } else setStatus("No speech in that clip. Listening…");
    } catch (err) {
      setStatus("Transcription failed: " + (err.message || err) + " — you can switch the engine to Web Speech.");
    }
  }
  voiceBusy = false;
  setProg(0);
}

async function startVoiceListen() {
  if (busy || listening || opening) return;
  if (settings.sttMode === "webspeech") return startWebSpeech();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("This browser has no microphone API. Try the Web Speech engine.");
    return;
  }
  const gen = ++openGen;
  opening = true;
  chrome();
  resetVoiceCal();
  try {
    await openMic();
    if (gen !== openGen) {
      teardownListen();
      return;
    }
    listening = true;
    listenKind = "speech";
    startMeter();
    setStatus("Keep the channel quiet — measuring the noise floor…");
  } catch (err) {
    teardownListen();
    setStatus("Microphone blocked: " + err.message);
  } finally {
    opening = false;
    chrome();
  }
}

function startWebSpeech() {
  if (busy || listening || opening) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("Web Speech is not in this browser. Use Whisper, or try Chrome.");
    return;
  }
  speechFinal = "";
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  const lang = settings.whisperLang === "hi" ? "hi-IN" : settings.whisperLang === "en" ? "en-US" : (navigator.language || "en-US");
  recog.lang = lang;
  recog.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const said = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const line = said.trim();
        if (!line) continue;
        speechFinal += (speechFinal ? "\n" : "") + line;
        logItem({ dir: "rx", kind: "webspeech", text: line, morse: "", seconds: 0, wpm: 0, images: [] });
      } else interim += said;
    }
    $("speechOut").textContent = (speechFinal + (interim ? "\n" + interim : "")).trim() || "—";
  };
  recog.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    setStatus("Web Speech: " + event.error);
  };
  recog.onend = () => {
    if (listening && listenKind === "webspeech") {
      try { recog.start(); } catch { /* restart race */ }
    }
  };
  try {
    recog.start();
  } catch (err) {
    setStatus("Web Speech did not start: " + err.message);
    recog = null;
    return;
  }
  listening = true;
  listenKind = "webspeech";
  chrome();
  setStatus("Web Speech is listening. This fallback may use the browser vendor’s recognizer.");
}

/* ---------- log ---------- */

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open("morseRadio", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("log", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function logItem(entry) {
  const row = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    t: Date.now(),
    dir: entry.dir,
    kind: entry.kind,
    text: entry.text || "",
    morse: entry.morse || "",
    seconds: entry.seconds || 0,
    wpm: entry.wpm || 0,
    images: entry.images || [],
  };
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const req = db.transaction("log", "readwrite").objectStore("log").put(row);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    setStatus("Could not store the log: " + err.message);
  }
  await renderLog();
  return row;
}

async function allLog() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction("log", "readonly").objectStore("log").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function deleteLog(id) {
  const db = await openDB();
  await new Promise((resolve) => {
    const req = db.transaction("log", "readwrite").objectStore("log").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  await renderLog();
}

function kindLabel(kind) {
  return {
    cw: "CW TX",
    image: "IMAGE TX",
    voice: "VOICE TX",
    "cw-rx": "CW RX",
    "image-rx": "IMAGE RX",
    paste: "PASTE",
    whisper: "WHISPER",
    webspeech: "WEB SPEECH",
  }[kind] || kind;
}

async function renderLog() {
  const rows = (await allLog()).sort((a, b) => b.t - a.t);
  $("logCount").textContent = rows.length ? `${rows.length} stored in this browser` : "Nothing stored yet.";
  const host = $("logList");
  host.replaceChildren();
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "clip";
    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("span");
    const bits = [row.dir === "tx" ? "TX" : "RX", kindLabel(row.kind), new Date(row.t).toLocaleString()];
    if (row.wpm) bits.push(row.wpm + " WPM");
    if (row.seconds) bits.push(row.seconds.toFixed(1) + " s");
    when.textContent = bits.join(" · ");
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "✕";
    rm.addEventListener("click", () => deleteLog(row.id));
    meta.append(when, rm);
    const tx = document.createElement("div");
    tx.className = "tx";
    tx.textContent = row.text || "(empty)";
    el.append(meta, tx);
    if (row.morse) {
      const morse = document.createElement("div");
      morse.className = "hint";
      morse.textContent = row.morse;
      el.append(morse);
    }
    if (row.images?.length) {
      const pics = document.createElement("div");
      pics.className = "pics";
      drawFrames(pics, row.images.map((img) => ({ ...img, bits: Uint8Array.from(img.bits) })));
      el.append(pics);
    }
    host.append(el);
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1500);
}

function stamp(t) {
  return new Date(t).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function toPbm(img) {
  let out = `P1\n${img.w} ${img.h}\n`;
  for (let y = 0; y < img.h; y++) {
    const row = [];
    for (let x = 0; x < img.w; x++) row.push(img.bits[y * img.w + x] ? "1" : "0");
    out += row.join(" ") + "\n";
  }
  return out;
}

function logText(rows) {
  return rows.map((row) => {
    const head = `[${new Date(row.t).toISOString()}] ${row.dir.toUpperCase()} ${kindLabel(row.kind)}` +
      (row.wpm ? ` ${row.wpm} WPM` : "") + (row.seconds ? ` ${row.seconds.toFixed(1)}s` : "");
    return `${head}\n${row.text || ""}\n${row.morse ? row.morse + "\n" : ""}`;
  }).join("\n");
}

async function exportJson() {
  const rows = (await allLog()).sort((a, b) => a.t - b.t);
  if (!rows.length) return setStatus("Log is empty.");
  downloadBlob(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), `morse-radio-${stamp(Date.now())}.json`);
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (~c) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const centralLen = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralLen, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

async function exportZip() {
  const rows = (await allLog()).sort((a, b) => a.t - b.t);
  if (!rows.length) return setStatus("Log is empty.");
  const enc = new TextEncoder();
  const files = [
    { name: "log.txt", data: enc.encode(logText(rows)) },
    { name: "log.json", data: enc.encode(JSON.stringify(rows, null, 2)) },
  ];
  rows.forEach((row, index) => {
    (row.images || []).forEach((img, imageIndex) => {
      files.push({ name: `images/${index + 1}-${imageIndex + 1}-${img.w}x${img.h}.pbm`, data: enc.encode(toPbm(img)) });
    });
  });
  downloadBlob(zip(files), `morse-radio-${stamp(Date.now())}.zip`);
  setStatus("Exported the log.");
}

async function clearLog() {
  if (!confirm("Delete the stored log from this browser?")) return;
  const db = await openDB();
  await new Promise((resolve) => {
    const req = db.transaction("log", "readwrite").objectStore("log").clear();
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  await renderLog();
  setStatus("Log cleared.");
}

/* ---------- voices ---------- */

function loadVoices() {
  if (!window.speechSynthesis) {
    $("voiceNote").textContent = "This browser has no speechSynthesis voices.";
    return;
  }
  const voices = speechSynthesis.getVoices();
  const sel = $("ttsVoice");
  const prev = settings.ttsVoice;
  sel.replaceChildren();
  const rank = (voice) => (voice.lang.toLowerCase().startsWith("hi") ? 0 : voice.lang.toLowerCase().startsWith("en") ? 1 : 2);
  const sorted = voices.slice().sort((a, b) => rank(a) - rank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  if (!sorted.length) {
    sel.add(new Option("Default browser voice", ""));
  }
  for (const voice of sorted) sel.add(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
  if ([...sel.options].some((opt) => opt.value === prev)) sel.value = prev;
  const hindi = voices.some((voice) => voice.lang.toLowerCase().startsWith("hi"));
  const english = voices.some((voice) => voice.lang.toLowerCase().startsWith("en"));
  $("voiceNote").textContent = `On this device: ${english ? "English" : "no English voice"}${hindi ? ", Hindi" : ", no Hindi voice"}. The list is whatever the operating system installed.`;
}

/* ---------- wire up ---------- */

function bindSettings() {
  $("callsign").value = settings.callsign;
  $("callsign").addEventListener("input", () => {
    settings.callsign = $("callsign").value.trim();
    saveSettings();
    refreshEst();
    if (gray) rebuildBits();
  });
  $("prosign").value = settings.prosign;
  $("prosign").addEventListener("change", () => {
    settings.prosign = $("prosign").value;
    saveSettings();
    refreshEst();
    if (gray) rebuildBits();
  });
  bindRange("ptt", "ptt", "pttV", (v) => String(Math.round(v)));
  bindRange("wpm", "wpm", "wpmV", (v) => String(Math.round(v)), () => { if (gray) rebuildBits(); });
  bindRange("fw", "fw", "fwV", (v) => String(Math.round(v)), () => { if (gray) rebuildBits(); });
  $("fw").min = String(settings.wpm);
  bindRange("freq", "freq", "freqV", (v) => String(Math.round(v)));
  bindRange("vol", "volume", "volV", (v) => String(Math.round(v)));
  bindRange("tail", "tail", "tailV", (v) => Number(v).toFixed(1));
  bindRange("cwMargin", "cwMargin", "cwMarginV", (v) => String(Math.round(v)));
  bindRange("mar", "squelchMargin", "marV", (v) => String(Math.round(v)));
  bindRange("hang", "hang", "hangV", (v) => Number(v).toFixed(1));
  bindRange("thr", "threshold", "thrV", (v) => String(Math.round(v)));
  bindRange("rxWpm", "rxWpm", "rxWpmV", (v) => String(Math.round(v)), () => {
    if (cwDec && !listening) cwDec.setHint(settings.rxWpm);
  });
  bindRange("ttsRate", "ttsRate", "rateV", (v) => Number(v).toFixed(2));
  bindRange("ttsPitch", "ttsPitch", "pitchV", (v) => Number(v).toFixed(2));
  $("res").value = String(settings.res);
  $("res").addEventListener("change", async () => {
    settings.res = Number($("res").value);
    saveSettings();
    if (sourceBmp) {
      gray = bitmapToGray(sourceBmp, settings.res);
      rebuildBits();
    }
  });
  $("dither").checked = settings.dither;
  $("dither").addEventListener("change", () => {
    settings.dither = $("dither").checked;
    saveSettings();
    rebuildBits();
  });
  $("autoWpm").checked = settings.autoWpm;
  $("autoWpm").addEventListener("change", () => {
    settings.autoWpm = $("autoWpm").checked;
    saveSettings();
    if (cwDec) cwDec.auto = settings.autoWpm;
  });
  $("sttMode").value = settings.sttMode;
  $("sttMode").addEventListener("change", () => {
    settings.sttMode = $("sttMode").value;
    saveSettings();
  });
  $("whisperModel").value = settings.whisperModel;
  $("whisperModel").addEventListener("change", () => {
    settings.whisperModel = $("whisperModel").value;
    saveSettings();
  });
  $("whisperLang").value = settings.whisperLang;
  $("whisperLang").addEventListener("change", () => {
    settings.whisperLang = $("whisperLang").value;
    saveSettings();
  });
  $("ttsVoice").addEventListener("change", () => {
    settings.ttsVoice = $("ttsVoice").value;
    saveSettings();
  });
}

function bindChrome() {
  document.querySelectorAll(".modes button").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  document.querySelectorAll(".submodes button").forEach((btn) => {
    btn.addEventListener("click", () => setRx(btn.dataset.rx));
  });
  $("cwText").addEventListener("input", refreshEst);
  $("ttsText").addEventListener("input", refreshEst);
  $("goBtn").addEventListener("click", () => {
    ensureAudio().resume();
    primeSpeech();
    if (mode === "cw") transmitCw();
    else if (mode === "img") transmitImage();
    else if (mode === "voice") transmitVoice();
    else if (mode === "rx" && rxSub === "paste") showPaste(true);
    else if (mode === "rx" && rxSub === "cw") startCwListen();
    else if (mode === "rx") startVoiceListen();
    else exportZip();
  });
  $("stopBtn").addEventListener("click", async () => {
    if (listening) {
      if (listenKind === "cw") await stopListenAndLog();
      else {
        if (voiceState.mode === "rec") finishVoiceClip();
        teardownListen();
        stopMeter();
        setStatus("Receiver stopped.");
        chrome();
      }
      return;
    }
    stopAll();
  });
  $("gearBtn").addEventListener("click", () => $("setModal").classList.add("on"));
  $("setClose").addEventListener("click", () => $("setModal").classList.remove("on"));
  $("setModal").addEventListener("click", (event) => {
    if (event.target.id === "setModal") $("setModal").classList.remove("on");
  });
  $("imgFile").addEventListener("change", () => onImageFile($("imgFile").files[0]));
  $("imgCam").addEventListener("change", () => onImageFile($("imgCam").files[0]));
  $("testCard").addEventListener("click", () => loadTestCard().catch((err) => setStatus(err.message)));
  $("copyFrame").addEventListener("click", async () => {
    if (!frameText) return;
    try {
      await navigator.clipboard.writeText(frameText);
      setStatus("Frame copied.");
    } catch {
      $("imgText").focus();
      $("imgText").select();
      setStatus("Clipboard blocked — the frame is selected so you can copy it.");
    }
  });
  $("paste").addEventListener("input", () => showPaste(false));
  $("decodeLast").addEventListener("click", () => decodeLastSidetone());
  $("clearCw").addEventListener("click", clearCw);
  $("recalBtn").addEventListener("click", () => {
    if (listening && listenKind === "speech") {
      if (voiceState.mode === "rec") finishVoiceClip();
      resetVoiceCal();
      setStatus("Keep the channel quiet — measuring the noise floor…");
    } else setStatus("Start voice listen first, then recalibrate.");
  });
  $("exportJson").addEventListener("click", () => exportJson());
  $("exportZip").addEventListener("click", () => exportZip());
  $("clearLog").addEventListener("click", () => clearLog());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("setModal").classList.remove("on");
      if (busy || listening) $("stopBtn").click();
    }
  });
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    $("installBtn").hidden = false;
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("installBtn").hidden = true;
  });
}

function boot() {
  bindSettings();
  bindChrome();
  loadVoices();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
  const hash = location.hash.replace("#", "");
  if (["cw", "img", "voice", "rx", "log"].includes(hash)) setMode(hash, true);
  else setMode("cw", true);
  refreshEst();
  paintMeter();
  renderLog();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

boot();
