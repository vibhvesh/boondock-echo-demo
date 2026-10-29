# Morse Radio

A static, keyless companion to the Boondock Echo demo. It lives in `morse-radio/` and does not replace the root `index.html`.

The radio is keyed by hand. This page only plays sound out of the device. You hold PTT when the screen says **PRESS PTT NOW**, keep holding while the lamp says **ON AIR**, then release. There is no VOX and no API key.

Open it on GitHub Pages at `/morse-radio/` (for example `https://<user>.github.io/<repo>/morse-radio/`).

## What it does

- **CW TX** — type text, see International Morse, play a click-free sidetone. WPM, optional Farnsworth spacing, tone frequency, and volume. Optional callsign prefix and an AR or SK prosign at the end.
- **Image** — center-crop to a square, resize to 8–64 px, one-bit threshold with Floyd–Steinberg dither, then a PIXM1 frame you can send as ordinary Morse. The page shows how long the tone will run.
- **Voice TX** — `speechSynthesis` voices already on the device (Hindi and English are listed first when the OS has them), with the same PTT countdown.
- **Receive** — paste decoder text (or dots and dashes) and rebuild a picture; listen to CW with a Goertzel tone detector and auto WPM; or open a voice squelch and transcribe with in-browser Whisper (`Xenova/whisper-tiny` or `base` via transformers.js). Web Speech API is an optional fallback.
- **Log** — sent and received text and pictures in IndexedDB, exportable as JSON or a zip (text, JSON, and PBM pictures).

Settings (PTT wait, tail, squelch, callsign) stay in `localStorage`. The app is an installable PWA (manifest, service worker, standalone display).

Check the last transmission without a second radio: **Receive → CW EAR → DECODE LAST SIDETONE**. That runs the same tone detector on the sidetone that was just played.

## Wiring

1. Cable the phone or laptop **headphone out** into the radio **mic or line input**. A mic input is easy to overdrive. A series resistor around 1 kΩ, or the radio’s line input, keeps the level honest. Set the page volume so the radio’s meter moves and the audio is not flat-topped.
2. This page never keys the radio. When you tap transmit, a countdown (default **3 s**, slider on the panel, including 0) shows **PRESS PTT NOW**. Hold the radio PTT. Audio starts at zero. Keep holding through **ON AIR**, including the short tail after the sound, then release.
3. To receive CW, put the radio speaker near this device’s mic, or feed a padded speaker output into the mic jack. In **CW TX**, set the tone to the pitch you will actually hear, then **Receive → CW EAR → LISTEN CW**. The element-speed slider is the character speed. Farnsworth text is slower than that. Start the ear on a quiet channel so the threshold can settle. Turn echo cancellation, noise suppression, and AGC off in the capture constraints (the page already asks for that) so the tone is not filtered out.
4. To receive voice, use **Receive → VOICE**. Whisper runs on the device after a one-time download from the public jsDelivr and Hugging Face CDNs. No key. The squelch measures the noise floor, then records while the voice band is above it, with a hang time, the same idea as the Echo demo. **Web Speech API** is the fallback. In Chrome that recognizer may send audio to the browser vendor; Whisper does not.

Use a dummy load or an antenna that is legal where you are. The page only plays sound.

## PIXM1 image protocol

The picture is ordinary Morse text. A standard decoder’s letters can be pasted back into **Receive → PASTE** to rebuild it. The frame uses only `A–Z` and `0–9`. Spaces, newlines, and punctuation are optional and ignored, so a decoder that splits every character still round-trips.

The letter `O` is never used. Inside numbers, `O` is read as `0` and `I` as `1`.

After uppercasing and deleting every character that is not a letter or digit, a frame is:

```
PIXM1 + WW + HH + ROWS + C + AAAAAA + END
```

| Field | Meaning |
| --- | --- |
| `PIXM1` | Magic header. `PIXMI` is accepted when the final `1` was copied as `I`. |
| `WW` | Width, two digits, `01`–`64`. Eight pixels is `08`, not `8`. |
| `HH` | Height, two digits, same range. |
| `ROWS` | Run-length rows, concatenated, no separator. |
| `C` | Checksum marker. |
| `AAAAAA` | Six-digit checksum defined below. |
| `END` | Required end marker. |

A run is `W` (white, bit 0) or `B` (black, bit 1) plus a decimal length with no padding, such as `B12` or `W3`. Lengths are at least 1. The runs in a row add up to the width. The decoder fills a row until it has `width` pixels, then starts the next row. There are exactly `height` rows.

Checksum over the pixels in row-major order, black = 1:

```
a = 0
b = 0
for each bit:
  a = (a + bit) mod 255
  b = (b + a) mod 255
checksum = three digits of a, then three digits of b
```

A frame is kept only when the checksum matches and `END` follows it. Text before or after the frame is plain traffic. A callsign prefix and an `<AR>` or `<SK>` suffix do not hide the frame.

### Worked example

2×2 checkerboard, top-left black:

```
1 0
0 1
```

Rows: `B1W1` and `W1B1`. Bits `1,0,0,1` produce checksum `002005`.

Spaced, which is what the page sends (each token is a Morse word):

```
PIXM1 02 02 B1W1 W1B1 C002005 END
```

Compact, which parses the same:

```
PIXM10202B1W1W1B1C002005END
```

All-white 2×2 is `PIXM1 02 02 W2 W2 C000000 END`.

### Morse

Letters, digits, and common punctuation follow ITU International Morse. `+` is sent as the AR prosign (`.-.-.`) and decodes as `<AR>`. `<SK>` is the end-of-contact prosign. `<BT>` is the same pattern as `=` and decodes as `=`. `<KN>` is the same pattern as `(`. Characters with no ITU pattern (including Devanagari) are skipped and listed; use Voice TX for spoken Hindi.

Timing is PARIS: 50 units, dit = 1.2 / character-speed seconds. Farnsworth keeps that element speed and stretches only the 19 inter-character and word-gap units so the whole word still takes 60 / text-WPM seconds. The sidetone is a sine with a linear 5 ms attack and release so the speaker does not click.

## GitHub Pages

The site is static. No build, no `node_modules`, no secrets.

1. Push the repository.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**.
3. Branch `main` (or whichever you publish), folder **`/ (root)`**, then Save.
4. Open `https://<user>.github.io/<repo>/morse-radio/`.

Project Pages prefixes the repo name. The manifest and the service worker use relative `./` URLs so they stay inside `/morse-radio/`. The first Whisper run needs network access to `cdn.jsdelivr.net` and `huggingface.co`. After that, the model sits in the browser cache. The service worker caches the app shell only, not those model files.

If the repository uses Jekyll and you later add folders whose names start with `_`, put an empty `.nojekyll` in the repo root. This folder does not need one.

## Tests

From the repository root:

```bash
node --test morse-radio/test/roundtrip.test.mjs
```

The suite checks Morse round-trips, PARIS and Farnsworth timing, the PIXM1 checksum and a messy (spaces, `O`/`0`, `I`/`1`) image round-trip, ideal element decoding, and a full sidetone path: rendered PCM, Goertzel, decoder, and back to the same picture.
