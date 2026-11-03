/* global CocoFrame */
/**
 * ISOLATED-world content script that clicks the Coco icon on the page itself.
 *
 * Coco is drawn as a small crocodile (seasonal skins, e.g. hanging inside a Halloween
 * pumpkin) that appears at a random moment inside the daily Coco windows (see cocoTime())
 * and at a random position on the page, possibly off screen or moving. Nothing here
 * assumes a fixed spot. Clicking it makes the site run its
 * own claim, with every header and token the site normally sends, so this works even
 * when the websocket push could not be decoded (see interceptor.js / content.js).
 *
 * How the icon is found, strongest signal first:
 *   1. The element the user picked once with "Pick Coco" (selector + image URL).
 *   2. Image URLs, class names or ids containing "croc" / "coco", on a floating
 *      (fixed/absolute) element of icon size.
 *   3. Floating media (img/canvas/svg/video) added to the page within a few seconds of
 *      a Coco websocket push.
 *
 * After the click it presses any claim button in the dialog that opens, re-clicks if the
 * icon is still there, and finally asks the worker for a real (debugger) mouse click.
 */
(function () {
  'use strict';
  var CF = window.CocoFrame;
  if (!CF || window.__cocoDomCatcher) return;
  window.__cocoDomCatcher = true;

  var SCAN_INTERVAL = 700;
  var PUSH_WINDOW = 8000; // how long after a push new floating media counts as Coco
  var API_GRACE = 2500; // let the direct API claim (content.js) go first after a push
  var WINDOW_MARGIN_MIN = 2; // small allowance for a PC clock that is slightly off
  var CLAIM_WAIT = 6000;
  var RECLICK_AFTER = 1500;
  var AFTER_GONE_WAIT = 3000;
  var MAX_SYNTHETIC = 2;
  var MAX_TRIES = 4;
  var MIN_PX = 20;
  var MAX_PX = 420;
  var OWN_UI = '#coco-catcher-bubble, #coco-catcher-pick-banner';
  var MEDIA = 'img, canvas, svg, video, picture';
  var CLAIM_TEXT = /^\s*(claim|receive|collect|catch|grab|open|get|take)\b/i;
  var RESULT_TEXT = /congratulat|you (have )?won|winning|received|claimed/i;
  var DIALOG = '[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="popup" i], [class*="toast" i]';
  var KEYWORD_QUERY = [
    'img[src*="croc" i]', 'img[src*="coco" i]', 'img[srcset*="croc" i]', 'img[srcset*="coco" i]',
    'source[srcset*="croc" i]', 'source[srcset*="coco" i]', 'image[href*="croc" i]', 'image[href*="coco" i]',
    '[class*="croc" i]', '[class*="coco" i]', '[id*="croc" i]', '[id*="coco" i]',
    '[style*="croc" i]', '[style*="coco" i]'
  ].join(',');

  var settings = { domClick: true, trustedFallback: true, autoClaim: true };
  var pick = null;
  var recentAdded = [];
  var tries = new WeakMap();
  // Elements handled recently. A cooldown, not a permanent block: the site may reuse the
  // same node for the next Coco.
  var cooldown = new WeakMap();
  var COOLDOWN_MS = 90000;
  var busy = false;
  var picking = false;

  function send(message, callback) {
    try {
      chrome.runtime.sendMessage(message, function (response) {
        void chrome.runtime.lastError;
        if (typeof callback === 'function') callback(response);
      });
    } catch (error) {
      /* extension was reloaded; this page needs a reload too */
    }
  }

  function debug(kind, detail) {
    send({ type: CF.MSG.DEBUG_EVENT, entry: { kind: kind, detail: detail, page: location.pathname } });
  }

  function applyState(state) {
    if (!state) return;
    var s = state.settings || {};
    settings = {
      domClick: s.domClick !== false,
      trustedFallback: s.trustedFallback !== false,
      autoClaim: s.autoClaim !== false
    };
    if ('pick' in state) pick = state.pick || null;
  }

  send({ type: CF.MSG.GET_STATE }, function (response) {
    if (response && response.state) applyState(response.state);
  });

  /* ---------------- geometry / style helpers ---------------- */

  function sleep(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  /**
   * Wait for the next DOM change or `ms`, whichever comes first. In a background tab
   * Chrome can delay timers by up to a minute (longer than Coco stays), but DOM
   * mutations are still delivered immediately, so dialogs and results are not missed.
   */
  function waitForChange(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var observer = null;
      var timer = 0;
      var finish = function () {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        window.clearTimeout(timer);
        resolve();
      };
      observer = new MutationObserver(finish);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      timer = window.setTimeout(finish, ms);
    });
  }

  function rectOf(el) {
    try { return el.getBoundingClientRect(); } catch (error) { return null; }
  }

  /**
   * Rendered (has a size, not hidden). Deliberately NOT limited to the viewport: Coco shows
   * up at a random position, possibly below the fold or partly off-screen; centerOf()
   * scrolls it into view before clicking.
   */
  function isVisible(el, minPx) {
    if (!el || !el.isConnected) return false;
    var r = rectOf(el);
    var min = typeof minPx === 'number' ? minPx : MIN_PX;
    if (!r || r.width < min || r.height < min) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  }

  function iconSized(el) {
    var r = rectOf(el);
    return Boolean(r) && r.width <= MAX_PX && r.height <= MAX_PX;
  }

  /**
   * Coco is laid over the page at a random spot: it or a close ancestor is positioned
   * (fixed/absolute/sticky), or moved/animated with a CSS transform or animation.
   */
  function isFloating(el) {
    for (var n = el, depth = 0; n && n.nodeType === 1 && depth < 8; n = n.parentElement, depth += 1) {
      var cs = getComputedStyle(n);
      if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') return true;
      if (depth < 3 && (cs.transform !== 'none' || (cs.animationName && cs.animationName !== 'none'))) return true;
    }
    return false;
  }

  function classOf(el) {
    var c = el.getAttribute && el.getAttribute('class');
    return typeof c === 'string' ? c : '';
  }

  function backgroundUrl(el) {
    try {
      var bg = getComputedStyle(el).backgroundImage || '';
      var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      return m ? m[1] : '';
    } catch (error) {
      return '';
    }
  }

  function mediaUrl(el) {
    if (!el) return '';
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'img') return el.currentSrc || el.src || '';
    if (tag === 'image') return el.getAttribute('href') || el.getAttribute('xlink:href') || '';
    if (tag === 'video') return el.currentSrc || el.src || '';
    var inner = el.querySelector && el.querySelector('img');
    if (inner) return inner.currentSrc || inner.src || '';
    return backgroundUrl(el);
  }

  function describe(el) {
    if (!el || !el.tagName) return null;
    var r = rectOf(el) || { left: 0, top: 0, width: 0, height: 0 };
    var parent = el.parentElement;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: classOf(el).slice(0, 160),
      src: mediaUrl(el).slice(0, 240),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      position: getComputedStyle(el).position,
      parentCls: parent ? classOf(parent).slice(0, 120) : '',
      selector: cssPath(el)
    };
  }

  function cssPath(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.body && parts.length < 6; n = n.parentElement) {
      if (n.id && !/\d{4,}/.test(n.id)) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      var part = n.tagName.toLowerCase();
      var cls = classOf(n).split(/\s+/).filter(function (c) {
        return c && c.length < 40 && !/^(hover|active|focus|animate|show|hide)/i.test(c);
      }).slice(0, 3);
      if (cls.length) part += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
      parts.unshift(part);
      try {
        if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      } catch (error) {
        /* keep climbing */
      }
    }
    return parts.join(' > ');
  }

  /* ---------------- finding Coco ---------------- */

  function isOwnUi(el) {
    return Boolean(el.closest && el.closest(OWN_UI));
  }

  /** A real navigation link (e.g. a "Coco" promo entry in a menu) is never the bonus icon. */
  function isNavLink(el) {
    var a = el.closest && el.closest('a[href]');
    return Boolean(a) && !/^(#|javascript:)/i.test(a.getAttribute('href') || '');
  }

  /** `<source>` and tiny wrappers resolve to the element a user would actually see. */
  function normalize(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName.toLowerCase() === 'source') {
      var pic = el.closest('picture');
      return pic ? (pic.querySelector('img') || pic) : null;
    }
    return el;
  }

  function coolingDown(el) {
    var until = cooldown.get(el);
    if (!until) return false;
    if (Date.now() < until) return true;
    cooldown.delete(el);
    tries.delete(el);
    return false;
  }

  function acceptable(el, requireFloating) {
    if (!el || isOwnUi(el) || coolingDown(el)) return false;
    if (!isVisible(el) || !iconSized(el) || isNavLink(el)) return false;
    if (requireFloating && !isFloating(el)) return false;
    return true;
  }

  function fromPick() {
    if (!pick) return null;
    if (pick.selector) {
      try {
        var list = document.querySelectorAll(pick.selector);
        for (var i = 0; i < list.length; i += 1) {
          if (acceptable(list[i], false)) return list[i];
        }
      } catch (error) {
        /* stale selector; fall through to the image URL */
      }
    }
    if (pick.src) {
      var media = document.querySelectorAll(MEDIA + ', [style*="url("]');
      for (var j = 0; j < media.length; j += 1) {
        var url = mediaUrl(media[j]);
        if (url && url.indexOf(pick.src) >= 0 && acceptable(media[j], false)) return media[j];
      }
    }
    return null;
  }

  function fromKeywords() {
    var list = document.querySelectorAll(KEYWORD_QUERY);
    for (var i = 0; i < list.length; i += 1) {
      var el = normalize(list[i]);
      if (acceptable(el, true)) return el;
    }
    return null;
  }

  function looksLikeIcon(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return null;
    var tag = el.tagName.toLowerCase();
    var media = /^(img|canvas|svg|video|picture)$/.test(tag) || backgroundUrl(el)
      ? el
      : el.querySelector && el.querySelector(MEDIA);
    if (!media) return null;
    var target = iconSized(el) ? el : media;
    return acceptable(target, true) ? target : null;
  }

  function fromRecentPush() {
    if (Date.now() - lastPushAt() > PUSH_WINDOW) {
      recentAdded = [];
      return null;
    }
    for (var i = recentAdded.length - 1; i >= 0; i -= 1) {
      var el = looksLikeIcon(recentAdded[i]);
      if (el) return el;
    }
    return null;
  }

  function findCoco() {
    var el = fromPick();
    if (el) return { el: el, via: 'pick' };
    el = fromKeywords();
    if (el) return { el: el, via: 'keyword' };
    el = fromRecentPush();
    if (el) return { el: el, via: 'push' };
    return null;
  }

  /** Floating, icon-sized media on screen: a snapshot that shows what Coco looks like in the DOM. */
  function snapshotCandidates() {
    var out = [];
    var list = document.querySelectorAll(MEDIA + ', [style*="url("]');
    for (var i = 0; i < list.length && out.length < 25; i += 1) {
      var el = list[i];
      if (isOwnUi(el) || !isVisible(el) || !iconSized(el) || !isFloating(el)) continue;
      out.push(describe(el));
    }
    return out;
  }

  /* ---------------- clicking ---------------- */

  /** Centre of `el` in viewport coordinates, scrolling it on screen first if needed. */
  function centerOf(el) {
    var r = rectOf(el);
    if (!r) return null;
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      // 'instant': a smooth scroll would leave the measured point stale.
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = rectOf(el);
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    return {
      x: Math.min(Math.max(x, 1), window.innerWidth - 1),
      y: Math.min(Math.max(y, 1), window.innerHeight - 1)
    };
  }

  /** The element a real click at the icon's centre would land on. */
  function hitTarget(el, point) {
    var hit = document.elementFromPoint(point.x, point.y);
    if (!hit || isOwnUi(hit)) return el;
    if (hit === el || el.contains(hit) || hit.contains(el)) return hit;
    return el;
  }

  function syntheticClick(el, point) {
    var target = hitTarget(el, point);
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
    };
    var up = Object.assign({}, base, { buttons: 0 });
    target.dispatchEvent(new PointerEvent('pointerover', base));
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new PointerEvent('pointerdown', base));
    target.dispatchEvent(new MouseEvent('mousedown', base));
    target.dispatchEvent(new PointerEvent('pointerup', up));
    target.dispatchEvent(new MouseEvent('mouseup', up));
    target.dispatchEvent(new MouseEvent('click', up));
  }

  /**
   * Real mouse click at `el`'s current centre. Measured at the last moment because Coco
   * can move, and our own bubble is hidden meanwhile in case Coco sits underneath it.
   */
  function trustedClick(el) {
    var own = document.querySelectorAll(OWN_UI);
    own.forEach(function (node) { node.style.visibility = 'hidden'; });
    var point = centerOf(el);
    return new Promise(function (resolve) {
      send({ type: CF.MSG.TRUSTED_CLICK, x: point.x, y: point.y }, function (response) {
        own.forEach(function (node) { node.style.visibility = ''; });
        resolve(Boolean(response && response.ok));
      });
    });
  }

  function findClaimButton() {
    var dialogs = document.querySelectorAll(DIALOG);
    for (var i = 0; i < dialogs.length; i += 1) {
      if (isOwnUi(dialogs[i]) || !isVisible(dialogs[i])) continue;
      var buttons = dialogs[i].querySelectorAll('button, [role="button"]');
      for (var j = 0; j < buttons.length; j += 1) {
        var b = buttons[j];
        if (!b.disabled && isVisible(b, 4) && CLAIM_TEXT.test(b.innerText || b.textContent || '')) return b;
      }
    }
    return null;
  }

  /** Result dialogs/toasts already on screen, so a stale message is not taken as this catch. */
  function resultDialogs() {
    var out = [];
    document.querySelectorAll(DIALOG).forEach(function (d) {
      if (!isOwnUi(d) && RESULT_TEXT.test(d.textContent || '')) out.push(d);
    });
    return out;
  }

  function findResultText(stale) {
    var dialogs = document.querySelectorAll(DIALOG);
    for (var i = 0; i < dialogs.length; i += 1) {
      if (isOwnUi(dialogs[i]) || (stale && stale.indexOf(dialogs[i]) >= 0)) continue;
      var text = (dialogs[i].innerText || dialogs[i].textContent || '').trim();
      if (text && text.length < 300 && RESULT_TEXT.test(text) && isVisible(dialogs[i])) {
        return text.replace(/\s+/g, ' ');
      }
    }
    return '';
  }

  function report(kind, info, el) {
    send({ type: CF.MSG.DOM_EVENT, kind: kind, message: info || '', element: describe(el) });
  }

  /** Click Coco, press any claim button, and escalate to a real mouse click if needed. */
  function catchCoco(el, via) {
    busy = true;
    var count = (tries.get(el) || 0) + 1;
    tries.set(el, count);
    report('found', 'Coco found (' + via + ')', el);

    var stale = resultDialogs();
    var useTrusted = settings.trustedFallback && count > MAX_SYNTHETIC;
    var clicked = useTrusted ? trustedClick(el) : Promise.resolve(syntheticClick(el, centerOf(el)) || true);

    return clicked.then(function () {
      var start = Date.now();
      var goneAt = 0;
      var pressed = null; // { button, at, trusted }
      var loop = function () {
        var now = Date.now();
        var result = findResultText(stale);
        if (result) return { done: true, message: result };

        // The site may open a dialog with a Claim button after the icon is clicked.
        if (!pressed) {
          var button = findClaimButton();
          if (button) {
            pressed = { button: button, at: now, trusted: false };
            syntheticClick(button, centerOf(button));
          }
        } else if (!pressed.trusted && settings.trustedFallback && isVisible(pressed.button, 4) &&
            now - pressed.at > RECLICK_AFTER) {
          pressed.trusted = true;
          trustedClick(pressed.button);
        }

        if (!goneAt && !isVisible(el)) goneAt = now;
        // Icon gone: keep watching briefly for the claim dialog / result message.
        if (goneAt && now - goneAt > AFTER_GONE_WAIT) return { done: true, message: '' };
        // Icon still there and no dialog: the click was ignored, try again.
        if (!goneAt && !pressed && now - start > RECLICK_AFTER) return { done: false };
        if (now - start > CLAIM_WAIT) return { done: Boolean(goneAt || pressed), message: '' };
        return waitForChange(250).then(loop);
      };
      return loop();
    }).then(function (outcome) {
      if (outcome.done) {
        report('clicked', outcome.message || 'Coco clicked (' + (useTrusted ? 'real click' : 'click') + ')', el);
        cooldown.set(el, Date.now() + COOLDOWN_MS);
      } else if (count >= MAX_TRIES || (count > MAX_SYNTHETIC && !settings.trustedFallback)) {
        cooldown.set(el, Date.now() + COOLDOWN_MS);
        report('gave-up', 'Coco did not react to ' + count + ' clicks', el);
      }
    }).catch(function (error) {
      report('error', String((error && error.message) || error), el);
    }).then(function () {
      busy = false;
    });
  }

  /**
   * Coco only appears at a random moment inside the four daily windows (GMT+9):
   * 04:45-05:15, 10:45-11:15, 16:45-17:15, 22:45-23:15. Outside them the page is not
   * scanned, so nothing that merely looks like Coco gets clicked. A decoded Coco push
   * proves Coco is on screen and overrides the schedule.
   */
  function cocoTime() {
    return CF.inWindow(Date.now(), WINDOW_MARGIN_MIN) || Date.now() - lastPushAt() < PUSH_WINDOW;
  }

  function scan() {
    if (busy || picking || !settings.domClick || !cocoTime()) return;
    // After a push, give the direct API claim (content.js) a moment to finish first.
    if (settings.autoClaim && Date.now() - lastPushAt() < API_GRACE) return;
    if (window.__cocoApiClaimedAt && Date.now() - window.__cocoApiClaimedAt < 20000) return;
    var found = findCoco();
    if (found) catchCoco(found.el, found.via);
  }

  /* ---------------- wiring ---------------- */

  /** Set by content.js (same ISOLATED world) when a Coco websocket push is decoded. */
  function lastPushAt() {
    return window.__cocoLastPushAt || 0;
  }

  var scheduled = false;
  var lastScan = 0;
  function observe() {
    new MutationObserver(function (mutations) {
      if (Date.now() - lastPushAt() < PUSH_WINDOW) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType === 1 && !isOwnUi(node)) recentAdded.push(node);
          });
        });
        if (recentAdded.length > 80) recentAdded = recentAdded.slice(-80);
      }
      // Scan right here (timers can be throttled in background tabs); a trailing timer
      // covers the end of a burst of changes.
      var now = Date.now();
      if (now - lastScan >= 150) {
        lastScan = now;
        scan();
      } else if (!scheduled) {
        scheduled = true;
        window.setTimeout(function () { scheduled = false; lastScan = Date.now(); scan(); }, 150);
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src']
    });
    window.setInterval(scan, SCAN_INTERVAL);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== CF.CHANNEL) return;
    if (data.type === 'debug' && data.entry) {
      send({ type: CF.MSG.DEBUG_EVENT, entry: data.entry });
    }
  });

  /* ---------------- picker ---------------- */

  function startPicker() {
    if (picking) return;
    picking = true;
    var hovered = null;
    var banner = document.createElement('div');
    banner.id = 'coco-catcher-pick-banner';
    banner.textContent = 'Coco Catcher: click the Coco icon (Esc to cancel)';
    banner.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#16a34a;color:#fff;font:600 14px system-ui,sans-serif;padding:8px 14px;border-radius:8px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:none';
    document.documentElement.appendChild(banner);

    function outline(el, on) {
      if (!el || !el.style) return;
      if (on) {
        el.__cocoOutline = el.style.outline;
        el.style.outline = '3px dashed #f59e0b';
      } else {
        el.style.outline = el.__cocoOutline || '';
      }
    }
    function swallow(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
    function over(e) {
      if (hovered) outline(hovered, false);
      hovered = e.target;
      outline(hovered, true);
    }
    function stop() {
      if (hovered) outline(hovered, false);
      banner.remove();
      document.removeEventListener('mouseover', over, true);
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
        document.removeEventListener(t, swallow, true);
      });
      document.removeEventListener('click', choose, true);
      document.removeEventListener('keydown', key, true);
      window.clearTimeout(timer);
      picking = false;
    }
    function choose(e) {
      swallow(e);
      var el = e.target;
      stop();
      // Prefer the element that carries the image, so the URL can be matched later.
      var media = /^(img|canvas|svg|video)$/i.test(el.tagName) ? el : (el.querySelector && el.querySelector('img, canvas')) || el;
      var url = mediaUrl(media) || mediaUrl(el);
      var file = '';
      try { file = url ? new URL(url, location.href).pathname.split('/').pop() : ''; } catch (error) { file = ''; }
      // Hashed build names (coco-a1b2c3.png) change between deploys; keep the stable stem.
      var stem = file.replace(/[-_.][0-9a-f]{6,}(?=\.)/i, '').replace(/\.[a-z0-9]+$/i, '');
      var saved = { selector: cssPath(el), src: stem || '', element: describe(el), at: Date.now() };
      pick = saved;
      send({ type: CF.MSG.PICK_SAVED, pick: saved });
      // The user's click was swallowed: catch this Coco now.
      tries.delete(el);
      cooldown.delete(el);
      catchCoco(el, 'pick');
    }
    function key(e) {
      if (e.key === 'Escape') stop();
    }
    document.addEventListener('mouseover', over, true);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
      document.addEventListener(t, swallow, true);
    });
    document.addEventListener('click', choose, true);
    document.addEventListener('keydown', key, true);
    var timer = window.setTimeout(stop, 120000);
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === CF.MSG.STATE_UPDATED) {
      applyState({ settings: message.settings, pick: message.pick });
    } else if (message.type === CF.MSG.PICK_START) {
      startPicker();
      sendResponse({ ok: true });
    } else if (message.type === CF.MSG.FIND_NOW) {
      var found = findCoco();
      var info = { found: Boolean(found), via: found ? found.via : '', element: found ? describe(found.el) : null };
      if (found) {
        var el = found.el;
        var prev = el.style.outline;
        el.style.outline = '3px solid #ef4444';
        window.setTimeout(function () { el.style.outline = prev; }, 3000);
      } else {
        info.candidates = snapshotCandidates();
      }
      debug('find-now', info);
      sendResponse(info);
    }
    return undefined;
  });

  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });
})();
