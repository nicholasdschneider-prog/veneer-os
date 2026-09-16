# Veneer Browser URL reader

Agents and local scripts can read a rendered URL in one call, using the chat's selected browser profile. Veneer creates a background tab, waits for the requested content, extracts text and table cells, and closes the tab. Recurring reads need no AI turn.

## Agent tool

Call `veneer_browser.fetch_url` with:

```json
{
  "url": "https://revert.finance/#/discover?networks=robinhood",
  "wait_for": { "text": "USDG" },
  "timeout_ms": 60000,
  "max_chars": 50000
}
```

`wait_for` accepts a CSS selector, expected text, and a minimum number of table rows. All supplied conditions must match. The selector also scopes the returned content; omit it to read the whole page. Row counts include headers. For a single-page app, choose an expected row or content marker so its navigation shell cannot count as ready.

## Local script

Run on the Veneer host, from this source checkout:

```sh
node scripts/veneer-browser-fetch.mjs CHAT_ID \
  '{"url":"https://revert.finance/#/discover?networks=robinhood","wait_for":{"text":"USDG"},"timeout_ms":60000}'
```

Use the id of the chat whose profile should load. The helper reads the existing local runner credential at call time and sends it only to the loopback runner, with HTTP redirects disabled. It does not need an active agent turn, issue a new token, or copy browser credentials. This interface is for trusted scripts running as the local Veneer service user.

`DATA_DIR` and `VP_RUNNER_PORT` can override discovery. Otherwise, the helper reads those two settings from `VP_ENV_FILE` or the usual `~/.config/veneer-pro/env`, then uses Veneer's defaults. The runner must be running and include this change; building source alone does not reload an already-running runner.

JavaScript programs can import the same helper:

```js
import { fetchBrowserUrl } from './scripts/veneer-browser-fetch.mjs';

const result = await fetchBrowserUrl({
  conversationId: 'CHAT_ID',
  request: {
    url: 'https://revert.finance/#/discover?networks=robinhood',
    wait_for: { text: 'USDG' },
    timeout_ms: 60000,
  },
});
if (!result.ok) throw new Error(result.error.message);
// Consume result.tables or result.text in the existing polling loop.
```

CLI stdout is one JSON object. Exit code `0` means ready, `1` means the page read failed, and `2` means setup or transport failed. A recurring script should preserve its last good sample on failure and record the failure separately, rather than overwriting good data with an empty result.

## Result and limits

The result includes `ok`, `final_url`, `fetched_at`, `title`, `text`, `tables`, `truncated`, and an optional `error` with a stable code and message. Each table is an array of rows; each row is an array of cell strings. Failed reads return no partial content as usable data.

- This reads rendered DOM content, not raw HTTP responses or authenticated API JSON. Success confirms the requested DOM condition, not a website's underlying HTTP status or data freshness.
- It reads the top document and rendered table rows. It does not scroll, paginate, enter cross-origin frames, or recover rows absent from a virtualized table. A successful response can be truncated; callers must check `truncated`.
- Text and combined cell text each have a `max_chars` budget, default 50,000 and maximum 200,000. Tables also cap at 20 tables, 1,000 rows overall, 100 cells per row, and 4,000 characters per cell.
- `timeout_ms` bounds page reading from connection startup, default 30 seconds and maximum 60 seconds. Browser/profile startup and waiting for the chat's command slot have separate bounded waits; tab cleanup can add up to three seconds. The local helper has a six-minute outer transport limit.
- Top-level redirects must remain on the requested origin. For an HTTP-to-HTTPS or sign-in redirect, request the final site's URL and complete any login in Veneer Browser. Cookies and saved profile logins remain inside the browser.
- Without `wait_for`, a nonempty rendered page qualifies, except a simple loading placeholder. For monitoring, always supply a specific readiness condition.

## Review and verification

The implementation was checked against concurrent interactive commands, expired agent-turn credentials, cross-origin redirects, blank/loading pages, lost target creation replies, output truncation, and cleanup failures. It retains the chat command queue, derives the script's acting user from the chat, checks the owner is active, and leaves the saved profile untouched. Scripts use the chat's currently selected profile, so an intentional profile change also changes future script reads.

Validation commands:

```sh
npm run build -w @veneer-pro/server
VENEER_BROWSER_TEST_CHROME='/path/to/chrome' npm test -w @veneer-pro/server -- \
  test/veneerBrowserReadUrl.test.ts test/veneerBrowser.test.ts \
  test/veneerBrowserRoutes.test.ts test/veneerBrowserMcp.test.ts test/runnerIpcAuth.test.ts
node --test scripts/veneer-browser-fetch.test.mjs
```

Live verification against the filtered Robinhood Revert discovery page succeeded using the Sam Personal working copy and `wait_for.text: "USDG"`, returning 5,519 characters of rendered content. Revert uses a custom grid rather than semantic table elements, so its data is in `text` and `tables` is empty. Its existing text parser can consume that field. Background focus emulation lets visibility-dependent pages render without selecting the user's tab.

The opt-in Chrome test uses an isolated temporary profile and a local fixture with delayed SPA data. It verifies table extraction, readiness failures, redirects, truncation, and preservation of existing tabs. It never opens a personal Chrome profile.

## Changed files

- [Reader backend](server/src/veneerBrowser/readUrl.ts), [browser manager](server/src/veneerBrowser/manager.ts), [agent tool](server/src/veneerBrowser/mcp.ts).
- [Local script](scripts/veneer-browser-fetch.mjs), [runner endpoint](server/src/runner/ipcServer.ts), [CDP client](server/src/channels/cdpClient.ts).
- [Rendered-page tests](server/test/veneerBrowserReadUrl.test.ts), [manager tests](server/test/veneerBrowser.test.ts), [tool tests](server/test/veneerBrowserRoutes.test.ts), [IPC tests](server/test/runnerIpcAuth.test.ts), [script tests](scripts/veneer-browser-fetch.test.mjs).

The central browser gateway buffers initial CDP commands while resolving Chrome's socket, so a new scripted connection cannot lose its first request. The queue is bounded and discarded if the requesting client disconnects. See the [relay](browser-manager/cdp-relay.mjs), [manager integration](browser-manager/manager.mjs), and [relay regression tests](browser-manager/cdp-relay.test.mjs).
