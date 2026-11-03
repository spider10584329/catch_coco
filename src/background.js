/* global CocoFrame, importScripts */
/**
 * MV3 service worker.
 *
 * Owns the extension state (settings, captured `smid`, the latest Coco offer and a short
 * history), raises the desktop notification and the toolbar badge, and relays the popup's
 * "Claim now" action to the tab that actually saw the push, because the claim request has
 * to run same-origin with the page (see `content.js`).
 */
importScripts('shared/coco-frame.js');

var CF = self.CocoFrame;
var STORAGE = {
  settings: 'settings',
  smid: 'smid',
  latest: 'latest',
  lastResult: 'lastResult',
  history: 'history',
  pick: 'pick',
  debugLog: 'debugLog',
  siteOrigin: 'siteOrigin'
};
var DEFAULT_SETTINGS = {
  autoClaim: true,
  notifications: true,
  overlay: true,
  keepTabReady: true,
  domClick: true,
  trustedFallback: true
};
var DEBUG_LIMIT = 80;
/** Opened when no BC.Game tab exists and the user has not visited a mirror yet. */
var DEFAULT_SITE_URL = 'https://bc.game/';
var SITE_TABS = ['bc.game', 'bc.co', 'bcgame.ai', 'bcgame.com'].reduce(function (list, host) {
  return list.concat(['https://' + host + '/*', 'https://*.' + host + '/*']);
}, []);
/** Get the tab ready this many minutes before each Coco window. */
var PREPARE_MIN = 5;
var ALARM_PREFIX = 'coco-window-';
var HISTORY_LIMIT = 25;
var BADGE_COLOR = '#16a34a';
var OFFER_NOTIFICATION = 'coco-offer';
var RESULT_NOTIFICATION = 'coco-result';

var state = {
  settings: normalizeSettings(DEFAULT_SETTINGS),
  smid: '',
  latest: null,
  lastResult: null,
  history: [],
  pick: null,
  debugLog: [],
  siteOrigin: ''
};

var ready = null;

function normalizeSettings(value) {
  var source = value && typeof value === 'object' ? value : {};
  return {
    autoClaim: source.autoClaim !== false,
    notifications: source.notifications !== false,
    overlay: source.overlay !== false,
    keepTabReady: source.keepTabReady !== false,
    domClick: source.domClick !== false,
    trustedFallback: source.trustedFallback !== false
  };
}

