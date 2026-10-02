# Browser capacity: seven slots, four per project, no parked browsers (build #528, 2026-10-01)

## Why

At 19:04Z on 2026-10-01 the chat "Auto PO not created" could not get a browser
while only 2 of 5 machine slots were in use and the Mac had 44% memory free. The
limit it hit was the per-project cap. ERVP had 35 chats that used a browser in the
previous week and could run two at a time, and one of those two was parked: one
bot had kept a copy open since 2026-09-30 18:35Z by renewing its two-hour hold 19
times, with no click or keystroke after 17:35Z on October 1.

Nick approved raising the limits and stopping parked browsers. Cloud browsers were
considered and rejected: they cannot carry saved sign-ins, a non-standard browser
was refused by USPS in testing, and the shortage was a setting, not hardware.

## Before (read-only, taken 19:20Z to 19:45Z, before deployment)

Capacity waits (a chat asked for a browser and none was available):

| Day | Project | Waits | Got a browser | Expired | Cancelled |
|---|---|---|---|---|---|
| 2026-09-29 | ERVP | 10 | 0 | 0 | 10 |
| 2026-09-29 | Veneer | 3 | 0 | 0 | 3 |
| 2026-09-30 | ERVP | 13 | 0 | 1 | 12 |
| 2026-10-01 | ERVP | 15 | 1 | 2 | 12 |

- One wait in three days ended with the chat getting a browser.
- Peak chats issuing browser commands in the same ten minutes on October 1: 3
  across the machine, 2 in ERVP (its cap).
- Longest-held copy: 25 hours, 19 hold renewals, about 2 hours since its last
  click or keystroke when measured. Second: 9 renewals overnight.
- Memory free with 2 working copies running: 41% (16 GB Mac).
- Limits: 5 machine, 2 per project.

## What changed

- **Limits.** The browser manager's defaults are now 7 running browsers and 4 per
  project (`VENEER_BROWSER_MAX_ACTIVE`, `VENEER_BROWSER_MAX_PER_PROJECT`). The
  installed launch agent sets neither, so the defaults govern and a reinstall keeps
  them. Warm copies and admission order are unchanged.
- **Hold bound.** A Keep open hold still lasts at most two hours per request, but
  no hold may run past four hours after the last real action in that copy. A real
  action is a click, keystroke, sign-in start, or a script that acts. Reads,
  snapshots, waits, hold renewals and a connected viewer do not count. A renewal
  inside the bound is cut off at the bound; one past it is refused, recorded as
  `clone.hold_refused`, and answered with what to do instead (import downloads,
  record facts or a screenshot in the case file, `update_profile` only after an
  intentional new sign-in, then let the browser pause). Turning a hold off is
  always allowed.
- **No copy is cut short at deploy.** A hold recorded before this change keeps its
  own expiry, then cannot renew.
- **Visible to bots and people.** Status text and the keep_open result state when a
  hold can be renewed until. The panel's Keep open switch shows the refusal.
  Tool description, server instructions and the guide entry carry the new numbers
  and the rule.

Turn-end release, the two-hour single hold, viewer grace and the script tool are
unchanged. Live browsers survive a browser-manager restart.

## Tests

- browser-manager: 51 passed. New: the shipped defaults admit seven and four,
  refuse the eighth and a project's fifth, and reuse a freed slot; a chat waiting
  only on its project's cap does not delay another project and takes the slot the
  moment one frees.
- server: 3,294 passed (15 skipped). New: eleven hold-bound cases (fresh copy,
  renewal cut at the bound, refusal with audit row and message, the minute before
  the bound, what does and does not count as use, a click, typing and an acting
  script each restoring holdability, a pre-existing hold finishing then lapsing,
  release always allowed), the bot-facing messages, and the panel route.
- web 968, installer 29. Typecheck and build pass.

## Live saturation test (2026-10-01 19:49Z, real manager, real Chrome)

The browser manager was restarted alone at 19:46Z during a lull; running browsers
survive that restart. The test used disposable signed-out copies in two throwaway
projects through the manager's own API, never a bot's chat or profile, and loaded
a real page in each (USPS, UPS, FedEx, Wikipedia, MDN and others). One bot copy
was running throughout.

| Check | Result |
|---|---|
| Limits reported by the manager | 7 machine, 4 per project |
| Project A, copies 1 to 4 | started, about 0.5 s each |
| Project A, copy 5 | refused after the 20 s admission wait (project cap) |
| Project B, copies 1 and 2 | started; machine at 7 of 7 |
| Machine copy 8 | refused after the 20 s admission wait |
| Running at any point | never above 7 |
| After cleanup | back to 1 running; 8 test profiles removed |

In an earlier run the eighth copy waited 11.7 s and was admitted the moment a
bot's browser paused, with the count still at 7.

Memory on the 16 GB Mac:

| | Free | Managed copies | Their RSS | All Chrome RSS |
|---|---|---|---|---|
| Before | 42% | 3 (one running, two paused or warm) | 0.86 GB | 1.8 GB |
| Seven running with pages loaded | 32% | 9 | 7.8 GB | 8.5 GB |
| After | 42% | 3 | | |

- Free memory stayed above the 20% floor set for this test, so the limit stays at 7.
- RSS double-counts memory shared between Chrome processes, so 7.8 GB overstates
  the real cost; the 10-point drop in free memory (about 1.6 GB) is the better
  measure. Heavy carrier pages ran 0.9 to 1.6 GB RSS per copy, well above the
  0.3 to 0.4 GB measured on September 29 for typical bot pages.
