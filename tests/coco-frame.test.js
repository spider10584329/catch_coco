'use strict';
/**
 * Tests for the shared frame decoder, driven by the real websocket capture from
 * traffic.log line 19540. Run with `npm test`.
 */

const assert = require('node:assert');
const path = require('node:path');
const CF = require(path.join(__dirname, '..', 'src', 'shared', 'coco-frame.js'));

const OFFER_FRAME_B64 =
  'BAINL2dhbWUtc3VwcG9ydA9ib251cy1jcm9jb2RpbGV7InRvdGFsQm9udXMiOiIyMDAwMDAwIiwiZW5kVGltZSI6MTc5MzI2MDE0NTQ5OSwiY3JlYXRlVGltZSI6MTc5MzI2MDA4NTQ5OSwibGltaXRMZXZlbCI6MywiY3VycmVuY3lOYW1lIjoiQkNEIiwiZGF0YVNpZ24iOiI4MDY3NzVlNDgxNzM4YTM3MjQwYzlhNWNmOGYxOWI5OTdkMDc3M2E1ZDU3NmQ0NjQ1YWNkY2Y3MjBhNWMyODlkIiwic2VuZFRpbWUiOjB9';

const BALANCE_FRAME_B64 =
  'BAIFL3VzZXIRYmFsYW5jZS1jaGFuZ2UtdjISEzE4ODAzNjk1MDk4MDAyNTkwMDIaA0JDRCIKMC4wODU5MzE4NCoKMC4wODU5MzE4NDIBMDoIMC4wODU5MThCCDAuMDg1OTE4SgEw';

function offerBytes() {
  return Buffer.from(OFFER_FRAME_B64, 'base64');
}

function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('containsAscii finds the event name', () => {
  assert.strictEqual(CF.containsAscii(offerBytes(), CF.EVENT), true);
  assert.strictEqual(CF.containsAscii(Buffer.from('short'), CF.EVENT), false);
});

test('parseFrame decodes the captured offer frame', () => {
  const parsed = CF.parseFrame(offerBytes());
  assert.ok(parsed, 'expected the frame to parse');
  assert.strictEqual(parsed.namespace, '/game-support');
  assert.strictEqual(parsed.event, 'bonus-crocodile');
  assert.strictEqual(parsed.payload.totalBonus, '2000000');
  assert.strictEqual(parsed.payload.currencyName, 'BCD');
  assert.strictEqual(parsed.payload.limitLevel, 3);
  assert.strictEqual(parsed.payload.endTime, 1793260145499);
  assert.strictEqual(
    parsed.payload.dataSign,
    '806775e481738a37240c9a5cf8f19b997d0773a5d576d4645acdcf720a5c289d'
  );
});

test('parseFrame accepts ArrayBuffer and offset views', () => {
  const bytes = offerBytes();
  assert.ok(CF.parseFrame(toArrayBuffer(bytes)));

  const padded = new Uint8Array(bytes.length + 16);
  padded.set(bytes, 8);
  const view = new Uint8Array(padded.buffer, 8, bytes.length);
  assert.ok(CF.parseFrame(view));
});

test('parseFrame accepts an already-decoded text frame', () => {
  const text = '\u0004\u0002\r/game-support\u000fbonus-crocodile' +
    JSON.stringify({ currencyName: 'BCD', dataSign: 'a'.repeat(64), totalBonus: '10' });
  const parsed = CF.parseFrame(text);
  assert.ok(parsed);
  assert.strictEqual(parsed.payload.dataSign, 'a'.repeat(64));
});

test('parseFrame ignores unrelated frames', () => {
  assert.strictEqual(CF.parseFrame(Buffer.from(BALANCE_FRAME_B64, 'base64')), null);
  assert.strictEqual(CF.parseFrame(Buffer.from('2')), null);
  assert.strictEqual(CF.parseFrame(null), null);
  assert.strictEqual(CF.parseFrame(new Uint8Array(0)), null);
  assert.strictEqual(CF.parseFrame(new Uint8Array(CF.MAX_FRAME_BYTES + 1)), null);
});

test('parseFrame rejects the wrong namespace or invalid JSON', () => {
  const wrongNamespace = '\u0004\u0002\r/game-other\u000fbonus-crocodile{"dataSign":"x"}';
  assert.strictEqual(CF.parseFrame(wrongNamespace), null);

  const badJson = '\u0004\u0002\r/game-support\u000fbonus-crocodile{dataSign:oops}';
  assert.strictEqual(CF.parseFrame(badJson), null);
});

test('extractJsonObject handles nested braces and escaped quotes', () => {
  const BS = String.fromCharCode(92); // single backslash, avoids literal-escaping ambiguity
  const Q = String.fromCharCode(34); // double quote
  const json = '{' + Q + 'a' + Q + ':{' + Q + 'b' + Q + ':' + Q + '}' + BS + Q + Q + '},' + Q + 'c' + Q + ':1}';
  const text = 'prefix' + json + 'suffix';

  assert.strictEqual(CF.extractJsonObject(text, 0), json);
  assert.strictEqual(JSON.parse(json).c, 1);
  assert.strictEqual(CF.extractJsonObject('no json here', 0), null);
});

