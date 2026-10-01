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

## Live saturation test and after-measurements

Appended below after deployment.