function normalizeLatest(value) {
  if (!value || typeof value !== 'object') return null;
  if (!value.offer || typeof value.offer.dataSign !== 'string') return null;
  return {
    offer: value.offer,
    pageUrl: typeof value.pageUrl === 'string' ? value.pageUrl : '',
    tabId: typeof value.tabId === 'number' ? value.tabId : null,
    capturedAt: typeof value.capturedAt === 'number' ? value.capturedAt : Date.now(),
    claimed: Boolean(value.claimed),
    result: typeof value.result === 'string' ? value.result : ''
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(function (entry) {
    return entry && typeof entry === 'object' && typeof entry.dataSign === 'string';
  }).slice(0, HISTORY_LIMIT);
}

function hydrate() {
  if (ready) return ready;
  ready = chrome.storage.local.get([
    STORAGE.settings,
    STORAGE.smid,
    STORAGE.latest,
    STORAGE.lastResult,
    STORAGE.history,
    STORAGE.pick,
    STORAGE.debugLog,
    STORAGE.siteOrigin
  ]).then(function (stored) {
    state.siteOrigin = typeof stored[STORAGE.siteOrigin] === 'string' ? stored[STORAGE.siteOrigin] : '';
    state.pick = stored[STORAGE.pick] && typeof stored[STORAGE.pick] === 'object' ? stored[STORAGE.pick] : null;
    state.debugLog = Array.isArray(stored[STORAGE.debugLog]) ? stored[STORAGE.debugLog] : [];
    state.settings = normalizeSettings(stored[STORAGE.settings]);
    state.smid = typeof stored[STORAGE.smid] === 'string' ? stored[STORAGE.smid] : '';
    state.latest = normalizeLatest(stored[STORAGE.latest]);
    state.lastResult = stored[STORAGE.lastResult] || null;
    state.history = normalizeHistory(stored[STORAGE.history]);
    updateBadge();
    return state;
  }).catch(function (error) {
    console.warn('[coco-catcher] hydrate failed', error);
    return state;
  });
  return ready;
}

function persist() {
  var payload = {};
  payload[STORAGE.settings] = state.settings;
  payload[STORAGE.smid] = state.smid;
  payload[STORAGE.latest] = state.latest;
  payload[STORAGE.lastResult] = state.lastResult;
  payload[STORAGE.history] = state.history;
  payload[STORAGE.pick] = state.pick;
  return chrome.storage.local.set(payload).catch(function (error) {
    console.warn('[coco-catcher] persist failed', error);
  });
}

function publicState() {
  return {
    settings: state.settings,
    smid: state.smid,
    latest: state.latest,
    lastResult: state.lastResult,
    history: state.history,
    pick: state.pick,
    debugCount: state.debugLog.length
  };
}

function updateBadge() {
  var pending = state.latest && !state.latest.claimed;
  try {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    chrome.action.setBadgeText({ text: pending ? '1' : '' });
  } catch (error) {
    /* action unavailable while the worker spins down */
  }
}

function showNotification(id, title, message) {
  if (!state.settings.notifications) return;
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title,
      message: message,
      priority: 2
    }, function () { void chrome.runtime.lastError; });
  } catch (error) {
    /* notifications can be disabled at the OS level */
  }
}

function broadcastState() {
  chrome.tabs.query({}, function (tabs) {
    void chrome.runtime.lastError;
    if (!Array.isArray(tabs)) return;
    var payload = { type: CF.MSG.STATE_UPDATED, settings: state.settings, pick: state.pick };
    tabs.forEach(function (tab) {
      if (typeof tab.id !== 'number') return;
      try {
        chrome.tabs.sendMessage(tab.id, payload, function () { void chrome.runtime.lastError; });
      } catch (error) {
        /* tab is not a BC.Game page */
      }
    });
  });
}

function describeOffer(offer) {
  var amount = offer && offer.totalBonus ? offer.totalBonus : 'bonus';
  var currency = offer && offer.currencyName ? offer.currencyName : '';
  return currency ? (amount + ' ' + currency) : String(amount);
}

function recordHistory(entry) {
  state.history = [entry].concat(state.history).slice(0, HISTORY_LIMIT);
}

function handleOfferCaptured(message, sender) {
  var offer = message && message.offer;
  if (!offer || typeof offer.dataSign !== 'string') {
    return { ok: false, message: 'Invalid offer.' };
  }
  var tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  var pageUrl = typeof message.pageUrl === 'string'
    ? message.pageUrl
    : (sender && sender.tab ? sender.tab.url || '' : '');

  state.latest = {
    offer: offer,
    pageUrl: pageUrl,
    tabId: tabId,
    capturedAt: Date.now(),
    claimed: false,
    result: ''
  };
  recordHistory({
    dataSign: offer.dataSign,
    currencyName: offer.currencyName || '',
    totalBonus: offer.totalBonus || '',
    capturedAt: state.latest.capturedAt,
    pageUrl: pageUrl,
    status: 'captured',
    message: ''
  });
  updateBadge();
  persist();
  showNotification(
    OFFER_NOTIFICATION,
    'Coco appeared!',
    state.settings.autoClaim
      ? 'Auto-catching ' + describeOffer(offer) + '\u2026'
      : 'Click the Coco bubble or open the extension to catch ' + describeOffer(offer) + '.'
  );
  return { ok: true };
}

