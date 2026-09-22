# Zoetrope

Zoetrope is a single-page web app that turns a pile of image frames into an
**animated PNG**.
No upload, no server, no build step, no dependencies: it is plain HTML, CSS and
JavaScript, so you can drop it on GitHub Pages and it just works.

![runs entirely in your browser](https://img.shields.io/badge/runs-100%25%20in%20your%20browser-2F6B52)

## Features

### Getting frames in
- **Drag, drop, done.** Add PNG / JPEG / WebP / GIF / BMP frames by dropping
  them, browsing for them, or pasting from the clipboard. Files are sorted
  naturally, so `frame-2.png` lands before `frame-10.png`.
- **Drop an animated PNG back in** and it is unpacked into its frames, with the
  original per-frame timing preserved, so an export can be reopened and edited.

### Timing and size
- **Adjustable frame length.** Set one hold time for everything (in
  milliseconds or fps, the two stay in sync), or give any individual frame its
  own timing right on its thumbnail.
- **Adjustable output size.** Type a width and height, or use the presets
  (Original / 50% / 25% / 512 / 256 / 128). Aspect ratio can be locked, and you
  pick how frames are fitted: contain, cover, stretch or centre.
- **Transparency or a solid background**, plus a pixel-art mode that turns off
  smoothing so small sprites scale up crisply.
- **Loop control:** play forever, or a set number of times.

### Editing
- Reorder by dragging, nudge left and right, duplicate, delete, reverse, sort by
  name, or ping-pong the sequence into a seamless loop.
- **Live preview** of the exact canvas that will be encoded, with play/pause and
  a scrubber.
- **Onion skin** ghosts the previous frame behind the current one, so you can
  line up movement between frames.
- **Save frames as a zip** writes every frame out as a numbered PNG at the
  chosen output size.

### Accessibility
- Every control is reachable and operable from the keyboard, with a visible
  focus ring throughout.
- Focus a frame card and the **arrow keys move it**; Delete removes it.
- Frame cards, icon buttons and fields carry real labels, and actions
  (added, moved, removed, retimed, built) are announced to screen readers
  through a live region.
- A skip link jumps straight to the app, and `prefers-reduced-motion` starts the
  preview paused instead of looping at you.

## Why it's fast, and why the files are small

- **Parallel encoding.** Frames are split into contiguous segments and handed to
  a pool of Web Workers (one per core, up to 8). Each segment starts with a full
  key frame, which is what makes segments independent enough to encode at once.
- **Native compression.** Deflate runs through the browser's built-in
  `CompressionStream`, so the slow part happens in optimised native code rather
  than in JavaScript.
- **Only the differences get stored.** Each frame is compared to the one before
  it and cropped to the rectangle that actually changed. When every changed
  pixel is opaque, the untouched pixels inside that rectangle are left
  transparent and the frame is composited with APNG's `OVER` blend mode, because
  long transparent runs cost almost nothing to compress. Frames identical to
  their predecessor are dropped entirely and their time is folded into the
  previous frame.
- **Boundary key frames get shrunk back down.** Parallel encoding needs a key
  frame at the start of every segment, which is pure overhead. Once the workers
  are finished, those few boundary frames are re-encoded as deltas and the
  smaller version wins, so using 8 threads no longer costs you file size.
- **Three compression presets:** Fast (no scanline filtering), Balanced, and
  Smallest, which encodes each frame three ways and keeps whichever deflates
  shortest.

Measured on a 24-frame 320x240 animation of a moving sprite:

| | flat art | gradient art |
| --- | --- | --- |
| 8 threads, boundary key frames kept | 6700 B | 23175 B |
| 8 threads, boundaries shrunk | **5276 B** (21% smaller) | 23175 B (no change) |
| single thread, for reference | 5276 B | 23175 B |
| Balanced filter | 5276 B | 23175 B |
| Smallest filter | **4668 B** (11% smaller) | **22704 B** (2% smaller) |

Shrinking the boundaries brings the 8-thread result down to exactly the
single-threaded best case. On art where every pixel changes each frame there is
nothing to save, and the encoder correctly keeps the key frame.

## Publishing it to GitHub Pages

The repository root *is* the site, so there is nothing to build.

**Option A, deploy from a branch (simplest)**

1. Push this repository to GitHub.
2. Go to **Settings, then Pages**.
3. Under *Build and deployment*, set **Source** to `Deploy from a branch`, pick
   your default branch and the `/ (root)` folder, and save.
4. Your site appears at `https://<your-username>.github.io/<repository-name>/`.

**Option B, the included Actions workflow**

`.github/workflows/pages.yml` runs the test suite and then publishes the site.
To use it, set **Settings, then Pages, then Source** to `GitHub Actions`. It
triggers on pushes to `main` or `master`, and can also be run by hand from the
Actions tab.

Either way you can also just open `index.html` from disk. Workers are blocked on
`file://`, so it falls back to encoding on a single thread. Everything still
works, it is only slower.

## Development

```bash
npm test      # round-trip tests: encode, then decode and compare pixels
npm run serve # serve the site at http://localhost:8080
```

`npm test` has no dependencies, it needs only Node 18+. It encodes synthetic
animations with the production code, then decodes them with a **separate** APNG
reader that verifies chunk ordering, CRCs and `fcTL`/`fdAT` sequence numbers,
composites the frames according to the APNG spec, and checks the result pixel
for pixel. It covers opaque motion, fading alpha, noise, duplicate frames and
static images, across every compression preset, with optimisation on and off,
and with single- and multi-segment layouts. It also round-trips the in-page APNG
reader against that independent decoder, and checks the zip writer's container.

## How it's put together

| File | Role |
| --- | --- |
| `index.html` | Markup for the whole app |
| `assets/styles.css` | The theme |
| `src/png.js` | CRC32, chunk writing, PNG scanline filters, deflate, APNG assembly |
| `src/encode-core.js` | Frame rendering, inter-frame diffing, per-frame encoding |
| `src/apng-decode.js` | Reads an animated PNG back into composited frames |
| `src/zip.js` | Minimal store-only zip writer, for frame export |
| `src/worker.js` | Thin worker wrapper around `encode-core` |
| `src/app.js` | UI, preview playback, export orchestration |
| `test/apng.test.js` | Independent decoder and round-trip tests |

`src/png.js`, `src/encode-core.js` and `src/apng-decode.js` are written to run
unchanged in a worker, on the main thread, and in Node, which is what lets the
test suite exercise the real encoding code rather than a copy of it.

## Browser support

APNG plays natively in Chrome, Edge, Firefox and Safari. An exported file is a
normal `.png`, so it works anywhere an image does, including as an `<img>`, a
Discord emoji or a sticker. Building files needs a browser with
`CompressionStream` (Chrome 80+, Firefox 113+, Safari 16.4+); older browsers
fall back to a slower path automatically. Reopening an animated PNG needs
`DecompressionStream`, available in the same versions.

Type is [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4) for
headings and [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans)
for the interface, both from Google Fonts, with system fallbacks if those
cannot be reached.

## Licence

MIT
