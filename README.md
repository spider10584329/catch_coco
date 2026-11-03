# Coco Catcher for BC.Game

A small Manifest V3 Chrome extension that watches BC.Game's websocket for the **Coco**
(crocodile bonus) push, shows a clickable Coco bubble on the page, and sends the same claim
request the site itself sends when the player clicks Coco.

## How Coco actually works

Reverse-engineered from `D:\Projects\SC\ScrapWeb\ScrapPP\scrapped\bcgame.ai\traffic.log`:

1. **Push** — BC.Game opens a socket.io connection to `wss://socketv4.bcgame.ai/socket.io/`
   and registers `assets/bonus-crocodile-*.js` with `namespace: "/game-support"`.
   When Coco appears the server sends a binary frame (traffic.log line 17903 in the current
   capture; line numbers shift between captures, so search for `bonus-crocodile`):

   ```
   [WEBSOCKET RECEIVED] (https://bcgame.ai/game/limbo) [binary:base64]
   BAINL2dhbWUtc3VwcG9ydA9ib251cy1jcm9jb2RpbGV7InRvdGFsQm9udXMiOiIyMDAwMDAwIi...
   ```

   which decodes to a length-prefixed envelope followed by JSON:

   ```
   04 02 0d "/game-support" 0f "bonus-crocodile"
   {"totalBonus":"2000000","endTime":1793260145499,"createTime":1793260085499,
    "limitLevel":3,"currencyName":"BCD","dataSign":"806775e4...289d","sendTime":0}
   ```

2. **Claim** — clicking Coco posts (traffic.log lines 17940-17942):

   ```
   POST https://bcgame.ai/api/game/support/bonus/crocodile/
   { "currencyName": "BCD", "dataSign": "806775e4...289d" }
   -> { "code": 0, "msg": null, "data": "Congratulations on winning 0.085918 BCD" }
   ```

   `dataSign` is single-use, the offer also expires at `endTime`, and the site only reacts
   when `dataSign` is present. The site also refuses the claim below VIP level 4
   (`limitLevel` in the push) — the extension surfaces the server's answer instead of
   guessing.

## Architecture

| File | World | Role |
| --- | --- | --- |
| `src/interceptor.js` | `MAIN` (document_start) | Self-contained. Wraps `window.WebSocket` and forwards frames that mention Coco through `window.postMessage`. Also captures the site's `smid` header and logs Coco-related sockets and requests for the debug report. |
| `src/shared/coco-frame.js` | isolated / worker / popup | Decoder (`parseFrame`, `normalizeOffer`, `buildClaimBody`), JST schedule and message names. |
| `src/content.js` | `ISOLATED` | Decodes forwarded frames, shows the bubble and sends `POST /api/game/support/bonus/crocodile/` with page cookies. |
| `src/dom-catcher.js` | `ISOLATED` | Finds the Coco icon on the page (picked element, `croc`/`coco` names, or new floating media right after a push), clicks it, presses the Claim button, and falls back to a real mouse click. |
| `src/background.js` | service worker | State, settings, schedule alarms, notifications, debug log, real (debugger) clicks. |
| `src/popup.*` | popup | Latest offer, Pick/Find Coco, settings, history, "Copy debug report". |

> **Never list one file in two `content_scripts` entries.** Chrome injects a file only once
> per frame. In 1.0, `coco-frame.js` was shared by the MAIN and ISOLATED entries, so the
> ISOLATED world never got `CocoFrame` and `content.js` exited on every page load. A unit test
> now guards against this.

## Catching the Coco icon

Two independent paths, so one working is enough:

1. **Websocket push.** The Coco push is decoded and the claim API is called directly
   (Auto-catch).
2. **Clicking the icon.** `dom-catcher.js` clicks the Coco just as you would, so the site runs
   its own claim. Coco appears at a **random moment inside the four windows** (GMT+9:
   04:45–05:15, 10:45–11:15, 16:45–17:15, 22:45–23:15) and at a **random position**:
   off-screen, below the fold or moving. The page is only scanned inside those windows, with a
   2-minute allowance for clock drift, or right after a decoded Coco push. Detection never assumes a spot. It scrolls the icon into view, measures
   its centre at the moment of the click, and reacts to page changes instead of timers,
   because Chrome slows timers in background tabs. If a dialog opens, it presses its
   Claim/Receive/Collect button. If the icon ignores two clicks, it sends a real mouse click
   through `chrome.debugger`, and Chrome briefly shows a "debugging this browser" bar.

