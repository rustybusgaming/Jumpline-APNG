/*
 * Round-trip test: encode synthetic frames with the real production code, then
 * decode the result with an independent APNG reader and compare pixels.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const g = globalThis;
new Function(fs.readFileSync(path.join(ROOT, 'src/png.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'src/encode-core.js'), 'utf8'))();
const { PNG, EncodeCore } = g;

/* ------------------------------------------------------------ independent decoder */

function unfilter(raw, width, height) {
  const bpp = 4, stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i];
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y > 0 ? out[row - stride + i] : 0;
      const c = (i >= bpp && y > 0) ? out[row - stride + i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      } else throw new Error('bad filter type ' + ft);
      out[row + i] = v & 0xff;
    }
    pos += stride;
  }
  if (pos !== raw.length) throw new Error('scanline data length mismatch');
  return out;
}

function decodeAPNG(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let pos = 8, header = null, actl = null;
  const order = [];
  const frames = [];
  let expectedSeq = 0;
  let sawIHDRFirst = false;
  let actlBeforeIDAT = true;
  let sawIDAT = false;

  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    const crc = dv.getUint32(pos + 8 + len);
    const calc = PNG.crc32(bytes, pos + 4, pos + 8 + len);
    if (crc !== calc) throw new Error(`CRC mismatch on ${type}`);
    order.push(type);

    if (type === 'IHDR') {
      if (order.length !== 1) throw new Error('IHDR is not the first chunk');
      sawIHDRFirst = true;
      header = {
        width: dv.getUint32(pos + 8), height: dv.getUint32(pos + 12),
        bitDepth: bytes[pos + 16], colorType: bytes[pos + 17],
        compression: bytes[pos + 18], filter: bytes[pos + 19], interlace: bytes[pos + 20],
      };
    } else if (type === 'acTL') {
      if (sawIDAT) actlBeforeIDAT = false;
      actl = { numFrames: dv.getUint32(pos + 8), numPlays: dv.getUint32(pos + 12) };
    } else if (type === 'fcTL') {
      const seq = dv.getUint32(pos + 8);
      if (seq !== expectedSeq) throw new Error(`fcTL sequence ${seq}, expected ${expectedSeq}`);
      expectedSeq++;
      frames.push({
        w: dv.getUint32(pos + 12), h: dv.getUint32(pos + 16),
        x: dv.getUint32(pos + 20), y: dv.getUint32(pos + 24),
        delayNum: dv.getUint16(pos + 28), delayDen: dv.getUint16(pos + 30),
        dispose: bytes[pos + 32], blend: bytes[pos + 33],
        parts: [],
      });
    } else if (type === 'IDAT') {
      sawIDAT = true;
      if (frames.length !== 1) throw new Error('IDAT must follow the first fcTL');
      frames[0].parts.push(Buffer.from(data));
    } else if (type === 'fdAT') {
      const seq = dv.getUint32(pos + 8);
      if (seq !== expectedSeq) throw new Error(`fdAT sequence ${seq}, expected ${expectedSeq}`);
      expectedSeq++;
      frames[frames.length - 1].parts.push(Buffer.from(data.subarray(4)));
    } else if (type === 'IEND') {
      if (len !== 0) throw new Error('IEND must be empty');
      pos += len + 12;
      if (pos !== bytes.length) throw new Error('trailing bytes after IEND');
      break;
    }
    pos += len + 12;
  }

  if (!sawIHDRFirst) throw new Error('missing IHDR');
  if (!actl) throw new Error('missing acTL');
  if (!actlBeforeIDAT) throw new Error('acTL must appear before IDAT');
  if (order[order.length - 1] !== 'IEND') throw new Error('missing IEND');
  if (actl.numFrames !== frames.length) throw new Error(`acTL says ${actl.numFrames} frames, found ${frames.length}`);
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error('header is not 8-bit RGBA, non-interlaced');
  }

  /* Composite the animation exactly as the APNG spec describes. */
  const W = header.width, H = header.height;
  const canvas = new Uint8Array(W * H * 4);
  const rendered = [];

  for (const f of frames) {
    if (f.x + f.w > W || f.y + f.h > H) throw new Error('frame rectangle escapes the canvas');
    const before = canvas.slice();
    const raw = zlib.inflateSync(Buffer.concat(f.parts));
    const px = unfilter(raw, f.w, f.h);

    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const s = (y * f.w + x) * 4;
        const d = ((f.y + y) * W + (f.x + x)) * 4;
        const sa = px[s + 3];
        if (f.blend === 0 || sa === 255) {
          canvas[d] = px[s]; canvas[d + 1] = px[s + 1]; canvas[d + 2] = px[s + 2]; canvas[d + 3] = sa;
        } else if (sa !== 0) {
          const da = canvas[d + 3];
          const outA = sa + da * (255 - sa) / 255;
          for (let k = 0; k < 3; k++) {
            canvas[d + k] = Math.round((px[s + k] * sa + canvas[d + k] * da * (255 - sa) / 255) / outA);
          }
          canvas[d + 3] = Math.round(outA);
        }
      }
    }
    rendered.push({ pixels: canvas.slice(), delay: f.delayNum / f.delayDen * 1000, blend: f.blend, rect: [f.x, f.y, f.w, f.h] });

    if (f.dispose === 1) {          // background: clear the frame's rectangle
      for (let y = 0; y < f.h; y++) canvas.fill(0, ((f.y + y) * W + f.x) * 4, ((f.y + y) * W + f.x + f.w) * 4);
    } else if (f.dispose === 2) {   // previous: restore
      canvas.set(before);
    }
  }

  return { header, actl, frames: rendered };
}

