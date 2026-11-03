/* global CocoFrame */
/**
 * Toolbar popup.
 *
 * Reads state from the service worker, lets the user catch/dismiss the latest Coco and
 * toggles the three settings. Every value coming from the page or storage is written with
 * `textContent`, so a malicious push can never inject markup into the popup.
 */
(function () {
  'use strict';

  var CF = window.CocoFrame;
  if (!CF) return;

  var el = {
    status: document.getElementById('status'),
    latestState: document.getElementById('latest-state'),
    latestBonus: document.getElementById('latest-bonus'),
    latestMeta: document.getElementById('latest-meta'),
    latestResult: document.getElementById('latest-result'),
    claim: document.getElementById('claim'),
    dismiss: document.getElementById('dismiss'),
    clear: document.getElementById('clear'),
    history: document.getElementById('history'),
    historyCount: document.getElementById('history-count'),
    historyEmpty: document.getElementById('history-empty'),
    smidState: document.getElementById('smid-state'),
    autoClaim: document.getElementById('auto-claim'),
    overlay: document.getElementById('overlay'),
    notifications: document.getElementById('notifications'),
    keepTab: document.getElementById('keep-tab'),
    domClick: document.getElementById('dom-click'),
    trusted: document.getElementById('trusted'),
    pick: document.getElementById('pick'),
    find: document.getElementById('find'),
    clearPick: document.getElementById('clear-pick'),
    pickState: document.getElementById('pick-state'),
    pickMeta: document.getElementById('pick-meta'),
    pickResult: document.getElementById('pick-result'),
    debug: document.getElementById('debug'),
    windowState: document.getElementById('window-state'),
    nextWindow: document.getElementById('next-window')
  };

  var view = {
    settings: { autoClaim: true, notifications: true, overlay: true, keepTabReady: true, domClick: true, trustedFallback: true },
    pick: null,
    latest: null,
    lastResult: null,
    history: [],
    smid: ''
  };

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function formatTime(timestamp) {
    if (typeof timestamp !== 'number' || !isFinite(timestamp)) return '';
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (error) {
      return '';
    }
  }

  function describeBonus(offer) {
    if (!offer) return '\u2014';
    var amount = offer.totalBonus ? String(offer.totalBonus) : '';
    var currency = offer.currencyName ? String(offer.currencyName) : '';
    if (!amount && !currency) return '\u2014';
    return [amount, currency].filter(Boolean).join(' ');
  }

  function setPill(element, text, tone) {
    element.textContent = text;
    if (tone) element.setAttribute('data-tone', tone);
    else element.removeAttribute('data-tone');
  }

  function latestStatus() {
    var latest = view.latest;
    if (!latest) {
      return { text: 'none', tone: '', status: 'Watching for Coco\u2026', expired: false };
    }
    if (latest.claimed) {
      return { text: 'caught', tone: 'ok', status: 'Last Coco was caught.', expired: false };
    }
    if (latest.result) {
      return {
        text: 'failed',
        tone: 'err',
        status: 'The last claim failed.',
        expired: CF.isExpired(latest.offer)
      };
    }
    if (CF.isExpired(latest.offer)) {
      return { text: 'expired', tone: 'warn', status: 'The last Coco got away.', expired: true };
    }
    return { text: 'waiting', tone: 'warn', status: 'Coco is on screen \u2014 catch it!', expired: false };
  }

  function renderLatest() {
    var latest = view.latest;
    var info = latestStatus();
    setPill(el.latestState, info.text, info.tone);
    el.status.textContent = info.status;
    el.latestBonus.textContent = describeBonus(latest && latest.offer);

    if (!latest) {
      el.latestMeta.textContent = 'No Coco has appeared yet.';
      el.latestResult.textContent = '';
      el.latestResult.removeAttribute('data-tone');
    } else {
      var parts = [];
      if (latest.capturedAt) parts.push('captured ' + formatTime(latest.capturedAt));
      var left = CF.remainingMs(latest.offer);
      if (left !== null && !latest.claimed) {
        parts.push(left > 0 ? Math.ceil(left / 1000) + 's left' : 'expired');
      }
      if (latest.pageUrl) {
        try { parts.push(new URL(latest.pageUrl).pathname); } catch (error) { /* ignore */ }
      }
      el.latestMeta.textContent = parts.join(' \u00b7 ') || 'Coco offer captured.';

      var resultText = latest.result || (view.lastResult && view.lastResult.message) || '';
      el.latestResult.textContent = resultText;
      if (resultText && !latest.claimed) el.latestResult.setAttribute('data-tone', 'err');
      else if (resultText) el.latestResult.setAttribute('data-tone', 'ok');
      else el.latestResult.removeAttribute('data-tone');
    }

    var canClaim = Boolean(latest) && !latest.claimed && !info.expired;
    el.claim.disabled = !canClaim;
    el.dismiss.disabled = !latest;
  }

  function renderHistory() {
    el.history.textContent = '';
    var entries = Array.isArray(view.history) ? view.history.slice(0, 10) : [];
    el.historyCount.textContent = String(view.history.length || 0);
    el.historyEmpty.style.display = entries.length === 0 ? 'block' : 'none';

    entries.forEach(function (entry) {
      var li = document.createElement('li');
      var left = document.createElement('span');
      left.className = 'bonus-cell';
      left.textContent = describeBonus(entry);
      var right = document.createElement('span');
      right.className = 'time-cell';
      var status = { claimed: 'caught', clicked: 'clicked', failed: 'failed' }[entry.status] || 'missed';
      right.textContent = status + ' \u00b7 ' + formatTime(entry.capturedAt);
      li.appendChild(left);
      li.appendChild(right);
      el.history.appendChild(li);
    });
  }

  function renderSettings() {
    el.autoClaim.checked = view.settings.autoClaim !== false;
    el.keepTab.checked = view.settings.keepTabReady !== false;
    el.domClick.checked = view.settings.domClick !== false;
    el.trusted.checked = view.settings.trustedFallback !== false;
    el.overlay.checked = view.settings.overlay !== false;
    el.notifications.checked = view.settings.notifications !== false;
  }

  function renderSchedule() {
    var live = CF.inWindow(Date.now());
    setPill(el.windowState, live ? 'live' : 'idle', live ? 'ok' : '');
    var next = CF.nextWindow(Date.now());
    var minutes = Math.ceil(next.ms / 60000);
    el.nextWindow.textContent = (live ? 'Coco window is open now. ' : '') +
      'Next: ' + next.label + ' in ' + Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  function renderPick() {
    var pick = view.pick;
    setPill(el.pickState, pick ? 'picked' : 'auto', pick ? 'ok' : '');
    el.pickMeta.textContent = pick
      ? 'Saved ' + (pick.src ? 'image "' + pick.src + '"' : 'element') + ' at ' + formatTime(pick.at) + '.'
      : 'Detected automatically. If it is missed, click "Pick Coco" while Coco is on screen.';
    el.clearPick.disabled = !pick;
  }

  function render() {
    renderSettings();
    renderPick();
    renderSchedule();
    renderLatest();
    renderHistory();
    el.smidState.textContent = view.smid
      ? 'device id: captured'
      : 'device id: not captured yet';
  }

  function apply(state) {
    if (!state) return;
    if (state.settings) view.settings = state.settings;
    view.latest = state.latest || null;
    view.lastResult = state.lastResult || null;
    view.history = Array.isArray(state.history) ? state.history : [];
    view.smid = typeof state.smid === 'string' ? state.smid : '';
    view.pick = state.pick || null;
    render();
  }

  function refresh() {
    return send({ type: CF.MSG.GET_STATE }).then(function (response) {
      if (response && response.state) apply(response.state);
      return response;
    });
  }

  function readSettings() {
    return {
      autoClaim: el.autoClaim.checked,
      overlay: el.overlay.checked,
      notifications: el.notifications.checked,
      keepTabReady: el.keepTab.checked,
      domClick: el.domClick.checked,
      trustedFallback: el.trusted.checked
    };
  }

  el.claim.addEventListener('click', function () {
    el.claim.disabled = true;
    el.latestResult.textContent = 'Claiming\u2026';
    el.latestResult.removeAttribute('data-tone');
    send({ type: CF.MSG.CLAIM_REQUEST }).then(function (response) {
      if (response && response.ok) {
        // The content script posts the real result back asynchronously.
        window.setTimeout(refresh, 600);
        window.setTimeout(refresh, 1800);
        return;
      }
      el.latestResult.textContent = (response && response.message) || 'Could not reach the page.';
      el.latestResult.setAttribute('data-tone', 'err');
      refresh();
    });
  });

  var SITE_RE = CF.HOST_PATTERN;

  function showPickResult(text, tone) {
    el.pickResult.textContent = text;
    if (tone) el.pickResult.setAttribute('data-tone', tone);
    else el.pickResult.removeAttribute('data-tone');
  }

  /** The active tab, if it is a BC.Game page with the content scripts loaded. */
  function siteTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !SITE_RE.test(tab.url || '')) {
        showPickResult('Open the BC.Game tab first, then use this button.', 'err');
        return null;
      }
      return tab;
    });
  }

  function tabMessage(tab, message) {
    return chrome.tabs.sendMessage(tab.id, message).catch(function () {
      showPickResult('Coco Catcher is not loaded on this tab. Reload the page (F5).', 'err');
      return null;
    });
  }

  el.pick.addEventListener('click', function () {
    siteTab().then(function (tab) {
      if (!tab) return;
      tabMessage(tab, { type: CF.MSG.PICK_START }).then(function (response) {
        if (response) window.close(); // now click the Coco icon on the page
      });
    });
  });

  el.find.addEventListener('click', function () {
    siteTab().then(function (tab) {
      if (!tab) return;
      tabMessage(tab, { type: CF.MSG.FIND_NOW }).then(function (r) {
        if (!r) return;
        if (r.found) {
          showPickResult('Coco found (' + r.via + ') \u2014 outlined in red.', 'ok');
        } else {
          showPickResult('No Coco on screen right now (' + ((r.candidates || []).length) +
            ' floating images recorded in the debug report).', '');
        }
      });
    });
  });

  el.clearPick.addEventListener('click', function () {
    send({ type: CF.MSG.CLEAR_PICK }).then(refresh);
  });

  el.debug.addEventListener('click', function () {
    send({ type: CF.MSG.GET_DEBUG }).then(function (response) {
      var report = {
        extension: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        createdAt: new Date().toISOString(),
        state: response && response.state,
        debugLog: response && response.debugLog
      };
      return navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(function () {
        el.debug.textContent = 'Copied!';
        window.setTimeout(function () { el.debug.textContent = 'Copy debug report'; }, 1500);
      });
    }).catch(function () {
      el.debug.textContent = 'Copy failed';
    });
  });

  el.dismiss.addEventListener('click', function () {
    send({ type: CF.MSG.DISMISS }).then(refresh);
  });

  el.clear.addEventListener('click', function () {
    send({ type: CF.MSG.CLEAR_HISTORY }).then(refresh);
  });

  [el.autoClaim, el.overlay, el.notifications, el.keepTab, el.domClick, el.trusted].forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      send({ type: CF.MSG.SET_SETTINGS, settings: readSettings() }).then(function (response) {
        if (response && response.ok && response.settings) {
          view.settings = response.settings;
          renderSettings();
        }
      });
    });
  });

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      refresh();
    });
  }

  refresh();
  window.setInterval(renderSchedule, 15000);
})();