If the icon is ever missed, open the popup while Coco is on screen, click **Pick Coco** and
then click the Coco. Its selector and image name are saved and used from then on. **Find now**
shows whether Coco is detected right now. **Copy debug report** copies everything needed to
diagnose a miss.

## Install

1. `npm run icons` (generates `icons/icon{16,32,48,128}.png`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick
   this folder (`catch-coco`).
3. Log in to BC.Game in the same browser profile. Supported mirrors: `bc.game`, `bc.co`,
   `bcgame.ai`, `bcgame.com` (any subdomain). BC.Game tabs that were already open are
   reloaded automatically so the websocket hook is in place.

## Daily schedule

Coco appears at a random moment inside four windows (JST, GMT+9):
04:45–05:15, 10:45–11:15, 16:45–17:15, 22:45–23:15.

With **Keep tab ready** on, an alarm fires 5 minutes before each window. If no tab is open, it
opens a pinned tab on the mirror you last used (`bc.game` or `bc.co`; the two do not share a
login). The first time, before you have visited either, it opens `https://bc.game/`. It also keeps BC.Game tabs from being discarded and reloads any
tab whose websocket hook is missing. With **Auto-catch** on, which is the default, the claim is
sent as soon as the push arrives. Leave the browser running and the PC awake.

## Usage

- When Coco appears, a green bubble slides in bottom-right (and a desktop notification
  fires if enabled). Click it to catch Coco.
- The toolbar popup shows the latest offer, a **Catch Coco** button, remaining time and a
  short history of captured/claimed/missed offers.
- Settings:
  - **Auto-catch** (default on): claims as soon as the push arrives. Network errors, HTTP 429
    and 5xx responses are retried twice.
  - **Keep tab ready** (default on): see *Daily schedule*.
  - **In-page bubble** — toggle the on-page Coco button.
  - **Desktop notifications** — alert even when BC.Game is in a background tab.

## Tests

```
npm test
```

`tests/coco-frame.test.js` replays the real captured websocket frame and asserts the
decoder, the normalizer, the claim body, expiry handling and the negative cases (balance
frame, wrong namespace, invalid JSON, oversized frame).

## Fixes in 1.2.0

- **Root cause of "nothing happens":** `coco-frame.js` was listed in both content-script
  entries, so Chrome only injected it into the MAIN world. `content.js` therefore never ran:
  no bubble, no auto-claim. The MAIN script is now self-contained.
- The Coco icon on the page is now clicked directly, with Claim-button handling, retries, a
  real-click fallback, Pick Coco and a debug report.

## Fixes in 1.1.0

- The manifest and the `smid` capture only matched `bcgame.ai` / `bcgame.com`, so nothing
  ran on `bc.game` / `bc.co`.
- The offer expiry used the server `endTime` against the PC clock. With a clock more than
  about 60 s fast, every offer looked expired on arrival and the claim was silently skipped.
  The deadline now comes from `endTime - createTime`, measured from when the push arrived.
- Auto-catch could act on the default settings before the saved ones had loaded. It also used
  a `setTimeout`, which Chrome can delay for up to a minute in background tabs.
- Tabs opened before the extension was (re)loaded were never hooked. They are now detected
  and reloaded.
- Failed claims now raise a notification instead of failing silently.

## Limitations

- BC.Game can change the namespace/event name or the frame codec at any time; both live in
  `src/shared/coco-frame.js` (`NAMESPACE`, `EVENT`) and are the only things to update.
- The claim is subject to the account's own eligibility (VIP level, region, currency); the
  extension never fabricates `dataSign` values and cannot bypass those checks.
- Only top-level frames are hooked (`all_frames: false`); BC.Game's game canvas runs in the
  top document, which is where the push arrives.
