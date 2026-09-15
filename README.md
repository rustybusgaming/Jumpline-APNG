# Jumpline APNG

A single-page web app that turns a pile of image frames into an **animated PNG**.
No upload, no server, no build step, no dependencies — it is plain HTML, CSS and
JavaScript, so you can drop it on GitHub Pages and it just works.

![frames in, animated PNG out](https://img.shields.io/badge/runs-100%25%20in%20your%20browser-7c5cff)

## Features

- **Drag, drop, done.** Add PNG / JPEG / WebP / GIF / BMP frames by dropping them,
  browsing for them, or pasting from the clipboard. Files are sorted naturally, so
  `frame-2.png` lands before `frame-10.png`.
- **Adjustable frame length.** Set one hold time for everything (in milliseconds or
  fps — the two stay in sync), or give any individual frame its own timing right on
  its thumbnail. Handy for holding a pose at the end of a loop.
- **Adjustable output size.** Type a width and height, or use the preset buttons
  (Original / 50% / 25% / 512 / 256 / 128). Aspect ratio can be locked, and you pick
  how frames are fitted: contain, cover, stretch or centre.
- **Transparency or a solid background**, plus a pixel-art mode that turns off
  smoothing so small sprites scale up crisply.
- **Frame editing** — reorder by dragging, nudge left/right, duplicate, delete,
  reverse, sort by name, or ping-pong the sequence into a seamless loop.
- **Live preview** of the exact canvas that will be encoded, with play/pause and a
  scrubber.
- **Loop control** — play forever, or a set number of times.

## Why it's fast

- **Parallel encoding.** Frames are split into contiguous segments and handed to a
  pool of Web Workers (one per core, up to 8). Each segment starts with a full key
  frame, which is what makes segments independent enough to encode simultaneously.
- **Native compression.** Deflate runs through the browser's built-in
  `CompressionStream`, so the slow part happens in optimised native code rather
  than in JavaScript.
- **Only the differences get stored.** Each frame is compared to the one before it
  and cropped to the rectangle that actually changed. When every changed pixel is
  opaque, the untouched pixels inside that rectangle are left transparent and the
  frame is composited with APNG's `OVER` blend mode — long transparent runs cost
  almost nothing to compress. Frames identical to their predecessor are dropped
  entirely and their time is folded into the previous frame.
- **Three compression presets** — Fast (no scanline filtering), Balanced, and
  Smallest (adaptive filtering across all five PNG filter types).

In practice a 12-frame 240×160 animation of a moving sprite comes out around
**3× smaller** with optimisation on, and a 10-frame export finishes in well under
a tenth of a second.

## Publishing it to GitHub Pages

The repository root *is* the site, so there is nothing to build.

**Option A — deploy from a branch (simplest)**

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under *Build and deployment*, set **Source** to `Deploy from a branch`, pick your
   default branch and the `/ (root)` folder, and save.
4. Your site appears at `https://<your-username>.github.io/<repository-name>/`.

**Option B — the included Actions workflow**

`.github/workflows/pages.yml` runs the test suite and then publishes the site. To
use it, set **Settings → Pages → Source** to `GitHub Actions`. It triggers on pushes
to `main` or `master`, and can also be run by hand from the Actions tab.

Either way you can also just open `index.html` from disk. Workers are blocked on
`file://`, so it falls back to encoding on a single thread — everything still works,
it is only slower.

## Development

```bash
npm test      # round-trip tests: encode, then decode and compare pixels
npm run serve # serve the site at http://localhost:8080
```

`npm test` has no dependencies — it needs only Node 18+. It encodes synthetic
animations with the production code, then decodes them with a **separate**
APNG reader that verifies chunk ordering, CRCs and `fcTL`/`fdAT` sequence numbers,
composites the frames according to the APNG spec, and checks the result pixel for
pixel. It covers opaque motion, fading alpha, noise, duplicate frames and static
images, across every compression preset, with optimisation on and off, and with
single- and multi-segment layouts.

## How it's put together

| File | Role |
| --- | --- |
| `index.html` | Markup for the whole app |
| `assets/styles.css` | Styling |
| `src/png.js` | CRC32, chunk writing, PNG scanline filters, deflate, APNG assembly |
| `src/encode-core.js` | Frame rendering, inter-frame diffing, per-frame encoding |
| `src/worker.js` | Thin worker wrapper around `encode-core` |
| `src/app.js` | UI, preview playback, export orchestration |
| `test/apng.test.js` | Independent decoder + round-trip tests |

`src/png.js` and `src/encode-core.js` are written to run unchanged in a worker, on
the main thread, and in Node, which is what lets the test suite exercise the real
encoding code rather than a copy of it.

## Browser support

APNG plays natively in Chrome, Edge, Firefox and Safari — an exported file is a
normal `.png`, so it works anywhere an image does, including as an `<img>`, a
Discord emoji or a sticker. Building files needs a browser with `CompressionStream`
(Chrome 80+, Firefox 113+, Safari 16.4+); older browsers fall back to a slower path
automatically.

## Licence

MIT
