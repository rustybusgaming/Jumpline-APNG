/*
 * encode-core.js — turns source images into APNG frame payloads.
 *
 * Runs in a worker when one is available, and on the main thread otherwise, so
 * it only uses APIs that exist in both (no `document` unless OffscreenCanvas is
 * missing, which can only happen on the main thread anyway).
 */
(function (global) {
  'use strict';

  function makeCanvas(w, h) {
    if (typeof global.OffscreenCanvas === 'function') return new global.OffscreenCanvas(w, h);
    var c = global.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /* Where a source image lands inside the output canvas. */
  function fitRect(sw, sh, dw, dh, mode) {
    if (mode === 'stretch') return { x: 0, y: 0, w: dw, h: dh };
    if (mode === 'none') {
      return { x: Math.round((dw - sw) / 2), y: Math.round((dh - sh) / 2), w: sw, h: sh };
    }
    var scale = mode === 'cover'
      ? Math.max(dw / sw, dh / sh)
      : Math.min(dw / sw, dh / sh);
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    return { x: Math.round((dw - w) / 2), y: Math.round((dh - h) / 2), w: w, h: h };
  }

  /* Draw one source onto the output canvas and read back its pixels. */
  function paint(ctx, bitmap, opts) {
    ctx.clearRect(0, 0, opts.width, opts.height);
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, opts.width, opts.height);
    }
    ctx.imageSmoothingEnabled = opts.smoothing !== false;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    var r = fitRect(bitmap.width, bitmap.height, opts.width, opts.height, opts.fit);
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
  }

  async function renderToRGBA(source, opts, ctx) {
    var bitmap = (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap)
      ? source
      : await createImageBitmap(source);
    paint(ctx, bitmap, opts);
    if (bitmap !== source) bitmap.close();
    return ctx.getImageData(0, 0, opts.width, opts.height).data;
  }

  /*
   * Bounding box of everything that changed since the previous frame, plus
   * whether every changed pixel is fully opaque (which lets us use the OVER
   * blend mode and blank out the untouched pixels).
   */
  function diffRect(prev, cur, w, h) {
    var a = new Uint32Array(prev.buffer, prev.byteOffset, w * h);
    var b = new Uint32Array(cur.buffer, cur.byteOffset, w * h);
    var minX = w, minY = h, maxX = -1, maxY = -1;
    var allOpaque = true;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      var changed = false;
      for (var x = 0; x < w; x++) {
        if (a[row + x] !== b[row + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          changed = true;
          if (allOpaque && cur[(row + x) * 4 + 3] !== 255) allOpaque = false;
        }
      }
      if (changed) {
        if (y < minY) minY = y;
        maxY = y;
      }
    }
    if (maxX < 0) return null;
    return {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      allOpaque: allOpaque
    };
  }

  /* Copy a sub-rectangle out of a full-size frame. */
  function crop(rgba, rect, stride) {
    if (rect.x === 0 && rect.y === 0 && rect.w === stride) return rgba;
    var out = new Uint8ClampedArray(rect.w * rect.h * 4);
    var rowBytes = rect.w * 4;
    for (var y = 0; y < rect.h; y++) {
      var src = ((rect.y + y) * stride + rect.x) * 4;
      out.set(rgba.subarray(src, src + rowBytes), y * rowBytes);
    }
    return out;
  }

  /*
   * Same as crop(), but pixels identical to the previous frame are written as
   * fully transparent. Combined with blend mode OVER the decoder leaves those
   * pixels alone, and long transparent runs compress to almost nothing.
   */
  function cropMasked(prev, cur, rect, stride) {
    var out = new Uint8ClampedArray(rect.w * rect.h * 4);
    var o32 = new Uint32Array(out.buffer);
    var p32 = new Uint32Array(prev.buffer, prev.byteOffset, stride * (rect.y + rect.h));
    var c32 = new Uint32Array(cur.buffer, cur.byteOffset, stride * (rect.y + rect.h));
    for (var y = 0; y < rect.h; y++) {
      var src = (rect.y + y) * stride + rect.x;
      var dst = y * rect.w;
      for (var x = 0; x < rect.w; x++) {
        var v = c32[src + x];
        o32[dst + x] = v === p32[src + x] ? 0 : v;
      }
    }
    return out;
  }

  /* Fallback frame compressor for browsers without CompressionStream. */
  async function compressViaCanvas(rgba, w, h) {
    var canvas = makeCanvas(w, h);
    var ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    var blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise(function (res, rej) {
        canvas.toBlob(function (b) { b ? res(b) : rej(new Error('PNG encoding failed.')); }, 'image/png');
      });
    var info = global.PNG.readPNG(new Uint8Array(await blob.arrayBuffer()));
    if (info.bitDepth !== 8 || info.colorType !== 6 || info.interlace !== 0) {
      throw new Error('This browser cannot encode 8-bit RGBA PNGs directly. Please use a newer browser.');
    }
    return info.data;
  }

  function compress(rgba, w, h, filterMode) {
    return global.PNG.hasCompressionStream
      ? global.PNG.compressFrame(rgba, w, h, filterMode)
      : compressViaCanvas(rgba, w, h);
  }

  /*
   * Turn one rendered frame into an APNG payload, relative to the frame before
   * it. Returns null when the frame is pixel-identical to its predecessor, so
   * the caller can fold its hold time into the previous frame instead.
   */
  async function encodeFrame(prev, rgba, opts, forceKey) {
    var rect, blend = 0, payload;

    if (forceKey || !opts.optimize || !prev) {
      rect = { x: 0, y: 0, w: opts.width, h: opts.height };
      payload = rgba;
    } else {
      var d = diffRect(prev, rgba, opts.width, opts.height);
      if (!d) return null;
      rect = { x: d.x, y: d.y, w: d.w, h: d.h };
      if (d.allOpaque) {
        // Every changed pixel is opaque, so untouched pixels can be left
        // transparent and drawn with OVER: the decoder keeps what was there.
        blend = 1; // APNG_BLEND_OP_OVER
        payload = cropMasked(prev, rgba, rect, opts.width);
      } else {
        blend = 0; // APNG_BLEND_OP_SOURCE
        payload = crop(rgba, rect, opts.width);
      }
    }

    return {
      data: await compress(payload, rect.w, rect.h, opts.filter),
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      blend: blend
    };
  }

  /*
   * Encode a contiguous run of frames.
   *
   * The first frame of every segment is a full-canvas key frame, which is what
   * makes segments independent: several of them can be encoded in parallel
   * workers without any of them needing to know what came before.
   *
   * frames: [{ index, source }]  - source is a Blob/File or ImageBitmap
   * Returns [{ index, data, x, y, w, h, blend }] plus { index, skip: true }
   * entries for frames identical to their predecessor.
   */
  async function processSegment(frames, opts, onProgress) {
    var canvas = makeCanvas(opts.width, opts.height);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var results = [];
    var prev = null;

    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var rgba = await renderToRGBA(f.source, opts, ctx);
      var encoded = await encodeFrame(prev, rgba, opts, i === 0);

      if (encoded) {
        encoded.index = f.index;
        results.push(encoded);
        prev = rgba;
      } else {
        results.push({ index: f.index, skip: true });
      }
      if (onProgress) onProgress(f.index);
    }

    return results;
  }

  global.EncodeCore = {
    makeCanvas: makeCanvas,
    fitRect: fitRect,
    paint: paint,
    diffRect: diffRect,
    crop: crop,
    cropMasked: cropMasked,
    encodeFrame: encodeFrame,
    processSegment: processSegment
  };
})(typeof self !== 'undefined' ? self : this);
