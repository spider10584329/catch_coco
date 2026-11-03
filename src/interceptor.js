/**
 * MAIN-world hook. Runs at document_start before any site script, so the WebSocket
 * wrapper is in place before BC.Game opens its socket.io connection.
 *
 * Responsibilities:
 *   1. Forward websocket frames that mention Coco ("croc"/"coco") to the ISOLATED content
 *      script on a private window.postMessage channel. Decoding happens there.
 *   2. Capture the `smid` device header the site sends on its own API calls, so the
 *      claim request can replay it.
 *   3. Report Coco-related sockets/requests for the popup's debug report.
 *
 * This file is deliberately self-contained (no CocoFrame): Chrome injects a file only once
 * per frame even when two content_scripts entries list it, so sharing coco-frame.js with
 * the ISOLATED entry left that world without CocoFrame and content.js silently exited.
 *
 * Nothing is sent to any third party: data only goes to the extension's own content script.
 */
(function () {
  'use strict';
  if (window.__cocoCatcherMain) return;
  window.__cocoCatcherMain = true;

  /** Must match CocoFrame.CHANNEL. */
  var CHANNEL = 'coco-catcher';
  /** Must match CocoFrame.COCO_KEYWORDS. */
  var KEYWORDS = /croc|coco/i;
  var MAX_FRAME_BYTES = 64 * 1024;
  var debugBudget = 150;

  function post(type, payload) {
    try {
      var message = { source: CHANNEL, type: type };
      if (payload) {
        Object.keys(payload).forEach(function (key) { message[key] = payload[key]; });
      }
      window.postMessage(message, location.origin);
    } catch (error) {
      /* ignore postMessage failures (e.g. sandboxed frames) */
    }
  }

  /* Diagnostics for the popup's "Copy debug report": capped, Coco-related only. */
  function debug(kind, detail) {
    if (debugBudget <= 0) return;
    debugBudget -= 1;
    post('debug', { entry: { kind: kind, detail: detail, page: location.pathname } });
  }

  function stripQuery(url) {
    return String(url || '').split('?')[0].slice(0, 200);
  }

  /** Case-insensitive ASCII scan for "croc"/"coco" without decoding the whole frame. */
  function bytesMentionCoco(bytes) {
    for (var i = 0; i + 4 <= bytes.length; i += 1) {
      var a = bytes[i] | 32;
      if (a !== 99) continue; // 'c'
      var b = bytes[i + 1] | 32;
      var c = bytes[i + 2] | 32;
      var d = bytes[i + 3] | 32;
      if ((b === 114 && c === 111 && d === 99) || (b === 111 && c === 99 && d === 111)) return true; // roc / oco
    }
    return false;
  }

  function forward(data, receivedAt) {
    if (typeof data === 'string') {
      if (data.length <= MAX_FRAME_BYTES && KEYWORDS.test(data)) {
        post('frame', { data: data, receivedAt: receivedAt });
      }
      return;
    }
    var bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return;
    if (!bytesMentionCoco(bytes)) return;
    post('frame', { data: bytes.slice().buffer, receivedAt: receivedAt });
  }

  function inspect(data) {
    if (!data) return;
    var receivedAt = Date.now();
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      if (data.size > MAX_FRAME_BYTES || typeof data.arrayBuffer !== 'function') return;
      data.arrayBuffer().then(function (buffer) { forward(buffer, receivedAt); }).catch(function () {});
      return;
    }
    forward(data, receivedAt);
  }

  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    var WrappedWebSocket = function WebSocket(url, protocols) {
      var socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      try {
        debug('ws-open', stripQuery(url));
        socket.addEventListener('message', function (event) { inspect(event.data); });
      } catch (error) {
        /* ignore */
      }
      return socket;
    };
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (key) {
      try { WrappedWebSocket[key] = NativeWebSocket[key]; } catch (error) {}
    });
    try {
      window.WebSocket = WrappedWebSocket;
      // Shared DOM flag so the ISOLATED script can tell the worker the hook is live.
      document.documentElement.dataset.cocoHooked = '1';
    } catch (error) {}
  }

  /* ---------------- smid header + Coco-related HTTP diagnostics ---------------- */

  var lastSmid = '';

  /** The ISOLATED script checks `url` against CocoFrame.HOST_PATTERN before using it. */
  function reportSmid(value, url) {
    if (typeof value !== 'string') return;
    var trimmed = value.trim();
    if (!trimmed || trimmed === lastSmid) return;
    lastSmid = trimmed;
    post('smid', { value: trimmed, url: String(url || '') });
  }

  function readSmid(headers, url) {
    if (!headers) return;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        reportSmid(headers.get('smid'), url);
        return;
      }
      if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (pair && String(pair[0]).toLowerCase() === 'smid') reportSmid(pair[1], url);
        });
        return;
      }
      if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (key) {
          if (key.toLowerCase() === 'smid') reportSmid(headers[key], url);
        });
      }
    } catch (error) {}
  }

  var NativeXhr = window.XMLHttpRequest;
  if (NativeXhr && NativeXhr.prototype) {
    var nativeOpen = NativeXhr.prototype.open;
    var nativeSend = NativeXhr.prototype.send;
    var nativeSetHeader = NativeXhr.prototype.setRequestHeader;
    NativeXhr.prototype.open = function (method, url) {
      try {
        this.__cocoUrl = url ? String(url) : '';
        this.__cocoMethod = method ? String(method) : 'GET';
      } catch (error) {}
      return nativeOpen.apply(this, arguments);
    };
    NativeXhr.prototype.setRequestHeader = function (name, value) {
      try {
        if (typeof name === 'string' && name.toLowerCase() === 'smid') reportSmid(value, this.__cocoUrl);
      } catch (error) {}
      return nativeSetHeader.apply(this, arguments);
    };
    NativeXhr.prototype.send = function (body) {
      try {
        var xhr = this;
        if (KEYWORDS.test(xhr.__cocoUrl || '')) {
          xhr.addEventListener('loadend', function () {
            var text = '';
            try { text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '[' + xhr.responseType + ']'; } catch (error) {}
            debug('http', {
              method: xhr.__cocoMethod, url: stripQuery(xhr.__cocoUrl), status: xhr.status,
              body: typeof body === 'string' ? body.slice(0, 400) : '', response: String(text).slice(0, 400)
            });
          });
        }
      } catch (error) {}
      return nativeSend.apply(this, arguments);
    };
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
        readSmid(init && init.headers, url);
        if (input && typeof input === 'object' && input.headers) readSmid(input.headers, url);
      } catch (error) {}
      var pending = nativeFetch.apply(this, arguments);
      try {
        if (KEYWORDS.test(url)) {
          var method = (init && init.method) || (input && input.method) || 'GET';
          var sent = init && typeof init.body === 'string' ? init.body.slice(0, 400) : '';
          pending.then(function (response) {
            return response.clone().text().then(function (text) {
              debug('http', { method: method, url: stripQuery(url), status: response.status, body: sent, response: text.slice(0, 400) });
            });
          }).catch(function () {});
        }
      } catch (error) {}
      return pending;
    };
  }
})();
