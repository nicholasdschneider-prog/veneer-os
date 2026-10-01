# Browser scripts: many steps in one call (build #512, 2026-10-01)

## Why

A week of audit data (9,547 browser commands, 103 chat-days) showed that the
cost of browser work is turn count, not page size. Each command is one model
turn carrying about 136K tokens of context, a median browser session is 28 of
them, and they arrive 6.6 seconds apart. A test on the bots' most common
browser job (USPS and UPS tracking) took 8 turns and 50 seconds with the
existing tools and 1 turn and under 4 seconds as a single scripted run. Full
measurements: `out/browser-use-test-2026-09-30.md`.

Browser Use (browser-use.com) prompted the test. Its open-source harness proved
the approach, but it attaches to a whole Chrome with cookie access and
unrestricted JavaScript, and its cloud browsers cannot carry our signed-in
profiles or secret-fill tools. Neither is adopted. The design is ported onto
the existing relay instead.

## What shipped

A `script` tool on the Veneer Browser MCP server. It takes a list of steps and
returns only what the reading steps produced.

- Steps: `open`, `tab`, `goto`, `wait`, `click`, `fill`, `press`, `select`,
  `scroll`, and the reading steps `text`, `table`, `links`, `attr`, `exists`,
  `url`. At most 40 steps, 120 seconds, 50,000 output characters (20,000 by
  default) with a `truncated` flag.
- Engine: `server/src/veneerBrowser/script.ts`. Manager entry point:
  `VeneerBrowserManager.runScript`.
- Each run takes its own agent ticket and CDP connection through the existing
  relay, exactly as `fetch_url` does. The agent-browser daemon's cached ticket,
  selected tab and `@refs` are never touched. No new Chrome and no new process.
- Tabs a script opens close when it ends unless `keep: true`. A `tab` step
  attaches to a page that is already open and leaves it open.
- Clicks and keystrokes are trusted CDP input events at the element's on-screen
  position, so pages that ignore synthetic events still respond.

## Security boundary

- A step list is data. There is no step that runs supplied JavaScript; every
  page-side function is fixed platform code run in an isolated world with the
  step's fields as arguments. `run` keeps refusing `eval`/`js` as before.
- The engine can send only the CDP methods in `SCRIPT_CDP_METHODS`. Nothing in
  it reads cookies, storage, traffic, HTML or screenshots.
- No step returns a form field's value. `attr` has a fixed allowlist that
  excludes `value`. Reading steps are refused while a secret-filled field is
  live in the chat, matching the `get text` rule for `run`.
- `open` and `goto` accept only addresses `navigate` would open. Document
  requests, including redirects, to non-web or loopback addresses are failed.
- Secrets and 2-step codes are not script steps. `fill_secret`, `fill_totp`,
  `fill_sms_code` and `fill_email_code` stay separate tools.
- Raw CDP errors never reach the result; failures carry fixed messages.
- Validation failures return fixed text so a rejected script is not echoed.

## Lifecycle and audit

- Runs inside the chat's serial queue, so it cannot interleave with other
  browser commands, and honors unresolved controller recovery.
- Nothing is retried or replayed. A failed step reports its index, a code and
  `outcome_unknown`. A page dialog stops the script at once and leaves its tab
  open for the `dialog` tool.
- One `veneer_browser_audit` row per run: `command.executed` with command
  `script` (or `script.read` when no step clicks or types), `success`, `steps`,
  `duration_ms` and `output_chars`. Step contents are not recorded. A failed
  `script` run sets the existing "earlier action has an unknown outcome" notice.
- Turn-end release, holds, capacity limits and the per-project cap are unchanged.

## Deliberate differences from the queued brief

- **Fixed step list instead of a constrained JavaScript runtime.** The browser
  already forbids agent JavaScript in signed-in pages; a JS sandbox would have
  reopened that. Per-chat helper files are therefore not applicable.
- **Per-run connection instead of a long-lived controller process.** The saving
  comes from running many steps per call. A fresh ticket costs milliseconds and
  avoids a second controller to keep in step with suspend, reopen and recovery.
- **No relay-wide cookie/storage denylist.** The relay is shared with the
  agent-browser daemon and the live viewer; the script engine's own method
  allowlist enforces the boundary for this path without changing theirs.
  `browser-manager/` is unchanged.
- **`duration_ms` is recorded for scripts only.** Existing tests pin the exact
  audit metadata of other commands.
- **No screenshot step.** The existing `screenshot` tool covers it.

## Validation

- `npm run typecheck`: pass.
- `npm test`: server 3,254 passed (12 skipped), web 966, browser-manager 49,
  installer 29.
- `server/test/veneerBrowserScript.test.ts` with
  `VENEER_BROWSER_TEST_CHROME` set: 11 passed against a disposable Chrome and a
  local fixture site. Covers fill/select/click/wait/read, kept and attached
  tabs, failing-step reporting, loopback redirect refusal, the output cap,
  dialog handling, the time limit, and that a password value, cookie and
  localStorage entry on the fixture page never appear in output.
- `npm run build`: pass.

## Acceptance on the live relay

Deployed 2026-10-01 12:37Z (commit 0a78ce8). The same task as the baseline, run
from a Platform Dev chat through the production MCP endpoint, relay and a normal
working copy: USPS 9434650106151139738015 and UPS 1Z4434570341274300, six steps
(open, wait, text for each carrier).

| | Model turns | Wall time | Characters returned |
|---|---|---|---|
| Existing tools, 2026-09-30 | 8 | 50 s | about 8,000 |
| `script`, 2026-10-01 | 1 | 9.6 s | 700 |

Both carriers returned the correct current status. The audit trail recorded one
`command.executed` row with command `script.read`, `success: true`, `steps: 6`
and `duration_ms: 9616`. No tab was left open. The four node services were
restarted; the browser manager was not, because none of its code changed.
