#!/usr/bin/env node
/**
 * Decodes a captured Coco websocket frame so a new BC.Game frame shape can be checked
 * without loading the extension.
 *
 *   npm run decode -- BAINL2dhbWUtc3VwcG9ydA9ib251cy1jcm9jb2RpbGV7...
 *   npm run decode -- --log "D:\...\traffic.log" [lineNumber]
 */
'use strict';

var fs = require('fs');
var path = require('path');
var CF = require(path.join(__dirname, '..', 'src', 'shared', 'coco-frame.js'));

function decodeBase64(input) {
  var bytes = Buffer.from(input.trim(), 'base64');
  var parsed = CF.parseFrame(bytes);
  if (!parsed) {
    console.error('Frame did not match the Coco envelope.');
    console.error('Decoded text: ' + JSON.stringify(CF.decodeBytes(bytes)));
    process.exitCode = 1;
    return;
  }
  console.log('namespace : ' + parsed.namespace);
  console.log('event     : ' + parsed.event);
  console.log('payload   : ' + JSON.stringify(parsed.payload, null, 2));
  var offer = CF.normalizeOffer(parsed.payload);
  console.log('offer     : ' + JSON.stringify(offer, null, 2));
  console.log('claim body: ' + JSON.stringify(CF.buildClaimBody(offer), null, 2));
}

function findFrameInLog(logPath, lineNumber) {
  var lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  var pattern = /\[binary:base64\]\s*([A-Za-z0-9+/=]+)/;
  // A traffic log interleaves many socket frames, so prefer the frame that actually
  // decodes to the Coco envelope instead of blindly taking the first one in range.
  var start = lineNumber ? Math.max(0, lineNumber - 3) : 0;
  var end = lineNumber ? Math.min(lines.length, lineNumber + 3) : lines.length;
  var fallback = null;
  for (var i = start; i < end; i += 1) {
    var match = lines[i].match(pattern);
    if (!match) continue;
    var bytes = Buffer.from(match[1], 'base64');
    if (CF.containsAscii(bytes, CF.EVENT)) {
      console.log('Found Coco frame on line ' + (i + 1));
      return match[1];
    }
    if (fallback === null) fallback = { line: i + 1, data: match[1] };
  }
  if (fallback !== null) {
    console.log('No Coco frame in range; using base64 frame on line ' + fallback.line);
    return fallback.data;
  }
  return null;
}

var args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node tools/decode-frame.js <base64-frame>');
  console.error('       node tools/decode-frame.js --log <traffic.log> [lineNumber]');
  process.exitCode = 1;
} else if (args[0] === '--log') {
  var logPath = args[1];
  if (!logPath) {
    console.error('--log needs a path.');
    process.exitCode = 1;
  } else {
    var frame = findFrameInLog(logPath, args[2] ? Number(args[2]) : 0);
    if (frame) decodeBase64(frame);
    else {
      console.error('No base64 websocket frame found in that range.');
      process.exitCode = 1;
    }
  }
} else {
  decodeBase64(args[0]);
}