function handleClaimResult(message) {
  var ok = Boolean(message && message.ok);
  var offer = message && message.offer;
  var text = message && typeof message.message === 'string' ? message.message : '';

  if (state.latest && offer && state.latest.offer.dataSign === offer.dataSign) {
    state.latest.claimed = ok;
    state.latest.result = text;
  }

  if (offer && state.history.length > 0) {
    var index = -1;
    for (var i = 0; i < state.history.length; i += 1) {
      if (state.history[i].dataSign === offer.dataSign) { index = i; break; }
    }
    if (index >= 0) {
      var next = state.history.slice();
      next[index] = Object.assign({}, next[index], {
        status: ok ? 'claimed' : 'failed',
        message: text
      });
      state.history = next;
    }
  }

  state.lastResult = { ok: ok, message: text, at: Date.now() };
  updateBadge();
  persist();
  if (ok) {
    showNotification(RESULT_NOTIFICATION, 'Coco caught!', text || 'The bonus was claimed.');
  } else {
    showNotification(RESULT_NOTIFICATION, 'Coco claim failed', text || 'The server refused the claim.');
  }
  return { ok: true };
}

function activeTabId() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    if (!Array.isArray(tabs) || tabs.length === 0) return null;
    return typeof tabs[0].id === 'number' ? tabs[0].id : null;
  }).catch(function () {
    return null;
  });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).then(function (response) {
    return response || { ok: false, message: 'No response from the page.' };
  }).catch(function () {
    return { ok: false, message: 'Coco Catcher is not loaded on that tab. Reload BC.Game.' };
  });
}

function requestClaim() {
  var target = state.latest && typeof state.latest.tabId === 'number'
    ? Promise.resolve(state.latest.tabId)
    : activeTabId();
  return target.then(function (tabId) {
    if (tabId === null) return { ok: false, message: 'Open a BC.Game tab first.' };
    return sendToTab(tabId, { type: CF.MSG.POPUP_CLAIM });
  });
}

function dismissLatest() {
  state.latest = null;
  updateBadge();
  persist();
  return { ok: true };
}

function setSettings(value) {
  state.settings = normalizeSettings(value);
  persist();
  broadcastState();
  return { ok: true, settings: state.settings };
}

function clearHistory() {
  state.history = [];
  state.lastResult = null;
  state.debugLog = [];
  persist();
  chrome.storage.local.set({ debugLog: [] });
  return { ok: true };
}

/* ---------- Page-level catcher (dom-catcher.js) ---------- */

function addDebug(entry, sender) {
  if (!entry || typeof entry !== 'object') return;
  var item = Object.assign({ at: new Date().toISOString() }, entry);
  if (sender && sender.tab && typeof sender.tab.id === 'number') item.tab = sender.tab.id;
  state.debugLog = [item].concat(state.debugLog).slice(0, DEBUG_LIMIT);
  var payload = {};
  payload[STORAGE.debugLog] = state.debugLog;
  chrome.storage.local.set(payload).catch(function () {});
}

function recentlyClaimed(ms) {
  return state.history.some(function (entry) {
    return entry.status === 'claimed' && Date.now() - entry.capturedAt < ms;
  });
}

function handleDomEvent(message, sender) {
  addDebug({ kind: 'dom-' + message.kind, detail: { message: message.message, element: message.element } }, sender);
  if (message.kind === 'clicked') {
    var text = message.message || 'Coco clicked.';
    // The direct API claim may already have handled this Coco.
    if (state.latest && !state.latest.claimed && Date.now() - state.latest.capturedAt < 120000) {
      state.latest.claimed = true;
      state.latest.result = text;
      state.history = state.history.map(function (entry) {
        return entry.dataSign === state.latest.offer.dataSign
          ? Object.assign({}, entry, { status: 'clicked', message: text })
          : entry;
      });
    } else if (!recentlyClaimed(60000)) {
      recordHistory({
        dataSign: 'dom-' + Date.now(),
        currencyName: '',
        totalBonus: '',
        capturedAt: Date.now(),
        pageUrl: sender && sender.tab ? sender.tab.url || '' : '',
        status: 'clicked',
        message: text
      });
    }
    state.lastResult = { ok: true, message: text, at: Date.now() };
    updateBadge();
    persist();
    showNotification(RESULT_NOTIFICATION, 'Coco clicked!', text);
  } else if (message.kind === 'gave-up') {
    persist();
    showNotification(RESULT_NOTIFICATION, 'Coco did not react',
      'Coco Catcher clicked the Coco icon but it stayed. Open the popup and use "Copy debug report".');
  }
  return { ok: true };
}

