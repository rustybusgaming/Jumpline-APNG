/* Encode worker: one segment of frames at a time. */
'use strict';

importScripts('png.js', 'encode-core.js');

self.onmessage = async function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'segment') return;

  try {
    var results = await self.EncodeCore.processSegment(msg.frames, msg.opts, function (index) {
      self.postMessage({ type: 'progress', index: index });
    });

    var transfer = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].data) transfer.push(results[i].data.buffer);
    }
    self.postMessage({ type: 'done', id: msg.id, results: results }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
