/* global CocoFrame */
/**
 * ISOLATED-world content script.
 *
 * Receives the Coco offer that `interceptor.js` republished from the page's websocket,
 * renders a clickable Coco bubble and performs the claim with a same-origin request:
 *
 *   POST /api/game/support/bonus/crocodile/  { currencyName, dataSign }
 *
 * which is exactly what the site itself does (traffic.log lines 19580-19587). Running the
 * request here keeps the page cookies, Referer and browser-managed client hints intact.
 */
(function () {
  'use strict';
  var CF = window.CocoFrame;
  if (!CF || window.__cocoCatcherContent) return;
  window.__cocoCatcherContent = true;

  var DEFAULT_TTL = 60 * 1000;
  var MAX_SANE_TTL = 10 * 60 * 1000;

  var runtime = {
    settings: { autoClaim: true, notifications: true, overlay: true },
    smid: '',
    active: null,
    deadline: 0,
    ticker: null,
    claiming: false,
    seen: Object.create(null),
    claimed: Object.create(null),
    host: null,
    refs: null
  };

  function reportError(error) {
    try { console.warn('[coco-catcher]', error); } catch (ignored) {}
  }

  function send(message, callback) {
    try {
      chrome.runtime.sendMessage(message, function (response) {
        void chrome.runtime.lastError;
        if (typeof callback === 'function') callback(response);
      });
    } catch (error) {
      reportError(error);
    }
  }

  function mergeSettings(value) {
    return {
      autoClaim: value.autoClaim !== false,
      notifications: value.notifications !== false,
      overlay: value.overlay !== false
    };
  }

  // Resolves once the saved settings are loaded, so an early push cannot be auto-claimed
  // (or skipped) based on the defaults instead of the user's choice.
  var settingsReady = new Promise(function (resolve) {
    runtime.resolveSettings = resolve;
  });

  function loadState() {
    send({ type: CF.MSG.GET_STATE }, function (response) {
      if (response && response.state) {
        if (response.state.settings) runtime.settings = mergeSettings(response.state.settings);
        if (response.state.smid) runtime.smid = response.state.smid;
      }
      runtime.resolveSettings();
    });
    // Never block forever if the service worker is slow to answer.
    window.setTimeout(runtime.resolveSettings, 3000);
  }

  function ttlFor(offer) {
    var left = CF.remainingMs(offer);
    if (left === null) return DEFAULT_TTL;
    if (left <= 0 || left > MAX_SANE_TTL) return DEFAULT_TTL;
    return left;
  }

  function handleSmid(value) {
    if (typeof value !== 'string' || !value) return;
    runtime.smid = value;
    send({ type: CF.MSG.SMID_CAPTURED, smid: value });
  }

  function isPlausibleOffer(offer) {
    if (!offer || typeof offer !== 'object') return false;
    if (typeof offer.dataSign !== 'string') return false;
    if (offer.dataSign.length < 16 || offer.dataSign.length > 256) return false;
    if (offer.currencyName !== undefined && typeof offer.currencyName !== 'string') return false;
    return true;
  }

  function handleOffer(offer) {
    if (!isPlausibleOffer(offer) || runtime.seen[offer.dataSign]) return;
    runtime.seen[offer.dataSign] = true;
    var ttl = ttlFor(offer);
    if (typeof offer.localDeadline !== 'number') {
      offer = Object.assign({}, offer, { localDeadline: Date.now() + ttl });
    }
    runtime.active = offer;
    runtime.deadline = Date.now() + ttl;
    runtime.claiming = false;

    send({
      type: CF.MSG.OFFER_CAPTURED,
      offer: offer,
      hidden: Boolean(document.hidden),
      pageUrl: location.href
    });

    settingsReady.then(function () {
      if (runtime.settings.overlay) showBubble(offer, ttl);
      // Claim straight away: a setTimeout here can be throttled for up to a minute in a
      // background tab, which is longer than the Coco offer lives.
      if (runtime.settings.autoClaim) claim(offer, true);
    });
  }

  var BUBBLE_ID = 'coco-catcher-bubble';
  var STYLE_ID = 'coco-catcher-style';

  var CSS_TEXT = [
    '#' + BUBBLE_ID + '{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:12px;padding:10px 30px 12px 10px;border-radius:999px;background:linear-gradient(135deg,#0f172a,#1e293b);color:#f8fafc;font:600 14px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 0 1px rgba(148,163,184,.25);cursor:pointer;user-select:none;overflow:hidden;transition:transform .18s ease,opacity .18s ease}',
    '#' + BUBBLE_ID + ':hover{transform:translateY(-2px)}',
    '#' + BUBBLE_ID + ' .cc-croc{flex:0 0 auto;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;background:radial-gradient(circle at 30% 25%,#4ade80,#15803d);animation:cc-pulse 1.6s infinite}',
    '@keyframes cc-pulse{0%{box-shadow:0 0 0 0 rgba(74,222,128,.65)}70%{box-shadow:0 0 0 14px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}',
    '#' + BUBBLE_ID + ' .cc-text{display:flex;flex-direction:column;gap:2px;min-width:92px}',
    '#' + BUBBLE_ID + ' .cc-title{font-size:13px;letter-spacing:.2px}',
    '#' + BUBBLE_ID + ' .cc-count{font-size:12px;font-weight:500;color:#94a3b8}',
    '#' + BUBBLE_ID + ' .cc-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:rgba(148,163,184,.2)}',
    '#' + BUBBLE_ID + ' .cc-bar i{display:block;height:100%;width:100%;background:#4ade80;transition:width .25s linear}',
    '#' + BUBBLE_ID + ' .cc-close{position:absolute;top:2px;right:6px;border:0;background:transparent;color:#94a3b8;font:400 16px/1 system-ui,sans-serif;cursor:pointer;padding:2px 4px}',
    '#' + BUBBLE_ID + '.cc-claiming .cc-croc{animation:cc-pulse 1.6s infinite,cc-spin 1s linear infinite}',
    '@keyframes cc-spin{to{transform:rotate(360deg)}}',
    '#' + BUBBLE_ID + '.cc-success{background:linear-gradient(135deg,#052e16,#166534)}',
    '#' + BUBBLE_ID + '.cc-error{background:linear-gradient(135deg,#450a0a,#991b1b)}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBubble() {
    if (runtime.refs) return runtime.refs;
    var root = document.createElement('div');
    root.id = BUBBLE_ID;
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', 'Catch Coco');

    var croc = document.createElement('div');
    croc.className = 'cc-croc';
    croc.textContent = '\uD83D\uDC0A';

    var text = document.createElement('div');
    text.className = 'cc-text';
    var title = document.createElement('span');
    title.className = 'cc-title';
    title.textContent = 'Catch Coco!';
    var count = document.createElement('span');
    count.className = 'cc-count';
    count.textContent = '60s';
    text.appendChild(title);
    text.appendChild(count);

    var bar = document.createElement('div');
    bar.className = 'cc-bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'cc-close';
    close.setAttribute('aria-label', 'Dismiss Coco');
    close.textContent = '\u00D7';

    root.appendChild(croc);
    root.appendChild(text);
    root.appendChild(bar);
    root.appendChild(close);

    runtime.refs = { root: root, croc: croc, title: title, count: count, bar: fill, close: close };
    return runtime.refs;
  }

  function stopTicker() {
    if (runtime.ticker !== null) {
      window.clearInterval(runtime.ticker);
      runtime.ticker = null;
    }
  }

  function startTicker() {
    stopTicker();
    runtime.ticker = window.setInterval(function () {
      if (!runtime.refs) { stopTicker(); return; }
      var left = runtime.deadline - Date.now();
      if (left <= 0) {
        stopTicker();
        runtime.active = null;
        removeBubble();
        return;
      }
      var total = runtime.ttl > 0 ? runtime.ttl : DEFAULT_TTL;
      runtime.refs.count.textContent = Math.ceil(left / 1000) + 's';
      runtime.refs.bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    }, 250);
  }

  function setBubbleState(state, text) {
    var refs = runtime.refs;
    if (!refs) return;
    refs.root.classList.remove('cc-claiming', 'cc-success', 'cc-error');
    if (state === 'claiming' || state === 'success' || state === 'error') {
      refs.root.classList.add('cc-' + state);
    }
    if (typeof text === 'string') refs.count.textContent = text;
  }

  function removeBubble() {
    stopTicker();
    if (!runtime.refs) return;
    runtime.refs.root.style.display = 'none';
  }

  function showBubble(offer, ttl) {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', function () { showBubble(offer, ttl); }, { once: true });
      return;
    }
    injectStyles();
    var refs = ensureBubble();
    runtime.ttl = ttl > 0 ? ttl : DEFAULT_TTL;
    runtime.deadline = Date.now() + runtime.ttl;
    refs.root.classList.remove('cc-claiming', 'cc-success', 'cc-error');
    refs.root.style.display = 'flex';
    refs.count.textContent = Math.ceil(runtime.ttl / 1000) + 's';
    refs.bar.style.width = '100%';
    if (!refs.root.parentNode) (document.body || document.documentElement).appendChild(refs.root);
    refs.root.onclick = function (event) {
      if (event.target === refs.close) return;
      claim(offer, false);
    };
    refs.close.onclick = function (event) {
      event.stopPropagation();
      removeBubble();
    };
    refs.root.onkeydown = function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        claim(offer, false);
      }
    };
    runtime.host = refs.root;
    startTicker();
    try { refs.root.focus({ preventScroll: true }); } catch (error) { reportError(error); }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin && event.origin !== location.origin) return;
    var data = event.data;
    if (!data || data.source !== CF.CHANNEL) return;
    if (data.type === 'frame') handleFrame(data.data, data.receivedAt);
    else if (data.type === 'smid' && data.value && isSiteUrl(data.url)) handleSmid(data.value);
  });

  /** Relative URLs and BC.Game hosts only: never pick up a header meant for a third party. */
  function isSiteUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
    return CF.HOST_PATTERN.test(url);
  }

  function debug(kind, detail) {
    send({ type: CF.MSG.DEBUG_EVENT, entry: { kind: kind, detail: detail, page: location.pathname } });
  }

  /** A websocket frame forwarded by interceptor.js because it mentions Coco. */
  function handleFrame(data, receivedAt) {
    var parsed = CF.parseFrame(data);
    if (!parsed) {
      debug('ws-unparsed', typeof data === 'string'
        ? data.slice(0, 1500)
        : { base64: toBase64(CF.toBytes(data) || new Uint8Array(0), 1500) });
      return;
    }
    var offer = CF.normalizeOffer(parsed.payload);
    if (!offer) {
      debug('ws-offer-unsigned', parsed.payload);
      return;
    }
    if (runtime.seen[offer.dataSign]) return;
    debug('ws-offer', { currencyName: offer.currencyName, totalBonus: offer.totalBonus, limitLevel: offer.limitLevel });
    // Read by dom-catcher.js: Coco is about to be drawn on the page.
    window.__cocoLastPushAt = Date.now();
    handleOffer(CF.withLocalDeadline(offer, typeof receivedAt === 'number' ? receivedAt : Date.now()));
  }

  function toBase64(bytes, limit) {
    var n = Math.min(bytes.length, limit);
    var bin = '';
    for (var i = 0; i < n; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function resetClaimState() {
    runtime.claiming = false;
    runtime.pendingClaim = null;
  }

  function finishClaim(result, offer, automatic) {
    resetClaimState();
    var ok = Boolean(result && result.ok);
    if (ok) {
      runtime.claimed[offer.dataSign] = true;
      // Read by dom-catcher.js so it does not also click a Coco that is already claimed.
      window.__cocoApiClaimedAt = Date.now();
      setBubbleState('success', result.message || 'Caught!');
      window.setTimeout(removeBubble, 2600);
    } else {
      setBubbleState('error', (result && result.message) || 'Claim failed');
      window.setTimeout(function () {
        if (!runtime.refs || !runtime.active) return;
        var left = Math.max(0, runtime.deadline - Date.now());
        setBubbleState('idle', Math.ceil(left / 1000) + 's');
      }, 2600);
    }
    send({
      type: CF.MSG.CLAIM_RESULT,
      ok: ok,
      message: (result && result.message) || '',
      offer: offer,
      automatic: Boolean(automatic)
    });
  }

  var MAX_ATTEMPTS = 3;
  var RETRY_DELAY = 700;

  function sleep(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  /**
   * POST the claim. Retries network errors, HTTP 429 and 5xx only; any answer with a JSON
   * body is the server's decision (claimed, already claimed, not eligible) and is final.
   */
  function postClaim(headers, body, attemptsLeft) {
    return fetch(CF.CLAIM_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (error) { data = null; }
        }
        return { status: response.status, data: data };
      });
    }).then(function (result) {
      var transient = !result.data && (result.status === 429 || result.status >= 500);
      if (transient && attemptsLeft > 1) {
        return sleep(RETRY_DELAY).then(function () { return postClaim(headers, body, attemptsLeft - 1); });
      }
      return result;
    }, function (error) {
      if (attemptsLeft > 1) {
        return sleep(RETRY_DELAY).then(function () { return postClaim(headers, body, attemptsLeft - 1); });
      }
      throw error;
    });
  }

  function claim(offer, automatic) {
    if (!offer || !offer.dataSign) return Promise.resolve({ ok: false, message: 'Missing offer.' });
    if (runtime.claimed[offer.dataSign]) return Promise.resolve({ ok: true, message: 'Already caught.' });
    if (runtime.claiming) return runtime.pendingClaim || Promise.resolve({ ok: false, message: 'Claim in progress.' });
    if (CF.isExpired(offer)) return Promise.resolve({ ok: false, message: 'Offer expired.' });

    var body = CF.buildClaimBody(offer);
    if (!body) return Promise.resolve({ ok: false, message: 'Missing dataSign.' });

    runtime.claiming = true;
    setBubbleState('claiming', automatic ? 'Auto-catching…' : 'Claiming…');

    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*'
    };
    if (runtime.smid) headers.smid = runtime.smid;

    runtime.pendingClaim = postClaim(headers, body, MAX_ATTEMPTS).then(function (result) {
      var data = result.data;
      var ok = Boolean(data && data.code === 0);
      var message = ok
        ? (typeof data.data === 'string' && data.data ? data.data : 'Coco caught!')
        : ((data && (data.msg || data.message)) || ('Request failed (HTTP ' + result.status + ')'));
      var payload = { ok: ok, message: message };
      finishClaim(payload, offer, automatic);
      return payload;
    }).catch(function (error) {
      var payload = { ok: false, message: (error && error.message) || 'Network error' };
      finishClaim(payload, offer, automatic);
      return payload;
    });

    return runtime.pendingClaim;
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === CF.MSG.PING) {
      // The interceptor only hooks sockets opened after it loaded, so the worker reloads
      // tabs that were open before the extension was (re)loaded.
      sendResponse({ ok: true, hooked: Boolean(document.documentElement.dataset.cocoHooked) });
      return undefined;
    }
    if (message.type === CF.MSG.POPUP_CLAIM) {
      if (!runtime.active) {
        sendResponse({ ok: false, message: 'No Coco offer on this page.' });
        return undefined;
      }
      if (!runtime.host) showBubble(runtime.active, Math.max(0, runtime.deadline - Date.now()));
      claim(runtime.active, false);
      sendResponse({ ok: true, pending: true });
      return undefined;
    }
    if (message.type === CF.MSG.STATE_UPDATED && message.settings) {
      runtime.settings = mergeSettings(message.settings);
    }
    return undefined;
  });

  loadState();
})();