test('normalizeOffer keeps the claim fields and drops unsigned pushes', () => {
  const parsed = CF.parseFrame(offerBytes());
  const offer = CF.normalizeOffer(parsed.payload);
  assert.ok(offer);
  assert.strictEqual(offer.dataSign, parsed.payload.dataSign);
  assert.strictEqual(offer.currencyName, 'BCD');
  assert.strictEqual(offer.totalBonus, '2000000');
  assert.strictEqual(offer.limitLevel, 3);

  assert.strictEqual(CF.normalizeOffer({ currencyName: 'BCD' }), null);
  assert.strictEqual(CF.normalizeOffer(null), null);
  assert.strictEqual(CF.normalizeOffer({ dataSign: '   ' }), null);
});

test('buildClaimBody matches the request the site sends', () => {
  const offer = CF.normalizeOffer(CF.parseFrame(offerBytes()).payload);
  assert.deepStrictEqual(CF.buildClaimBody(offer), {
    currencyName: 'BCD',
    dataSign: '806775e481738a37240c9a5cf8f19b997d0773a5d576d4645acdcf720a5c289d'
  });
  assert.strictEqual(CF.buildClaimBody(null), null);
  assert.strictEqual(CF.buildClaimBody({ currencyName: 'BCD' }), null);
});

test('remainingMs and isExpired respect the push endTime', () => {
  const offer = { endTime: 100000 };
  assert.strictEqual(CF.remainingMs(offer, 40000), 60000);
  assert.strictEqual(CF.remainingMs(offer, 120000), 0);
  assert.strictEqual(CF.isExpired(offer, 99999), false);
  assert.strictEqual(CF.isExpired(offer, 100000), true);
  assert.strictEqual(CF.remainingMs({ endTime: null }, 1), null);
  assert.strictEqual(CF.isExpired({}, 1), false);
});

test('withLocalDeadline survives a PC clock that is off', () => {
  const offer = CF.normalizeOffer(CF.parseFrame(offerBytes()).payload);
  assert.strictEqual(CF.lifetimeMs(offer), 60000);
  // Local clock 5 minutes past the server endTime: raw endTime says "expired".
  const receivedAt = offer.endTime + 5 * 60000;
  assert.strictEqual(CF.isExpired(offer, receivedAt), true);
  const stamped = CF.withLocalDeadline(offer, receivedAt);
  assert.strictEqual(CF.remainingMs(stamped, receivedAt), 60000);
  assert.strictEqual(CF.isExpired(stamped, receivedAt + 59999), false);
  assert.strictEqual(CF.isExpired(stamped, receivedAt + 60000), true);
  assert.strictEqual(offer.localDeadline, undefined, 'input must not be mutated');
  assert.strictEqual(CF.lifetimeMs({ endTime: 5, createTime: null }), null);
});

test('schedule knows the four JST Coco windows', () => {
  // 2026-11-02 01:50 UTC = 10:50 JST (inside the 10:45 window)
  const at1050 = Date.UTC(2026, 10, 2, 1, 50);
  assert.strictEqual(CF.inWindow(at1050), true);
  assert.strictEqual(CF.nextWindow(at1050).label, '16:45–17:15 JST');
  // 22:30 JST: not live, 22:45 window starts in 15 minutes, prepare alarm in 10
  const at2230 = Date.UTC(2026, 10, 2, 13, 30);
  assert.strictEqual(CF.inWindow(at2230), false);
  assert.strictEqual(CF.inWindow(at2230, 15), true);
  assert.strictEqual(CF.nextWindow(at2230).ms, 15 * 60000);
  assert.strictEqual(CF.msUntilWindow(3, -5, at2230), 10 * 60000);
  assert.deepStrictEqual(CF.WINDOWS_JST.map((_, i) => CF.windowLabel(i)), [
    '04:45–05:15 JST', '10:45–11:15 JST', '16:45–17:15 JST', '22:45–23:15 JST'
  ]);
});

test('HOST_PATTERN accepts every BC.Game mirror only', () => {
  ['https://bc.game/', 'https://bc.co/api/x', 'https://www.bc.game', 'https://bcgame.ai/game/limbo',
    'https://bcgame.com/'].forEach((url) => assert.ok(CF.HOST_PATTERN.test(url), url));
  ['https://evil.com/bc.game', 'https://bc.game.evil.com/', 'https://abc.co/'].forEach((url) =>
    assert.ok(!CF.HOST_PATTERN.test(url), url));
});

test('manifest never lists one file in two content_scripts entries', () => {
  // Chrome injects a file once per frame: a file shared by the MAIN and ISOLATED entries
  // only reaches the first one, which left content.js without CocoFrame (it never ran).
  const manifest = require(path.join(__dirname, '..', 'manifest.json'));
  const seen = new Map();
  manifest.content_scripts.forEach((entry, index) => {
    entry.js.forEach((file) => {
      assert.ok(!seen.has(file), file + ' is listed in content_scripts[' + seen.get(file) + '] and [' + index + ']');
      seen.set(file, index);
    });
  });
  const isolated = manifest.content_scripts.find((entry) => entry.world !== 'MAIN');
  assert.strictEqual(isolated.js[0], 'src/shared/coco-frame.js', 'CocoFrame must load before content.js');
});

test('COCO_KEYWORDS matches Coco assets but not unrelated names', () => {
  ['/assets/bonus-crocodile-halloween-3f9a.png', 'coco-hang', 'Coco'].forEach((v) => assert.ok(CF.COCO_KEYWORDS.test(v), v));
  ['/assets/banner.png', 'chat-message', 'casino'].forEach((v) => assert.ok(!CF.COCO_KEYWORDS.test(v), v));
});

let failed = 0;
tests.forEach(({ name, fn }) => {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    console.error('  FAIL ' + name);
    console.error('       ' + (error && error.message ? error.message : error));
  }
});

console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
if (failed > 0) process.exitCode = 1;
