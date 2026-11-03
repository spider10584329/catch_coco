# How to catch the "Coco appeared" event

There is **no DOM event and no socket.io event you can `.on()`**. The "Coco appeared" signal is a
**binary websocket frame** on BC.Game's socket.io connection:

- URL: `wss://socketv4.bcgame.ai/socket.io/`
- Namespace: `/game-support`  -> `CocoFrame.NAMESPACE` (`src/shared/coco-frame.js`)
- Event: `bonus-crocodile`     -> `CocoFrame.EVENT` (`src/shared/coco-frame.js`)

The frame is a length-prefixed socket.io envelope followed by raw JSON:

```
04 02 0d "/game-support" 0f "bonus-crocodile"
{"totalBonus":"2000000","endTime":1793260145499,"createTime":1793260085499,
 "limitLevel":3,"currencyName":"BCD","dataSign":"806775e4...289d","sendTime":0}
```

## The chain in this extension

| # | Where | What happens |
| - | ----- | ------------ |
| 1 | `src/interceptor.js` (MAIN world, `document_start`) | `window.WebSocket` is replaced by `WrappedWebSocket`, which adds a `message` listener to every socket |
| 2 | `src/interceptor.js` `inspect()` / `forward()` | Normalizes `Blob` / `ArrayBuffer` / typed arrays / strings. Frames up to 64 KB that contain `croc` or `coco` are posted as `{source:'coco-catcher', type:'frame'}` |
| 3 | `src/content.js` `handleFrame()` (ISOLATED) | `CocoFrame.parseFrame()` → `normalizeOffer()` (**requires `dataSign`**) → `withLocalDeadline()`. Unparsed or unsigned frames go to the debug log |
| 4 | `src/content.js` `handleOffer()` | **This is the "appeared" moment.** It sends `OFFER_CAPTURED`, shows the bubble and auto-claims through the API |
| 5 | `src/dom-catcher.js` | Independently finds the Coco icon on the page and clicks it (see README, *Catching the Coco icon*) |
| 6 | `src/background.js` | Stores `latest`/history, updates the badge, shows notifications |

The MAIN script does not load `coco-frame.js`. Chrome injects a file only once per frame, so
listing it in both entries left the ISOLATED world without `CocoFrame`.

## Hooking in yourself

### Page side (extension, ISOLATED world)

Extend `handleOffer` in `src/content.js` right after `runtime.deadline` is set. That code runs
in the extension's isolated world, so this event is not visible to the page:

```js
window.dispatchEvent(new CustomEvent('coco-offer', { detail: offer }));
```

Or listen to the raw channel from a separate content script and decode it yourself:

```js
window.addEventListener('message', function (event) {
  if (event.source !== window || event.origin !== location.origin) return;
  var data = event.data;
  if (!data || data.source !== 'coco-catcher' || data.type !== 'frame') return;
  var parsed = CocoFrame.parseFrame(data.data);
  if (parsed) console.log('Coco appeared:', CocoFrame.normalizeOffer(parsed.payload));
});
```

### Worker side (webhook / analytics)

Add a case in the `chrome.runtime.onMessage` switch (`src/background.js`) for
`CF.MSG.OFFER_CAPTURED`, or hook after `handleOfferCaptured()` returns in the same switch.

### Devtools only (no extension edit)

Paste **before** the socket opens, then reload the page — the push is binary, so it must be decoded
the same way:

```js
const NativeWS = WebSocket;
window.WebSocket = function (url, p) {
  const ws = p === undefined ? new NativeWS(url) : new NativeWS(url, p);
  ws.addEventListener('message', (e) => {
    const text = typeof e.data === 'string'
      ? e.data
      : new TextDecoder().decode(new Uint8Array(e.data));
    if (text.includes('bonus-crocodile') && text.includes('/game-support')) {
      try {
        console.log('COCO APPEARED', JSON.parse(text.slice(text.indexOf('{'))));
      } catch (_) {}
    }
  });
  return ws;
};
```

## Why it can silently not fire

1. **Injection order**: the interceptor must run at `document_start` in the `MAIN` world. Reloading the extension with BC.Game already open leaves the socket on
   the native constructor: reload the tab.
2. **`all_frames: false`** — only the top document is hooked. Correct for BC.Game's canvas; breaks
   if the game is ever moved into an iframe.
3. **`Blob` vs `ArrayBuffer`** — depends on the page's `socket.binaryType`; the `Blob` path is async
   so ordering can differ slightly.
4. **`.on('bonus-crocodile')` is not available** — that needs the page's socket instance; the repo
   deliberately parses raw frames instead and works even when the site never exposes the socket.
5. **Namespace/event changes**: a one-file fix, `NAMESPACE` and `EVENT` in
   `src/shared/coco-frame.js`. The popup's **Copy debug report** includes any Coco frame that
   failed to decode (`ws-unparsed`), with its bytes.
6. **Pushes without `dataSign`** are intentionally ignored by `normalizeOffer` (the site ignores them
   too, and no claimable Coco is rendered).