/**
 * Real mouse click through the DevTools protocol (isTrusted events), for pages that ignore
 * synthetic clicks. Chrome shows a short "is debugging this browser" bar while attached.
 */
function trustedClick(tabId, x, y) {
  var target = { tabId: tabId };
  var base = { x: x, y: y, button: 'left', clickCount: 1 };
  return chrome.debugger.attach(target, '1.3').catch(function (error) {
    if (String(error && error.message).indexOf('Already attached') < 0) throw error;
  }).then(function () {
    return chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseMoved', button: 'none' }));
  }).then(function () {
    return chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mousePressed' }));
  }).then(function () {
    return chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseReleased' }));
  }).then(function () {
    setTimeout(function () { chrome.debugger.detach(target).catch(function () {}); }, 1000);
    return { ok: true };
  }).catch(function (error) {
    addDebug({ kind: 'trusted-click-failed', detail: String((error && error.message) || error) });
    return { ok: false, message: String((error && error.message) || error) };
  });
}

function savePick(pick) {
  if (!pick || typeof pick !== 'object') return { ok: false };
  state.pick = {
    selector: typeof pick.selector === 'string' ? pick.selector.slice(0, 500) : '',
    src: typeof pick.src === 'string' ? pick.src.slice(0, 200) : '',
    element: pick.element || null,
    at: Date.now()
  };
  addDebug({ kind: 'pick-saved', detail: state.pick });
  persist();
  broadcastState();
  return { ok: true };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
  hydrate().then(function () {
    switch (message.type) {
      case CF.MSG.GET_STATE:
        rememberSite(sender);
        sendResponse({ ok: true, state: publicState() });
        return;
      case CF.MSG.OFFER_CAPTURED:
        sendResponse(handleOfferCaptured(message, sender));
        return;
      case CF.MSG.SMID_CAPTURED:
        if (typeof message.smid === 'string' && message.smid) {
          state.smid = message.smid;
          persist();
        }
        sendResponse({ ok: true });
        return;
      case CF.MSG.CLAIM_RESULT:
        sendResponse(handleClaimResult(message));
        return;
      case CF.MSG.DISMISS:
        sendResponse(dismissLatest());
        return;
      case CF.MSG.SET_SETTINGS:
        sendResponse(setSettings(message.settings));
        return;
      case CF.MSG.CLEAR_HISTORY:
        sendResponse(clearHistory());
        return;
      case CF.MSG.CLAIM_REQUEST:
        requestClaim().then(sendResponse);
        return;
      case CF.MSG.DOM_EVENT:
        sendResponse(handleDomEvent(message, sender));
        return;
      case CF.MSG.DEBUG_EVENT:
        addDebug(message.entry, sender);
        sendResponse({ ok: true });
        return;
      case CF.MSG.GET_DEBUG:
        sendResponse({ ok: true, debugLog: state.debugLog, state: publicState() });
        return;
      case CF.MSG.TRUSTED_CLICK:
        if (!sender.tab || typeof sender.tab.id !== 'number') {
          sendResponse({ ok: false });
          return;
        }
        trustedClick(sender.tab.id, Number(message.x), Number(message.y)).then(sendResponse);
        return;
      case CF.MSG.PICK_SAVED:
        sendResponse(savePick(message.pick));
        return;
      case CF.MSG.CLEAR_PICK:
        state.pick = null;
        persist();
        broadcastState();
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false, message: 'Unknown message type: ' + message.type });
        return;
    }
  }).catch(function (error) {
    console.warn('[coco-catcher] message failed', error);
    sendResponse({ ok: false, message: 'Extension error.' });
  });
  return true;
});

