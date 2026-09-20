/*
 * zip.js: a minimal store-only ZIP writer.
 *
 * Frames are already PNG-compressed, so deflating them again buys nothing;
 * every entry is stored verbatim. Reuses the CRC table from png.js.
 */
(function (global) {
  'use strict';

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  }

  /* files: [{ name, data: Uint8Array }] -> Blob */
  function build(files) {
    var encoder = new TextEncoder();
    var now = new Date();
    var time = dosTime(now);
    var date = dosDate(now);

    var locals = [];
    var centrals = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var name = encoder.encode(files[i].name);
      var data = files[i].data;
      var crc = global.PNG.crc32(data, 0, data.length);

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);      // version needed
      lv.setUint16(6, 0, true);       // flags
      lv.setUint16(8, 0, true);       // stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);      // version made by
      cv.setUint16(6, 20, true);      // version needed
      cv.setUint16(10, 0, true);      // stored
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);

      locals.push(local, data);
      centrals.push(central);
      offset += local.length + data.length;
    }

    var centralSize = 0;
    for (var c = 0; c < centrals.length; c++) centralSize += centrals[c].length;

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(locals.concat(centrals, [end]), { type: 'application/zip' });
  }

  global.Zip = { build: build };
})(typeof self !== 'undefined' ? self : this);
