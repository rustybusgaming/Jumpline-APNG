/*
 * apng-decode.js: reads an animated PNG back into its composited frames.
 *
 * Used when someone drops an APNG onto the page: rather than treating it as a
 * single still, we pull the animation apart so its frames can be re-edited.
 * Shares the chunk helpers in png.js and runs in a worker or on the main thread.
 */
(function (global) {
  'use strict';

  var SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function hasSignature(bytes) {
    if (bytes.length < 8) return false;
    for (var i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
    return true;
  }

  /* Walk the chunk list once, collecting everything the animation needs. */
  function parse(bytes) {
    if (!hasSignature(bytes)) throw new Error('That is not a PNG file.');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 8;
    var header = null;
    var frames = [];
    var stillParts = [];
    var animated = false;
    var numPlays = 0;
    var firstFrameIsDefault = true;

    while (pos + 8 <= bytes.length) {
      var len = dv.getUint32(pos);
      if (pos + 12 + len > bytes.length) break;
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var body = bytes.subarray(pos + 8, pos + 8 + len);

      if (type === 'IHDR') {
        header = {
          width: dv.getUint32(pos + 8),
          height: dv.getUint32(pos + 12),
          bitDepth: bytes[pos + 16],
          colorType: bytes[pos + 17],
          interlace: bytes[pos + 20]
        };
      } else if (type === 'acTL') {
        animated = true;
        numPlays = dv.getUint32(pos + 12);
      } else if (type === 'fcTL') {
        frames.push({
          w: dv.getUint32(pos + 12),
          h: dv.getUint32(pos + 16),
          x: dv.getUint32(pos + 20),
          y: dv.getUint32(pos + 24),
          delayNum: dv.getUint16(pos + 28),
          delayDen: dv.getUint16(pos + 30),
          dispose: bytes[pos + 32],
          blend: bytes[pos + 33],
          parts: []
        });
        // An fcTL before any IDAT means the still image is also frame 1.
        if (!stillParts.length && frames.length === 1) firstFrameIsDefault = true;
      } else if (type === 'IDAT') {
        stillParts.push(body);
        if (frames.length === 1 && firstFrameIsDefault) frames[0].parts.push(body);
        else if (!frames.length) firstFrameIsDefault = false;
      } else if (type === 'fdAT') {
        if (frames.length) frames[frames.length - 1].parts.push(body.subarray(4));
      } else if (type === 'IEND') {
        break;
      }
      pos += len + 12;
    }

    if (!header) throw new Error('This PNG has no header chunk.');
    return { header: header, frames: frames, animated: animated, numPlays: numPlays, still: stillParts };
  }

  function isAnimated(bytes) {
    try {
      return parse(bytes).animated;
    } catch (e) {
      return false;
    }
  }

  async function inflate(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var joined = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) { joined.set(parts[j], off); off += parts[j].length; }

    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('This browser cannot unpack PNG data. Please use a newer browser.');
    }
    var ds = new global.DecompressionStream('deflate');
    var writer = ds.writable.getWriter();
    var writeDone = (async function () { await writer.write(joined); await writer.close(); })();
    var reader = ds.readable.getReader();
    var chunks = [];
    var size = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      size += r.value.length;
    }
    await writeDone;
    var out = new Uint8Array(size);
    var o = 0;
    for (var k = 0; k < chunks.length; k++) { out.set(chunks[k], o); o += chunks[k].length; }
    return out;
  }

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = p > a ? p - a : a - p;
    var pb = p > b ? p - b : b - p;
    var pc = p > c ? p - c : c - p;
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  }

  /* Reverse the per-scanline PNG filters. Channels is 4 for RGBA, 3 for RGB. */
  function unfilter(raw, width, height, channels) {
    var bpp = channels;
    var stride = width * bpp;
    var out = new Uint8Array(height * stride);
    var pos = 0;
    for (var y = 0; y < height; y++) {
      var ft = raw[pos++];
      var row = y * stride;
      for (var i = 0; i < stride; i++) {
        var x = raw[pos + i];
        var a = i >= bpp ? out[row + i - bpp] : 0;
        var b = y > 0 ? out[row - stride + i] : 0;
        var c = (i >= bpp && y > 0) ? out[row - stride + i - bpp] : 0;
        var v;
        if (ft === 0) v = x;
        else if (ft === 1) v = x + a;
        else if (ft === 2) v = x + b;
        else if (ft === 3) v = x + ((a + b) >> 1);
        else if (ft === 4) v = x + paeth(a, b, c);
        else throw new Error('This PNG uses a filter type we do not understand.');
        out[row + i] = v & 0xff;
      }
      pos += stride;
    }
    return out;
  }

  function toRGBA(px, width, height, colorType) {
    if (colorType === 6) return px;
    var out = new Uint8ClampedArray(width * height * 4);
    if (colorType === 2) {                      // RGB, no alpha
      for (var i = 0, n = width * height; i < n; i++) {
        out[i * 4] = px[i * 3];
        out[i * 4 + 1] = px[i * 3 + 1];
        out[i * 4 + 2] = px[i * 3 + 2];
        out[i * 4 + 3] = 255;
      }
      return out;
    }
    throw new Error('Only 8-bit RGB and RGBA animations can be opened.');
  }

  /*
   * Decode into fully composited frames.
   * Returns [{ rgba, width, height, delay }] in playback order.
   */
  async function decode(bytes) {
    var info = parse(bytes);
    var h = info.header;
    if (h.bitDepth !== 8 || (h.colorType !== 6 && h.colorType !== 2) || h.interlace !== 0) {
      throw new Error('Only 8-bit, non-interlaced PNGs can be opened.');
    }
    if (!info.animated || !info.frames.length) {
      throw new Error('That PNG is not animated.');
    }

    var channels = h.colorType === 6 ? 4 : 3;
    var W = h.width, H = h.height;
    var canvas = new Uint8ClampedArray(W * H * 4);
    var out = [];

    for (var i = 0; i < info.frames.length; i++) {
      var f = info.frames[i];
      if (!f.parts.length) continue;
      if (f.x + f.w > W || f.y + f.h > H) throw new Error('This animation has a frame outside its canvas.');

      var before = f.dispose === 2 ? canvas.slice() : null;
      var px = toRGBA(unfilter(await inflate(f.parts), f.w, f.h, channels), f.w, f.h, h.colorType);

      for (var y = 0; y < f.h; y++) {
        for (var x = 0; x < f.w; x++) {
          var s = (y * f.w + x) * 4;
          var d = ((f.y + y) * W + (f.x + x)) * 4;
          var sa = px[s + 3];
          if (f.blend === 0 || sa === 255) {
            canvas[d] = px[s]; canvas[d + 1] = px[s + 1]; canvas[d + 2] = px[s + 2]; canvas[d + 3] = sa;
          } else if (sa !== 0) {
            var da = canvas[d + 3];
            var outA = sa + da * (255 - sa) / 255;
            for (var ch = 0; ch < 3; ch++) {
              canvas[d + ch] = Math.round((px[s + ch] * sa + canvas[d + ch] * da * (255 - sa) / 255) / outA);
            }
            canvas[d + 3] = Math.round(outA);
          }
        }
      }

      out.push({
        rgba: canvas.slice(),
        width: W,
        height: H,
        delay: f.delayDen ? Math.round(f.delayNum / f.delayDen * 1000) : f.delayNum * 10
      });

      if (f.dispose === 1) {
        for (var dy = 0; dy < f.h; dy++) {
          canvas.fill(0, ((f.y + dy) * W + f.x) * 4, ((f.y + dy) * W + f.x + f.w) * 4);
        }
      } else if (f.dispose === 2 && before) {
        canvas.set(before);
      }
    }

    if (!out.length) throw new Error('That animation has no readable frames.');
    return out;
  }

  global.APNGDecode = {
    isAnimated: isAnimated,
    hasSignature: hasSignature,
    parse: parse,
    decode: decode
  };
})(typeof self !== 'undefined' ? self : this);