/* --------------------------------------------------------------- test fixtures */

function makeFrames(kind, count, W, H) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const px = new Uint8ClampedArray(W * H * 4);
    if (kind === 'opaque-move' || kind === 'dupes') {
      for (let p = 0; p < W * H; p++) {            // opaque navy background
        px[p * 4] = 20; px[p * 4 + 1] = 24; px[p * 4 + 2] = 48; px[p * 4 + 3] = 255;
      }
      const step = kind === 'dupes' ? Math.floor(i / 2) : i;   // dupes: pairs of identical frames
      const cx = 4 + step * 3;
      for (let y = 6; y < 18; y++) {
        for (let x = cx; x < cx + 12 && x < W; x++) {
          const d = (y * W + x) * 4;
          px[d] = 255; px[d + 1] = 90 + step * 10; px[d + 2] = 40; px[d + 3] = 255;
        }
      }
    } else if (kind === 'alpha-fade') {
      // Semi-transparent disc that fades: forces the SOURCE blend path.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const d = (y * W + x) * 4;
          const dist = Math.hypot(x - W / 2, y - H / 2);
          const a = dist < 14 ? Math.max(0, 200 - i * 25) : 0;
          px[d] = 240; px[d + 1] = 60; px[d + 2] = 160; px[d + 3] = a;
        }
      }
    } else if (kind === 'noise') {
      let seed = i * 7919 + 13;
      for (let p = 0; p < W * H * 4; p++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        px[p] = (seed >> 16) & 0xff;
      }
    } else if (kind === 'static') {
      for (let p = 0; p < W * H; p++) {
        px[p * 4] = 200; px[p * 4 + 1] = 30; px[p * 4 + 2] = 90; px[p * 4 + 3] = 255;
      }
    }
    out.push(px);
  }
  return out;
}

/* Mirrors the segmenting the app does, so key frames land where they would in production. */
function planSegments(total, threads, optimize) {
  const segLen = Math.max(optimize ? 8 : 1, Math.ceil(total / threads));
  const segments = [];
  for (let start = 0; start < total; start += segLen) {
    segments.push({ start, end: Math.min(total, start + segLen) });
  }
  return segments;
}

async function encodeAll(sources, opts, threads) {
  if (!(threads >= 1)) throw new Error('encodeAll needs a thread count');
  const segments = planSegments(sources.length, threads, opts.optimize);
  const results = [];
  for (const seg of segments) {
    let prev = null;
    for (let i = seg.start; i < seg.end; i++) {
      const encoded = await EncodeCore.encodeFrame(prev, sources[i], opts, i === seg.start);
      if (encoded) { encoded.index = i; results.push(encoded); prev = sources[i]; }
      else results.push({ index: i, skip: true });
    }
  }
  results.sort((a, b) => a.index - b.index);

  const apngFrames = [];
  for (const r of results) {
    const delay = 100;
    if (r.skip && apngFrames.length) {
      apngFrames[apngFrames.length - 1].delayNum += delay;
      continue;
    }
    apngFrames.push({ data: r.data, x: r.x, y: r.y, w: r.w, h: r.h, delayNum: delay, delayDen: 1000, blend: r.blend, dispose: 0 });
  }
  const parts = PNG.buildAPNG({ width: opts.width, height: opts.height, numPlays: opts.numPlays ?? 0, frames: apngFrames });
  let total = 0; for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total);
  let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
  return { bytes, kept: apngFrames.length, skipped: results.filter(r => r.skip).length };
}

