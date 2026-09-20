/*
 * png.js: minimal PNG / APNG writing primitives.
 *
 * Loaded both in the main thread (<script>) and inside the encode worker
 * (importScripts), so it must not touch `document` or `window`.
 */
(function (global) {
  'use strict';

  var crcTable = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }

  function crc32(buf, start, end) {
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  var SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  /* Build one PNG chunk: length + type + data + crc. */
  function chunk(type, data) {
    var len = data.length;
    var out = new Uint8Array(len + 12);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    dv.setUint32(len + 8, crc32(out, 4, len + 8));
    return out;
  }

  /* ---------------------------------------------------------------- filters */

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = p > a ? p - a : a - p;
    var pb = p > b ? p - b : b - p;
    var pc = p > c ? p - c : c - p;
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  function score(line, len) {
    var s = 0;
    for (var i = 0; i < len; i++) {
      var v = line[i];
      s += v < 128 ? v : 256 - v;
    }
    return s;
  }

  /*
   * Apply PNG scanline filters to RGBA pixel data.
   *   mode 0 -> no filtering (fastest)
   *   mode 1 -> adaptive over None/Sub/Up (good balance)
   *   mode 2 -> adaptive over all five filters (smallest)
   */
  function filterRaw(rgba, width, height, mode) {
    var bpp = 4;
    var stride = width * bpp;
    var out = new Uint8Array(height * (stride + 1));
    var prev = new Uint8Array(stride);
    var cand = [];
    var count = mode === 0 ? 1 : (mode === 1 ? 3 : 5);
    for (var f = 0; f < count; f++) cand.push(new Uint8Array(stride));

    for (var y = 0; y < height; y++) {
      var row = y * stride;
      var best = 0;
      var bestScore = Infinity;

      for (var t = 0; t < count; t++) {
        var line = cand[t];
        var i, raw, left, up, upLeft;
        if (t === 0) {
          line.set(rgba.subarray(row, row + stride));
        } else if (t === 1) {           // Sub
          for (i = 0; i < stride; i++) {
            left = i >= bpp ? rgba[row + i - bpp] : 0;
            line[i] = (rgba[row + i] - left) & 0xff;
          }
        } else if (t === 2) {           // Up
          for (i = 0; i < stride; i++) line[i] = (rgba[row + i] - prev[i]) & 0xff;
        } else if (t === 3) {           // Average
          for (i = 0; i < stride; i++) {
            left = i >= bpp ? rgba[row + i - bpp] : 0;
            line[i] = (rgba[row + i] - ((left + prev[i]) >> 1)) & 0xff;
          }
        } else {                        // Paeth
          for (i = 0; i < stride; i++) {
            left = i >= bpp ? rgba[row + i - bpp] : 0;
            up = prev[i];
            upLeft = i >= bpp ? prev[i - bpp] : 0;
            line[i] = (rgba[row + i] - paeth(left, up, upLeft)) & 0xff;
          }
        }
        if (count === 1) { best = 0; break; }
        var s = score(line, stride);
        if (s < bestScore) { bestScore = s; best = t; }
      }

      var o = y * (stride + 1);
      out[o] = best;
      out.set(cand[best], o + 1);
      prev.set(rgba.subarray(row, row + stride));
    }
    return out;
  }

  /* ---------------------------------------------------------------- deflate */

  var hasCompressionStream = typeof global.CompressionStream === 'function';

  async function deflateZlib(bytes) {
    var cs = new global.CompressionStream('deflate');
    var writer = cs.writable.getWriter();
    var writeDone = (async function () {
      await writer.write(bytes);
      await writer.close();
    })();
    var reader = cs.readable.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.length;
    }
    await writeDone;
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  /*
   * Compress one frame's RGBA buffer into a raw zlib stream ready to drop into
   * an IDAT / fdAT chunk.
   */
  async function compressFrame(rgba, width, height, mode) {
    return deflateZlib(filterRaw(rgba, width, height, mode));
  }

  /* ------------------------------------------------- PNG reading (fallback) */

  /* Pull IHDR info + the concatenated IDAT stream out of an encoded PNG. */
  function readPNG(bytes) {
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG file.');
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 8;
    var info = null;
    var idat = [];
    var total = 0;
    while (pos + 8 <= bytes.length) {
      var len = dv.getUint32(pos);
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        info = {
          width: dv.getUint32(pos + 8),
          height: dv.getUint32(pos + 12),
          bitDepth: bytes[pos + 16],
          colorType: bytes[pos + 17],
          interlace: bytes[pos + 20]
        };
      } else if (type === 'IDAT') {
        idat.push(data);
        total += len;
      } else if (type === 'IEND') {
        break;
      }
      pos += len + 12;
    }
    if (!info) throw new Error('PNG is missing its header.');
    var merged = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < idat.length; j++) { merged.set(idat[j], off); off += idat[j].length; }
    info.data = merged;
    return info;
  }

  /* ---------------------------------------------------------- APNG assembly */

  /*
   * frames: [{ data (zlib bytes), x, y, w, h, delayNum, delayDen, blend, dispose }]
   * Returns an array of Uint8Arrays suitable for `new Blob(parts)`.
   */
  function buildAPNG(spec) {
    var parts = [SIGNATURE];

    var ihdr = new Uint8Array(13);
    var hv = new DataView(ihdr.buffer);
    hv.setUint32(0, spec.width);
    hv.setUint32(4, spec.height);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace
    parts.push(chunk('IHDR', ihdr));

    var actl = new Uint8Array(8);
    var av = new DataView(actl.buffer);
    av.setUint32(0, spec.frames.length);
    av.setUint32(4, spec.numPlays >>> 0);
    parts.push(chunk('acTL', actl));

    var seq = 0;
    for (var i = 0; i < spec.frames.length; i++) {
      var f = spec.frames[i];
      var fctl = new Uint8Array(26);
      var fv = new DataView(fctl.buffer);
      fv.setUint32(0, seq++);
      fv.setUint32(4, f.w);
      fv.setUint32(8, f.h);
      fv.setUint32(12, f.x);
      fv.setUint32(16, f.y);
      fv.setUint16(20, f.delayNum);
      fv.setUint16(22, f.delayDen);
      fctl[24] = f.dispose || 0;
      fctl[25] = f.blend || 0;
      parts.push(chunk('fcTL', fctl));

      if (i === 0) {
        parts.push(chunk('IDAT', f.data));
      } else {
        var fdat = new Uint8Array(4 + f.data.length);
        new DataView(fdat.buffer).setUint32(0, seq++);
        fdat.set(f.data, 4);
        parts.push(chunk('fdAT', fdat));
      }
    }

    parts.push(chunk('IEND', new Uint8Array(0)));
    return parts;
  }

  global.PNG = {
    crc32: crc32,
    chunk: chunk,
    filterRaw: filterRaw,
    deflateZlib: deflateZlib,
    compressFrame: compressFrame,
    readPNG: readPNG,
    buildAPNG: buildAPNG,
    hasCompressionStream: hasCompressionStream
  };
})(typeof self !== 'undefined' ? self : this);