chrome.notifications.onClicked.addListener(function (id) {
  if (id !== OFFER_NOTIFICATION && id !== RESULT_NOTIFICATION) return;
  chrome.notifications.clear(id);
  var tabId = state.latest && typeof state.latest.tabId === 'number' ? state.latest.tabId : null;
  if (tabId === null) return;
  chrome.tabs.update(tabId, { active: true }).catch(function () {
    /* the tab was closed */
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (!state.latest || state.latest.tabId !== tabId) return;
  persist();
});

/* ---------- Daily schedule: keep a hooked BC.Game tab open for every Coco window ---------- */

function scheduleWindows() {
  CF.WINDOWS_JST.forEach(function (_, index) {
    chrome.alarms.create(ALARM_PREFIX + index, {
      when: Date.now() + CF.msUntilWindow(index, -PREPARE_MIN),
      periodInMinutes: 24 * 60
    });
  });
}

function pingTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: CF.MSG.PING }).then(function (response) {
    return Boolean(response && response.ok && response.hooked);
  }).catch(function () {
    return false;
  });
}

/**
 * Make sure a BC.Game tab exists and its websocket is hooked. Tabs that were open before
 * the extension was installed/reloaded have no content scripts, so they are reloaded;
 * without a tab, a pinned background tab is opened. Tabs are kept from being discarded.
 */
/**
 * bc.game and bc.co do not share cookies, so a scheduled tab must open the mirror the
 * user is actually logged in on: the last one a content script ran on.
 */
function rememberSite(sender) {
  var url = sender && sender.tab && sender.tab.url;
  if (!url || !CF.HOST_PATTERN.test(url)) return;
  var origin = new URL(url).origin;
  if (origin === state.siteOrigin) return;
  state.siteOrigin = origin;
  var payload = {};
  payload[STORAGE.siteOrigin] = origin;
  chrome.storage.local.set(payload).catch(function () {});
}

function siteUrl() {
  return state.siteOrigin ? state.siteOrigin + '/' : DEFAULT_SITE_URL;
}

function ensureSiteTab(openIfMissing) {
  return chrome.tabs.query({ url: SITE_TABS }).then(function (tabs) {
    if (tabs.length === 0) {
      if (!openIfMissing) return null;
      return chrome.tabs.create({ url: siteUrl(), active: false, pinned: true }).then(function (tab) {
        chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(function () {});
        return tab;
      });
    }
    return Promise.all(tabs.map(function (tab) {
      chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(function () {});
      return pingTab(tab.id).then(function (hooked) {
        if (!hooked) return chrome.tabs.reload(tab.id).catch(function () {});
        return null;
      });
    }));
  }).catch(function (error) {
    console.warn('[coco-catcher] ensureSiteTab failed', error);
  });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name.indexOf(ALARM_PREFIX) !== 0) return;
  hydrate().then(function () {
    if (state.settings.keepTabReady) ensureSiteTab(true);
  });
});

chrome.runtime.onInstalled.addListener(function () {
  hydrate().then(function () {
    scheduleWindows();
    // Hook BC.Game tabs that were already open when the extension was installed/reloaded.
    ensureSiteTab(false);
  });
});

chrome.runtime.onStartup.addListener(function () {
  scheduleWindows();
  hydrate().then(function () {
    if (state.settings.keepTabReady && CF.inWindow(Date.now(), PREPARE_MIN)) ensureSiteTab(true);
  });
});

hydrate();