/* ----------------------------------------------------------------------- runner */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32mok\x1b[0m   ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
}

function comparePixels(got, want, label) {
  if (got.length !== want.length) return `${label}: length ${got.length} vs ${want.length}`;
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      const p = Math.floor(i / 4);
      return `${label}: pixel ${p} channel ${i % 4}: got ${got[i]}, want ${want[i]}`;
    }
  }
  return null;
}

async function run() {
  const W = 40, H = 24;

  for (const kind of ['opaque-move', 'alpha-fade', 'noise', 'dupes', 'static']) {
    for (const filter of [0, 1, 2]) {
      for (const optimize of [true, false]) {
        for (const threads of [1, 4]) {
          const count = kind === 'dupes' ? 10 : 6;
          const sources = makeFrames(kind, count, W, H);
          const opts = { width: W, height: H, optimize, filter, numPlays: 0 };
          const { bytes, kept, skipped } = await encodeAll(sources, opts, threads);
          const label = `${kind} filter=${filter} optimize=${optimize} threads=${threads}`;

          let decoded, err = null;
          try { decoded = decodeAPNG(bytes); } catch (e) { err = e.message; }
          if (err) { check(label, false, err); continue; }

          // Rebuild the expected sequence, folding dropped duplicates away.
          const expected = [];
          let prevSource = null;
          const segments = planSegments(count, threads, optimize);
          const keyIndexes = new Set(segments.map(s => s.start));
          for (let i = 0; i < count; i++) {
            const isDup = optimize && !keyIndexes.has(i) && prevSource &&
              Buffer.compare(Buffer.from(sources[i].buffer), Buffer.from(prevSource.buffer)) === 0;
            if (!isDup) expected.push(sources[i]);
            prevSource = sources[i];
          }

          let problem = null;
          if (decoded.frames.length !== expected.length) {
            problem = `frame count ${decoded.frames.length} vs expected ${expected.length}`;
          } else {
            for (let i = 0; i < expected.length && !problem; i++) {
              problem = comparePixels(decoded.frames[i].pixels, expected[i], `frame ${i}`);
            }
          }
          const totalDelay = decoded.frames.reduce((s, f) => s + f.delay, 0);
          if (!problem && Math.round(totalDelay) !== count * 100) {
            problem = `total duration ${totalDelay}ms, expected ${count * 100}ms`;
          }
          check(`${label} (${kept} frames, ${skipped} deduped, ${bytes.length}B)`, !problem, problem);
        }
      }
    }
  }

  // Single frame, and loop-count handling.
  {
    const sources = makeFrames('static', 1, W, H);
    const { bytes } = await encodeAll(sources, { width: W, height: H, optimize: true, filter: 1, numPlays: 3 }, 1);
    const d = decodeAPNG(bytes);
    check('single frame encodes', d.frames.length === 1 && !comparePixels(d.frames[0].pixels, sources[0], 'f0'));
    check('numPlays is written through', d.actl.numPlays === 3, 'got ' + d.actl.numPlays);
  }

  // Optimisation really does shrink things, and picks the OVER path for opaque motion.
  {
    const sources = makeFrames('opaque-move', 12, 120, 80);
    const base = { width: 120, height: 80, filter: 1 };
    const on = await encodeAll(sources, { ...base, optimize: true }, 1);
    const off = await encodeAll(sources, { ...base, optimize: false }, 1);
    check(`optimise shrinks output (${off.bytes.length}B -> ${on.bytes.length}B)`, on.bytes.length < off.bytes.length * 0.5);
    const d = decodeAPNG(on.bytes);
    check('opaque motion uses OVER + cropped rects',
      d.frames.slice(1).every(f => f.blend === 1 && f.rect[2] < 120), JSON.stringify(d.frames[1].rect));
    const dOff = decodeAPNG(off.bytes);
    check('unoptimised frames are full-canvas SOURCE',
      dOff.frames.every(f => f.blend === 0 && f.rect[2] === 120 && f.rect[3] === 80));
  }

  // Alpha changes must fall back to SOURCE, never OVER.
  {
    const sources = makeFrames('alpha-fade', 6, 40, 24);
    const { bytes } = await encodeAll(sources, { width: 40, height: 24, optimize: true, filter: 2 }, 1);
    const d = decodeAPNG(bytes);
    check('fading alpha uses the SOURCE blend', d.frames.every(f => f.blend === 0));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
