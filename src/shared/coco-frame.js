/* global module */
/**
 * Shared decoder for BC.Game "Coco" (crocodile bonus) websocket pushes.
 *
 * Evidence (traffic.log line 19540, [WEBSOCKET RECEIVED] on https://bcgame.ai/game/limbo):
 *
 *   [binary:base64] BAINL2dhbWUtc3VwcG9ydA9ib251cy1jcm9jb2RpbGV7InRvdGFsQm9udXMiOiIyMDAwMDAwIi...
 *
 * which decodes to
 *
 *   04 02 0d "/game-support" 0f "bonus-crocodile" {"totalBonus":"2000000",...,"dataSign":"..."}
 *
 * i.e. a length-prefixed envelope (`<array header><msg type><len><namespace><len><event>`) followed by
 * the raw JSON payload. The site binds it with `namespace: "/game-support"` in
 * `assets/bonus-crocodile-*.js` and only reacts when `dataSign` is present.
 *
 * Loaded as a classic script in the page, the service worker (importScripts) and the popup,
 * so everything hangs off one global (`CocoFrame`).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CocoFrame = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** socket.io namespace the site registers the Coco handler on. */
  var NAMESPACE = '/game-support';
  /** socket.io event name of the Coco push. */
  var EVENT = 'bonus-crocodile';
  /** window.postMessage channel used between the MAIN and ISOLATED worlds. */
  var CHANNEL = 'coco-catcher';
  /** REST endpoint the site calls when the player catches Coco. */
  var CLAIM_PATH = '/api/game/support/bonus/crocodile/';
  /** Coco frames are tiny (~250 bytes); anything bigger is ordinary game traffic. */
  var MAX_FRAME_BYTES = 64 * 1024;
  /** Every BC.Game mirror the extension runs on (keep in sync with manifest.json). */
  var HOST_PATTERN = /^https?:\/\/([a-z0-9-]+\.)*(bc\.game|bc\.co|bcgame\.ai|bcgame\.com)(:\d+)?(\/|$)/i;

  /** Daily Coco windows in JST (GMT+9, no DST): [startHour, startMinute]. */
  var WINDOWS_JST = [[4, 45], [10, 45], [16, 45], [22, 45]];
  /** Each window lasts 30 minutes (hh:45 until hh:15 of the next hour). */
  var WINDOW_LENGTH_MIN = 30;
  var JST_OFFSET_MS = 9 * 3600 * 1000;
  var DAY_MS = 86400 * 1000;

  /** Runtime message types shared by content script, service worker and popup. */
  var MSG = Object.freeze({
    OFFER_CAPTURED: 'coco/offer-captured',
    SMID_CAPTURED: 'coco/smid-captured',
    PING: 'coco/ping',
    CLAIM_REQUEST: 'coco/claim-request',
    POPUP_CLAIM: 'coco/popup-claim',
    CLAIM_RESULT: 'coco/claim-result',
    DISMISS: 'coco/dismiss',
    GET_STATE: 'coco/get-state',
    SET_SETTINGS: 'coco/set-settings',
    CLEAR_HISTORY: 'coco/clear-history',
    STATE_UPDATED: 'coco/state-updated',
    DOM_EVENT: 'coco/dom-event',
    DEBUG_EVENT: 'coco/debug-event',
    GET_DEBUG: 'coco/get-debug',
    TRUSTED_CLICK: 'coco/trusted-click',
    PICK_START: 'coco/pick-start',
    PICK_SAVED: 'coco/pick-saved',
    FIND_NOW: 'coco/find-now',
    CLEAR_PICK: 'coco/clear-pick'
  });

  /**
   * Words that identify the Coco icon in image URLs, class names and ids. The site's own
   * module is `assets/bonus-crocodile-*.js`, and the icon is a crocodile ("Coco"), shown
   * hanging from a rope at the top-right (seasonal skins, e.g. inside a Halloween pumpkin).
   */
  var COCO_KEYWORDS = /croc|coco/i;

  var textDecoder = typeof TextDecoder === 'function'
    ? new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
    : null;

  /** Fast ASCII scan so we can skip decoding ordinary binary traffic. */
  function containsAscii(bytes, ascii) {
    var n = bytes.length;
    var m = ascii.length;
    if (m === 0 || n < m) return false;
    var first = ascii.charCodeAt(0);
    for (var i = 0; i <= n - m; i += 1) {
      if (bytes[i] !== first) continue;
      var j = 1;
      while (j < m && bytes[i + j] === ascii.charCodeAt(j)) j += 1;
      if (j === m) return true;
    }
    return false;
  }

  function decodeBytes(bytes) {
    if (!textDecoder) return '';
    return textDecoder.decode(bytes);
  }

  /** Return the first balanced `{...}` block found at or after `fromIndex`. */
  function extractJsonObject(text, fromIndex) {
    var start = text.indexOf('{', fromIndex);
    if (start < 0) return null;
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch.charCodeAt(0) === 92) escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      var parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  /**
   * Parse an already-decoded frame body.
   * @param {string} text
   * @returns {{namespace: string, event: string, payload: object}|null}
   */
  function parseOffer(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    var eventIndex = text.indexOf(EVENT);
    if (eventIndex < 0) return null;
    if (text.indexOf(NAMESPACE) < 0) return null;
    var json = extractJsonObject(text, eventIndex);
    if (!json) return null;
    var payload;
    try {
      payload = JSON.parse(json);
    } catch (error) {
      return null;
    }
    if (!isPlainObject(payload)) return null;
    return { namespace: NAMESPACE, event: EVENT, payload: payload };
  }

  /** Convert any websocket frame representation into a Uint8Array. */
  function toBytes(data) {
    if (!data) return null;
    if (typeof Uint8Array === 'function' && data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer === 'function' && data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof ArrayBuffer === 'function' && ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  /**
   * Accept any websocket frame representation and return the Coco offer if it is one.
   * @param {string|ArrayBuffer|ArrayBufferView|null} data
   */
  function parseFrame(data) {
    if (typeof data === 'string') return parseOffer(data);
    var bytes = toBytes(data);
    if (!bytes) return null;
    if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return null;
    if (!containsAscii(bytes, EVENT)) return null;
    return parseOffer(decodeBytes(bytes));
  }

  /**
   * Flatten the raw payload into the shape the extension works with.
   * Returns null when the push carries no `dataSign` (the site ignores those too).
   */
  function normalizeOffer(payload) {
    if (!isPlainObject(payload)) return null;
    var dataSign = typeof payload.dataSign === 'string' ? payload.dataSign.trim() : '';
    if (!dataSign) return null;
    var totalBonus = payload.totalBonus;
    return {
      dataSign: dataSign,
      currencyName: typeof payload.currencyName === 'string' ? payload.currencyName : '',
      totalBonus: typeof totalBonus === 'string' || typeof totalBonus === 'number' ? String(totalBonus) : '',
      limitLevel: toFiniteNumber(payload.limitLevel),
      createTime: toFiniteNumber(payload.createTime),
      endTime: toFiniteNumber(payload.endTime),
      sendTime: toFiniteNumber(payload.sendTime)
    };
  }

  /**
   * Offer lifetime from the server's own timestamps (endTime - createTime). Unlike
   * `endTime - Date.now()` this is immune to the local PC clock being off.
   */
  function lifetimeMs(offer) {
    if (!offer || offer.endTime === null || offer.createTime === null) return null;
    if (typeof offer.endTime !== 'number' || typeof offer.createTime !== 'number') return null;
    var life = offer.endTime - offer.createTime;
    return life > 0 ? life : null;
  }

  /**
   * Stamp the offer with a deadline on the local clock, taken at the moment the push
   * arrived. A PC clock that is a minute fast would otherwise make every offer look
   * expired on arrival and the claim would never be sent.
   */
  function withLocalDeadline(offer, receivedAt) {
    if (!offer) return offer;
    var life = lifetimeMs(offer);
    if (life === null) return offer;
    var copy = {};
    Object.keys(offer).forEach(function (key) { copy[key] = offer[key]; });
    copy.localDeadline = (typeof receivedAt === 'number' ? receivedAt : Date.now()) + life;
    return copy;
  }

  /** Milliseconds left before the offer disappears, or null when the push has no deadline. */
  function remainingMs(offer, now) {
    if (!offer) return null;
    var end = typeof offer.localDeadline === 'number' ? offer.localDeadline : offer.endTime;
    if (end === null || end === undefined) return null;
    var reference = typeof now === 'number' ? now : Date.now();
    return Math.max(0, end - reference);
  }

  function isExpired(offer, now) {
    var left = remainingMs(offer, now);
    return left !== null && left <= 0;
  }

  /**
   * Build the request body for POST /api/game/support/bonus/crocodile/.
   * The site sends exactly `{currencyName, dataSign}` (see traffic.log line 19582).
   */
  function buildClaimBody(offer) {
    if (!offer || !offer.dataSign) return null;
    return { currencyName: offer.currencyName, dataSign: offer.dataSign };
  }

  /** Milliseconds from `now` until window `index` starts, shifted by `offsetMin`. */
  function msUntilWindow(index, offsetMin, now) {
    var w = WINDOWS_JST[index];
    var reference = typeof now === 'number' ? now : Date.now();
    var target = (w[0] * 60 + w[1] + (offsetMin || 0)) * 60000;
    var sinceMidnight = (reference + JST_OFFSET_MS) % DAY_MS;
    return (((target - sinceMidnight) % DAY_MS) + DAY_MS) % DAY_MS;
  }

  /** Whether `now` falls inside a Coco window (with an optional margin either side). */
  function inWindow(now, marginMin) {
    var reference = typeof now === 'number' ? now : Date.now();
    var margin = marginMin || 0;
    var minute = ((reference + JST_OFFSET_MS) % DAY_MS) / 60000;
    return WINDOWS_JST.some(function (w) {
      var start = w[0] * 60 + w[1];
      return minute >= start - margin && minute <= start + WINDOW_LENGTH_MIN + margin;
    });
  }

  /** The next window to start: `{ index, ms, label }`. */
  function nextWindow(now) {
    var best = null;
    WINDOWS_JST.forEach(function (w, i) {
      var ms = msUntilWindow(i, 0, now);
      if (!best || ms < best.ms) best = { index: i, ms: ms, label: windowLabel(i) };
    });
    return best;
  }

  function windowLabel(index) {
    var w = WINDOWS_JST[index];
    var end = w[0] * 60 + w[1] + WINDOW_LENGTH_MIN;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(w[0]) + ':' + pad(w[1]) + '–' + pad(Math.floor(end / 60) % 24) + ':' + pad(end % 60) + ' JST';
  }

  return {
    NAMESPACE: NAMESPACE,
    EVENT: EVENT,
    CHANNEL: CHANNEL,
    CLAIM_PATH: CLAIM_PATH,
    MAX_FRAME_BYTES: MAX_FRAME_BYTES,
    HOST_PATTERN: HOST_PATTERN,
    COCO_KEYWORDS: COCO_KEYWORDS,
    WINDOWS_JST: WINDOWS_JST,
    MSG: MSG,
    lifetimeMs: lifetimeMs,
    withLocalDeadline: withLocalDeadline,
    msUntilWindow: msUntilWindow,
    inWindow: inWindow,
    nextWindow: nextWindow,
    windowLabel: windowLabel,
    containsAscii: containsAscii,
    decodeBytes: decodeBytes,
    toBytes: toBytes,
    extractJsonObject: extractJsonObject,
    parseOffer: parseOffer,
    parseFrame: parseFrame,
    normalizeOffer: normalizeOffer,
    buildClaimBody: buildClaimBody,
    remainingMs: remainingMs,
    isExpired: isExpired
  };
});

