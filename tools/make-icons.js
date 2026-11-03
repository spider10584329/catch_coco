#!/usr/bin/env node
/**
 * Generates the PNG icons referenced by manifest.json without any dependency.
 * Run with `npm run icons`.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var SIZES = [16, 32, 48, 128];
var OUT_DIR = path.join(__dirname, '..', 'icons');

var BG_TOP = [74, 222, 128];
var BG_BOTTOM = [21, 128, 61];
var FACE = [6, 46, 22];
var EYE = [248, 250, 252];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function crcTable() {
  if (crcTable.table) return crcTable.table;
  var out = new Int32Array(256);
  for (var n = 0; n < 256; n += 1) {
    var c = n;
    for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    out[n] = c;
  }
  crcTable.table = out;
  return out;
}

function crc32(buf) {
  var table = crcTable();
  var crc = -1;
  for (var i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pixel(x, y, size) {
  var u = (x + 0.5) / size;
  var v = (y + 0.5) / size;
  var r = 0.22;
  var dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r));
  var dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
  if (Math.sqrt(dx * dx + dy * dy) > r) return [0, 0, 0, 0];

  var base = mix(BG_TOP, BG_BOTTOM, v);
  var snout = v > 0.52 && v < 0.76 && u > 0.14 && u < 0.86;
  var jaw = v > 0.76 && v < 0.82 && u > 0.24 && u < 0.76;
  var eyeBand = v > 0.3 && v < 0.42;
  var leftEye = eyeBand && u > 0.28 && u < 0.4;
  var rightEye = eyeBand && u > 0.6 && u < 0.72;

  if (leftEye || rightEye) return [EYE[0], EYE[1], EYE[2], 255];
  if (snout || jaw) return [FACE[0], FACE[1], FACE[2], 255];
  return [base[0], base[1], base[2], 255];
}

function encodePng(size) {
  var raw = Buffer.alloc(size * (size * 4 + 1));
  var offset = 0;
  for (var y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (var x = 0; x < size; x += 1) {
      var rgba = pixel(x, y, size);
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
      offset += 4;
    }
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
SIZES.forEach(function (size) {
  var png = encodePng(size);
  var target = path.join(OUT_DIR, 'icon' + size + '.png');
  fs.writeFileSync(target, png);
  console.log('wrote ' + target + ' (' + png.length + ' bytes)');
});
