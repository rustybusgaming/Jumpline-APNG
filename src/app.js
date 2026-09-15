/* app.js — UI, preview playback and export orchestration. */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var el = {
    dropzone: $('#dropzone'),
    fileInput: $('#fileInput'),
    strip: $('#strip'),
    frameCount: $('#frameCount'),
    btnSortName: $('#btnSortName'),
    btnReverse: $('#btnReverse'),
    btnPingPong: $('#btnPingPong'),
    btnClear: $('#btnClear'),
    preview: $('#preview'),
    btnPlay: $('#btnPlay'),
    scrub: $('#scrub'),
    playLabel: $('#playLabel'),
    outW: $('#outW'),
    outH: $('#outH'),
    lockAspect: $('#lockAspect'),
    fitMode: $('#fitMode'),
    transparent: $('#transparent'),
    bgColor: $('#bgColor'),
    pixelArt: $('#pixelArt'),
    delayMs: $('#delayMs'),
    fps: $('#fps'),
    btnApplyDelay: $('#btnApplyDelay'),
    loopForever: $('#loopForever'),
    loopCount: $('#loopCount'),
    filterMode: $('#filterMode'),
    threads: $('#threads'),
    optimize: $('#optimize'),
    fileName: $('#fileName'),
    btnExport: $('#btnExport'),
    progress: $('#progress'),
    progressFill: $('#progressFill'),
    progressLabel: $('#progressLabel'),
    result: $('#result'),
    resultImg: $('#resultImg'),
    statSize: $('#statSize'),
    statDims: $('#statDims'),
    statFrames: $('#statFrames'),
    statTime: $('#statTime'),
    btnDownload: $('#btnDownload'),
    error: $('#error')
  };

  var state = {
    frames: [],
    nextId: 1,
    playing: true,
    playIndex: 0,
    elapsed: 0,
    lastTs: 0,
    encoding: false,
    resultUrl: null,
    naturalW: 0,
    naturalH: 0
  };

  var previewCtx = el.preview.getContext('2d');

  /* ------------------------------------------------------------- utilities */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  /* -------------------------------------------------------------- settings */

  function currentDelay() {
    return clamp(Math.round(Number(el.delayMs.value) || 0), 0, 65535);
  }

  function readOpts() {
    return {
      width: clamp(Math.round(Number(el.outW.value) || 1), 1, 8000),
      height: clamp(Math.round(Number(el.outH.value) || 1), 1, 8000),
      fit: el.fitMode.value,
      background: el.transparent.checked ? null : el.bgColor.value,
      smoothing: !el.pixelArt.checked,
      optimize: el.optimize.checked,
      filter: Number(el.filterMode.value)
    };
  }

  var SETTINGS_KEY = 'jumpline-apng.settings';

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        fit: el.fitMode.value,
        transparent: el.transparent.checked,
        bgColor: el.bgColor.value,
        pixelArt: el.pixelArt.checked,
        delayMs: el.delayMs.value,
        loopForever: el.loopForever.checked,
        loopCount: el.loopCount.value,
        filterMode: el.filterMode.value,
        threads: el.threads.value,
        optimize: el.optimize.checked,
        lockAspect: el.lockAspect.checked
      }));
    } catch (e) { /* private mode, blocked storage — not worth reporting */ }
  }

  function loadSettings() {
    var raw;
    try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) { return; }
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || typeof s !== 'object') return;
    if (s.fit) el.fitMode.value = s.fit;
    if (typeof s.transparent === 'boolean') el.transparent.checked = s.transparent;
    if (s.bgColor) el.bgColor.value = s.bgColor;
    if (typeof s.pixelArt === 'boolean') el.pixelArt.checked = s.pixelArt;
    if (s.delayMs) el.delayMs.value = s.delayMs;
    if (typeof s.loopForever === 'boolean') el.loopForever.checked = s.loopForever;
    if (s.loopCount) el.loopCount.value = s.loopCount;
    if (s.filterMode) el.filterMode.value = s.filterMode;
    if (s.threads) el.threads.value = s.threads;
    if (typeof s.optimize === 'boolean') el.optimize.checked = s.optimize;
    if (typeof s.lockAspect === 'boolean') el.lockAspect.checked = s.lockAspect;
    syncFpsFromDelay();
    el.bgColor.disabled = el.transparent.checked;
    el.loopCount.disabled = el.loopForever.checked;
  }

  function syncFpsFromDelay() {
    var ms = currentDelay();
    el.fps.value = ms > 0 ? String(Math.round(1000 / ms * 10) / 10) : '';
  }

  function syncDelayFromFps() {
    var fps = Number(el.fps.value);
    if (!fps || fps <= 0) return;
    el.delayMs.value = String(clamp(Math.round(1000 / fps), 0, 65535));
  }

  /* ---------------------------------------------------------------- frames */

  async function addFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) {
      return f.type ? /^image\//.test(f.type) : /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name);
    });
    if (!list.length) return;

    list.sort(function (a, b) { return naturalCompare(a.name || '', b.name || ''); });

    var wasEmpty = state.frames.length === 0;
    var delay = currentDelay();
    var failed = [];

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var bitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch (e) {
        failed.push(file.name || 'image');
        continue;
      }
      state.frames.push({
        id: state.nextId++,
        name: file.name || ('frame-' + state.nextId),
        file: file,
        bitmap: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        delay: delay,
        thumb: makeThumb(bitmap)
      });
    }

    showError(failed.length ? 'Could not read: ' + failed.join(', ') : '');

    if (wasEmpty && state.frames.length) {
      state.naturalW = state.frames[0].width;
      state.naturalH = state.frames[0].height;
      el.outW.value = String(state.naturalW);
      el.outH.value = String(state.naturalH);
    }
    refresh();
  }

  function makeThumb(bitmap) {
    var size = 96;
    var scale = Math.min(size / bitmap.width, size / bitmap.height, 1);
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    return c;
  }

  function renderStrip() {
    el.strip.textContent = '';
    state.frames.forEach(function (frame, i) {
      var li = document.createElement('li');
      li.className = 'frame';
      li.draggable = true;
      li.dataset.index = String(i);
      li.title = frame.name + ' — ' + frame.width + '×' + frame.height;

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.appendChild(frame.thumb);
      var idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      thumb.appendChild(idx);
      li.appendChild(thumb);

      var wrap = document.createElement('div');
      wrap.className = 'delay-wrap';
      var input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '65535';
      input.step = '10';
      input.value = String(frame.delay);
      input.addEventListener('change', function () {
        frame.delay = clamp(Math.round(Number(input.value) || 0), 0, 65535);
        input.value = String(frame.delay);
      });
      input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      var unit = document.createElement('em');
      unit.textContent = 'ms';
      wrap.appendChild(input);
      wrap.appendChild(unit);
      li.appendChild(wrap);

      var actions = document.createElement('div');
      actions.className = 'frame-actions';
      [['left', '◀', 'Move left'], ['dup', '⧉', 'Duplicate'], ['del', '✕', 'Remove'], ['right', '▶', 'Move right']]
        .forEach(function (spec) {
          var b = document.createElement('button');
          b.type = 'button';
          b.dataset.act = spec[0];
          b.textContent = spec[1];
          b.title = spec[2];
          b.addEventListener('click', function () { frameAction(spec[0], i); });
          actions.appendChild(b);
        });
      li.appendChild(actions);

      /* Drag to reorder. */
      li.addEventListener('dragstart', function (e) {
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch (err) { /* older Safari */ }
        state.dragFrom = i;
      });
      li.addEventListener('dragend', function () {
        li.classList.remove('dragging');
        state.dragFrom = null;
        clearDropTargets();
      });
      li.addEventListener('dragover', function (e) {
        if (state.dragFrom === null || state.dragFrom === undefined) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropTargets();
        li.classList.add('drop-target');
      });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var from = state.dragFrom;
        if (from === null || from === undefined || from === i) return;
        var moved = state.frames.splice(from, 1)[0];
        state.frames.splice(i, 0, moved);
        state.dragFrom = null;
        refresh();
      });

      el.strip.appendChild(li);
    });
    highlightCurrent();
  }

  function clearDropTargets() {
    Array.prototype.forEach.call(el.strip.children, function (c) { c.classList.remove('drop-target'); });
  }

  function frameAction(act, i) {
    var f = state.frames[i];
    if (act === 'del') {
      state.frames.splice(i, 1);
      if (f.bitmap) f.bitmap.close();
    } else if (act === 'dup') {
      state.frames.splice(i + 1, 0, {
        id: state.nextId++,
        name: f.name,
        file: f.file,
        bitmap: f.bitmap,
        width: f.width,
        height: f.height,
        delay: f.delay,
        thumb: makeThumb(f.bitmap),
        shared: true
      });
    } else if (act === 'left' && i > 0) {
      state.frames.splice(i - 1, 0, state.frames.splice(i, 1)[0]);
    } else if (act === 'right' && i < state.frames.length - 1) {
      state.frames.splice(i + 1, 0, state.frames.splice(i, 1)[0]);
    } else {
      return;
    }
    refresh();
  }

  function highlightCurrent() {
    Array.prototype.forEach.call(el.strip.children, function (c, i) {
      c.classList.toggle('current', i === state.playIndex);
    });
  }

  function refresh() {
    var n = state.frames.length;
    el.frameCount.textContent = n
      ? n + (n === 1 ? ' frame' : ' frames') + ' · ' + formatDuration(totalDuration())
      : 'No frames yet';
    el.btnExport.disabled = n === 0 || state.encoding;
    el.scrub.max = String(Math.max(0, n - 1));
    if (state.playIndex >= n) state.playIndex = 0;
    el.scrub.value = String(state.playIndex);
    renderStrip();
    updatePlayLabel();
    drawPreview();
  }

  function totalDuration() {
    return state.frames.reduce(function (sum, f) { return sum + f.delay; }, 0);
  }

  function formatDuration(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms + ' ms';
  }

  function updatePlayLabel() {
    var n = state.frames.length;
    el.playLabel.textContent = (n ? state.playIndex + 1 : 0) + ' / ' + n;
  }

  /* --------------------------------------------------------------- preview */

  function drawPreview() {
    var opts = readOpts();
    if (el.preview.width !== opts.width) el.preview.width = opts.width;
    if (el.preview.height !== opts.height) el.preview.height = opts.height;
    el.preview.classList.toggle('pixelated', !opts.smoothing);

    previewCtx.clearRect(0, 0, opts.width, opts.height);
    var frame = state.frames[state.playIndex];
    if (!frame) return;
    self.EncodeCore.paint(previewCtx, frame.bitmap, opts);
  }

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!state.playing || state.frames.length < 2) { state.lastTs = ts; return; }
    if (!state.lastTs) { state.lastTs = ts; return; }

    var dt = ts - state.lastTs;
    state.lastTs = ts;
    state.elapsed += dt;

    var guard = 0;
    while (guard++ < 500) {
      var hold = Math.max(10, state.frames[state.playIndex].delay);
      if (state.elapsed < hold) break;
      state.elapsed -= hold;
      state.playIndex = (state.playIndex + 1) % state.frames.length;
      el.scrub.value = String(state.playIndex);
      updatePlayLabel();
      highlightCurrent();
      drawPreview();
    }
  }

  /* ---------------------------------------------------------------- export */

  function threadCount() {
    var chosen = Number(el.threads.value);
    if (chosen > 0) return chosen;
    return clamp(navigator.hardwareConcurrency || 4, 1, 8);
  }

  /*
   * Split frames into contiguous segments that can be encoded independently.
   * With optimisation on, each segment starts with a full key frame, so we keep
   * segments reasonably long to avoid paying for too many of them.
   */
  function planSegments(total, threads, optimize) {
    var segLen = Math.max(optimize ? 8 : 1, Math.ceil(total / threads));
    var segments = [];
    for (var start = 0; start < total; start += segLen) {
      segments.push({ start: start, end: Math.min(total, start + segLen) });
    }
    return segments;
  }

  function setProgress(done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    el.progressFill.style.width = pct + '%';
    el.progressLabel.textContent = pct + '%';
  }

  function runSegmentsInWorkers(segments, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      var workers = [];
      var queue = segments.slice();
      var collected = [];
      var pending = segments.length;
      var failed = false;

      function cleanup() {
        workers.forEach(function (w) { w.terminate(); });
        workers.length = 0;
      }

      function fail(err) {
        if (failed) return;
        failed = true;
        cleanup();
        reject(err);
      }

      function dispatch(worker) {
        if (!queue.length) return false;
        var seg = queue.shift();
        worker.postMessage({
          type: 'segment',
          id: seg.start,
          frames: state.frames.slice(seg.start, seg.end).map(function (f, i) {
            return { index: seg.start + i, source: f.file };
          }),
          opts: opts
        });
        return true;
      }

      var count = Math.min(segments.length, threadCount());
      for (var i = 0; i < count; i++) {
        var worker;
        try {
          worker = new Worker('src/worker.js');
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        worker.onerror = function (e) {
          fail(new Error(e.message || 'The encode worker crashed.'));
        };
        worker.onmessage = (function (w) {
          return function (e) {
            var msg = e.data;
            if (msg.type === 'progress') {
              onProgress();
            } else if (msg.type === 'error') {
              fail(new Error(msg.message));
            } else if (msg.type === 'done') {
              collected = collected.concat(msg.results);
              pending--;
              if (!dispatch(w) && pending === 0 && !failed) {
                cleanup();
                resolve(collected);
              }
            }
          };
        })(worker);
        workers.push(worker);
      }

      workers.forEach(dispatch);
      if (!segments.length) resolve([]);
    });
  }

  async function runSegmentsInline(segments, opts, onProgress) {
    var collected = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var frames = state.frames.slice(seg.start, seg.end).map(function (f, j) {
        return { index: seg.start + j, source: f.file };
      });
      collected = collected.concat(await self.EncodeCore.processSegment(frames, opts, onProgress));
    }
    return collected;
  }

  async function doExport() {
    if (state.encoding || !state.frames.length) return;

    var opts = readOpts();
    var total = state.frames.length;
    var pixels = opts.width * opts.height * total;
    if (pixels > 900e6) {
      showError('That is a lot of pixels (' + opts.width + '×' + opts.height + ' × ' + total +
        ' frames). Try a smaller output size or fewer frames.');
      return;
    }

    state.encoding = true;
    el.btnExport.disabled = true;
    el.btnExport.textContent = 'Encoding…';
    el.progress.hidden = false;
    el.result.hidden = true;
    showError('');
    setProgress(0, total);

    var started = performance.now();
    var done = 0;
    var onProgress = function () { setProgress(++done, total); };

    try {
      var segments = planSegments(total, threadCount(), opts.optimize);
      var results;
      try {
        results = await runSegmentsInWorkers(segments, opts, onProgress);
      } catch (workerErr) {
        // Workers are unavailable when the page is opened straight from disk
        // (file://). Fall back to encoding on this thread.
        done = 0;
        setProgress(0, total);
        results = await runSegmentsInline(segments, opts, onProgress);
      }

      results.sort(function (a, b) { return a.index - b.index; });

      /* Fold skipped (identical) frames into the previous frame's hold time. */
      var apngFrames = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var delay = state.frames[r.index].delay;
        if (r.skip && apngFrames.length) {
          apngFrames[apngFrames.length - 1].delayNum =
            Math.min(65535, apngFrames[apngFrames.length - 1].delayNum + delay);
          continue;
        }
        apngFrames.push({
          data: r.data,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          delayNum: Math.min(65535, delay),
          delayDen: 1000,
          blend: r.blend,
          dispose: 0
        });
      }

      var parts = self.PNG.buildAPNG({
        width: opts.width,
        height: opts.height,
        numPlays: el.loopForever.checked ? 0 : clamp(Math.round(Number(el.loopCount.value) || 1), 1, 100000),
        frames: apngFrames
      });

      var blob = new Blob(parts, { type: 'image/png' });
      showResult(blob, opts, apngFrames.length, performance.now() - started);
    } catch (err) {
      showError(String(err && err.message || err));
      el.progress.hidden = true;
    } finally {
      state.encoding = false;
      el.btnExport.disabled = state.frames.length === 0;
      el.btnExport.textContent = 'Build APNG';
    }
  }

  function showResult(blob, opts, frameCount, ms) {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);

    el.progress.hidden = true;
    el.resultImg.src = state.resultUrl;
    el.statSize.textContent = formatBytes(blob.size);
    el.statDims.textContent = opts.width + '×' + opts.height;
    el.statFrames.textContent = String(frameCount);
    el.statTime.textContent = ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';

    var name = (el.fileName.value || 'animation.png').trim();
    if (!/\.png$/i.test(name)) name += '.png';
    el.btnDownload.href = state.resultUrl;
    el.btnDownload.download = name;
    el.result.hidden = false;
  }

  /* ------------------------------------------------------------------ wire */

  function aspectFrom(which) {
    if (!el.lockAspect.checked || !state.naturalW || !state.naturalH) return;
    var ratio = state.naturalW / state.naturalH;
    if (which === 'w') {
      el.outH.value = String(clamp(Math.round(Number(el.outW.value) / ratio) || 1, 1, 8000));
    } else {
      el.outW.value = String(clamp(Math.round(Number(el.outH.value) * ratio) || 1, 1, 8000));
    }
  }

  function init() {
    loadSettings();

    el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
    el.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });
    el.fileInput.addEventListener('change', function () {
      addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        el.dropzone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        if (type === 'dragleave' && el.dropzone.contains(e.relatedTarget)) return;
        el.dropzone.classList.remove('dragging');
      });
    });
    el.dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });
    /* Stop the browser from navigating away when a drop misses the zone. */
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    document.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      addFiles(e.clipboardData.files);
    });

    el.btnSortName.addEventListener('click', function () {
      state.frames.sort(function (a, b) { return naturalCompare(a.name, b.name); });
      refresh();
    });
    el.btnReverse.addEventListener('click', function () {
      state.frames.reverse();
      refresh();
    });
    el.btnPingPong.addEventListener('click', function () {
      if (state.frames.length < 2) return;
      var tail = state.frames.slice(1, -1).reverse().map(function (f) {
        return {
          id: state.nextId++,
          name: f.name,
          file: f.file,
          bitmap: f.bitmap,
          width: f.width,
          height: f.height,
          delay: f.delay,
          thumb: makeThumb(f.bitmap),
          shared: true
        };
      });
      state.frames = state.frames.concat(tail);
      refresh();
    });
    el.btnClear.addEventListener('click', function () {
      state.frames.forEach(function (f) { if (!f.shared && f.bitmap) f.bitmap.close(); });
      state.frames = [];
      state.playIndex = 0;
      state.naturalW = state.naturalH = 0;
      showError('');
      el.result.hidden = true;
      refresh();
    });

    el.btnPlay.addEventListener('click', function () {
      state.playing = !state.playing;
      el.btnPlay.textContent = state.playing ? 'Pause' : 'Play';
      state.lastTs = 0;
    });
    el.scrub.addEventListener('input', function () {
      state.playing = false;
      el.btnPlay.textContent = 'Play';
      state.playIndex = clamp(Number(el.scrub.value) || 0, 0, Math.max(0, state.frames.length - 1));
      state.elapsed = 0;
      updatePlayLabel();
      highlightCurrent();
      drawPreview();
    });
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName)) return;
      e.preventDefault();
      el.btnPlay.click();
    });

    el.outW.addEventListener('input', function () { aspectFrom('w'); drawPreview(); });
    el.outH.addEventListener('input', function () { aspectFrom('h'); drawPreview(); });

    document.querySelectorAll('[data-scale]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!state.naturalW) return;
        var s = Number(b.dataset.scale);
        el.outW.value = String(Math.max(1, Math.round(state.naturalW * s)));
        el.outH.value = String(Math.max(1, Math.round(state.naturalH * s)));
        drawPreview();
      });
    });
    document.querySelectorAll('[data-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        var size = Number(b.dataset.size);
        el.outW.value = String(size);
        if (el.lockAspect.checked && state.naturalW) aspectFrom('w');
        else el.outH.value = String(size);
        drawPreview();
      });
    });

    [el.fitMode, el.pixelArt, el.bgColor].forEach(function (input) {
      input.addEventListener('input', function () { drawPreview(); saveSettings(); });
    });
    el.transparent.addEventListener('change', function () {
      el.bgColor.disabled = el.transparent.checked;
      drawPreview();
      saveSettings();
    });
    el.loopForever.addEventListener('change', function () {
      el.loopCount.disabled = el.loopForever.checked;
      saveSettings();
    });

    el.delayMs.addEventListener('input', function () { syncFpsFromDelay(); saveSettings(); });
    el.fps.addEventListener('input', function () { syncDelayFromFps(); saveSettings(); });
    el.btnApplyDelay.addEventListener('click', function () {
      var d = currentDelay();
      state.frames.forEach(function (f) { f.delay = d; });
      refresh();
    });

    [el.filterMode, el.threads, el.optimize, el.lockAspect].forEach(function (input) {
      input.addEventListener('change', saveSettings);
    });

    el.btnExport.addEventListener('click', doExport);

    if (!self.PNG.hasCompressionStream) {
      showError('Heads up: this browser has no CompressionStream, so Jumpline falls back to a slower encoder. ' +
        'Everything still works, but a recent Chrome, Firefox or Safari will be much faster.');
    }

    refresh();
    requestAnimationFrame(tick);
  }

  init();
})();