- **Caution:** swap was already 9.7 of 10.2 GB used before the test and reached
  9.95 GB during it. Seven browsers did not cause that, but the Mac has little
  swap headroom. If free memory at a real seven-browser peak falls under 20%, drop
  `VENEER_BROWSER_MAX_ACTIVE` to 6.

Script and raw output: `out/browser-capacity/saturation.mjs`,
`out/browser-capacity/saturation-result-2.json`.

## After-measurements

Appended below as they are taken.

### 2026-10-01 22:00Z, about two hours after deployment

Read-only, from the audit trail since 19:46Z.

| Measure | Before | After (2 h 14 m) |
|---|---|---|
| Capacity waits created | 14 on Oct 1 before deploy, 37 in three days | 0 |
| Waits that ended with a browser | 1 of 37 | n/a, nobody had to wait |
| Peak chats driving a browser in one ten-minute window, ERVP | 2 | 5 |
| Same, whole machine | 3 | 5 |
| Hold renewals refused | n/a | 0 |
| Copies held more than 4 h after their last action | 1 (25 h) | 0 |

- **The parked copy paused on schedule.** Its bound was 21:35:14Z; the sweep
  paused it at 21:36:21Z with files and sign-in kept. Its owner checked it after
  the notice and found the page it had been preserving for a day was not on
  screen at all: the tabs showed a different order. That is recorded in the
  BUILD505 reconnect report (commit 1ac896b).
- **Who used the freed capacity:** Piper (1,010 commands), the afternoon Lippert
  sweep (198), AutoShip Worker (157), Finn (48), Clara, Sage, Avery.
- **Script tool:** 320 scripts, 304 succeeded (95%), carrying 1,688 steps, out of
  1,445 browser calls. Piper ran 190 of 190 successfully.
- **Notices do not resume a parked task.** `send_message` runs in a side
  coordination lane of the target bot; it does not post into or wake the bot's
  main chat. "Auto PO not created" and Nora acknowledged in that lane and their
  main chats stayed idle with no browser activity. They pick up the new limits on
  their next turn, which needs a person or a schedule to start.
- **Memory:** 35% free with no managed browser running. Swap grew to 14.8 of
  16 GB used. Browsers are not the cause: 389 `mcp-remote` helper processes hold
  about 7 GB, 194 of them children of one long-lived agent server process. That
  is a separate problem from browser capacity and is the main memory risk on
  this Mac.
- Services were restarted again at 19:55Z by an unrelated build; limits and the
  hold bound were unaffected.

### 2026-10-02 20:00Z, next business day (about 24 hours after deployment)

Read-only, from the audit trail. Limits confirmed still 7 machine / 4 per project
in the running source; services were restarted by other builds at 17:59Z to
18:08Z on October 2 with no effect on them.

| Measure | Before (Sept 29 to Oct 1) | Since deployment (24 h) |
|---|---|---|
| Capacity waits | 37, of which 1 got a browser | 0 |
| Peak chats driving a browser in a ten-minute window, ERVP | 2 | 5 on Oct 1, 4 on Oct 2 |
| Same, whole machine | 3 | 5 |
| Hold renewals refused | n/a | 0 |
| Copies held past 4 h without a real action | 1 (25 h) | 0 |
| Chats using a browser | 19 a day | 21 since deploy, 16 on Oct 2 |

- **Waits:** none in 24 hours across 3,115 browser calls from 21 chats. Demand
  reached 4 to 5 ERVP chats at once, which the old cap of 2 would have refused.
- **Holds:** one chat renewed a hold 11 times on October 2. It was working in the
  page throughout (94 real interactions between 13:27Z and 19:57Z), which is what
  a hold is for; the bound never came into play. No browser is running now.
- **Script tool, since deployment:** 729 scripts carried 3,464 steps; 639
  succeeded (88%). All browser calls: 3,115, so the same work as single steps
  would have been about 5,850 calls. On October 2 alone: 353 scripts, 290
  succeeded (82%), 1,567 steps.
- **Success by kind on October 2:** see the table below. Scripts that click or
  type fail more often than read-only ones. The audit row records success, not
  the failing step's code, so the cause is not visible from here.
| Script kind, October 2 | Run | Succeeded | Average steps |
|---|---|---|---|
| acts (clicks or types) | 196 | 156 (80%) | 5.0 |
| read-only | 157 | 134 (85%) | 3.7 |

- **Lippert on the fixed script tool:** the October 2 dropship sweep made 100
  browser calls, 24 of them scripts (19 succeeded) carrying 228 steps. The
  morning of October 1, before the tool existed, one Sage run took 293 calls.
- **Sage** has made 5 browser calls since deployment and no scripts; there is no
  Sage Lippert order on the fixed tool to measure yet.
- **Memory:** 34% free with no managed browser running; swap 7.8 of 8.2 GB used.
  Chrome totals 1.3 GB. The pressure is 282 leftover `mcp-remote` helper
  processes holding 6.9 GB, unchanged in kind from yesterday. Browser capacity at
  seven is not what is using the memory; no real seven-browser peak has occurred
  yet (observed peak 5), so the 20% floor has not been tested in production.

**Verdict.** The wait problem is gone at the observed load. Memory attributable to
browsers is fine at the observed peak of five. The script tool is cutting browser
calls by roughly 45% overall. Open items: script failure rate for acting scripts,
and the leftover helper processes.
