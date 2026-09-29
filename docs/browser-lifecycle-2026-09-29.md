# Browser lifecycle: release at turn end (build #464, 2026-09-29)

## Why this change

Builds #386, #427 and #457 each made suspension safer and more visible, and each
left the same design in place: a working copy stayed running until Veneer could
prove it was safe to close. That proof (page inspection for filled fields and
`beforeunload` handlers, a 30-minute viewer grace, unexpired tickets, uncertain
action history, a 30-minute idle window) kept failing on ordinary pages, so
finished chats pinned all five slots for days. At the start of this build the
audit trail showed Plaud and Henry alternating `automation_disconnect_failed` /
`unfinished_page` every minute since September 27.

## What changed

**Default: a browser gives up its slot when its chat's turn ends.** The runner
watches the conversation status bus; when a chat lands in `idle` or `failed` the
application suspends its copy at once (`releaseAtTurnEnd`). Suspension stops
Chrome and keeps the working directory: profile data, the copy's sign-in,
downloads. The next browser command restarts the same copy. Explicit Stop still
discards it. A five-minute idle backstop in the once-a-minute sweep catches a copy
whose turn-end release was missed. Page state is no longer inspected;
`idle-safety.mjs` and its tests are removed.

**Every hold expires.** `keep_open` (panel switch or bot tool, which now requires a
reason) records an expiry of at most two hours; renewing means asking again. A
hold recorded before expiries existed, and a started sign-in, lapse two hours after
they were recorded. Fresh signed-out browsers no longer start held. The viewer
grace after the last live-view disconnect drops from 30 minutes to 2. A viewer
ticket that has not connected yet still protects the copy; the application's own
agent ticket and automation socket do not.

**Uncertain actions no longer pin a copy.** The audit trail keeps them, the session
view carries `pendingReview`, and the bot is told on reopen to check the page
before repeating anything. Nothing is replayed at suspension or reopen.

**Per-project cap.** `VENEER_BROWSER_MAX_PER_PROJECT` (default 2) is enforced in the
same admission check as the machine cap (`assertCapacity`) for cold starts, clones
and warm-copy adoption. An unfiled chat's scope is its owner's private project, so
unfiled chats share a per-person cap. Warm copies are built subject to the machine
cap only; the project cap applies on adoption. The manager's admission queue keeps
arrival order while the machine is full but lets a waiter refused only by its own
project's cap step aside for other projects; the durable capacity wait tick does
the same. `/v1/capacity?projectId=` reports `projectActive` / `projectLimit`, and
the panel shows "N of 2 for this project" plus each occupant's hold end time.

**Audit noise.** The sweep recorded two retention rows per copy per minute when the
daemon close failed and the suspend was then refused; it now records one final
reason per pass.

## Memory measurement (read-only, 2026-09-29 ~14:00Z)

Machine: 16 GB. `memory_pressure`: 27% free with four working copies running,
Google Chrome (≈0.9 GB), two `agent_browser` desktop Chromes (≈0.8 GB each) and the
desktop-view Chrome also resident.

| Working copy | Chrome processes | RSS |
|---|---|---|
| Plaud | 23 | 419 MB |
| Grant CS Lead | 25 | 375 MB |
| Henry | 7 | 173 MB |
| Avery | 10 | 170 MB |

Typical copy ≈ 285 MB, heavy copy ≈ 420 MB (RSS overstates by shared pages, so
these are upper-ish bounds). Projected working-copy total: 5 slots ≈ 1.4 GB typical
/ 2.1 GB heavy; 7 ≈ 2.0 / 2.9 GB; 8 ≈ 2.3 / 3.4 GB.

**Recommendation:** 7 is supportable with margin on this Mac even with the desktop
browsers running; 8 is marginal when Google Chrome and two desktop `agent_browser`
sessions are also open. This build keeps `MAX_ACTIVE` at 5. If the owner confirms,
set `VENEER_BROWSER_MAX_ACTIVE=7` in the installed launch agent and re-measure at
seven copies before considering 8. Since the sample was taken at four copies, not a
saturated seven, the confirmation should follow a measurement at seven.

## Tests

- browser-manager (49): per-project cap atomic across concurrent starts with the
  other project still admitted; agent ticket no longer blocks suspension while a
  pending viewer ticket does; existing warm-copy, admission and viewer tests.
- admission: project-capped head waiter does not block a later waiter.
- server (3075): turn-end release keeps the copy and reopens it; release defers to a
  pending turn, secret fill, capture and an unexpired hold; lapsed Keep open,
  legacy hold and old sign-in start all expire; uncertain action and missing
  history are released and flagged for review, never replayed; hold expiry
  clamped to two hours; capacity wait skips a project-capped row for another
  project; MCP `keep_open` requires a reason.
- web (916): panel shows project slots, hold end time and reason, and the turn-end
  explanation.

## Live verification (2026-09-29, after deploy at 14:21Z)

- Commit `1146be4`; typecheck, all four suites (server 3075, web 916,
  browser-manager 49, installer 29) and the build passed before restart. The
  detached restart died with this chat's turn after restarting web and runner;
  app-runner, terminal and the browser manager were restarted in the resumed
  turn with `npm run restart -- <service>`. All services healthy.
- Existing copies, read-only before any reclamation: Plaud (no turn, last used
  Sep 27), Grant (no turn, last used Sep 28), Henry (pending turn), Avery
  (stopped by its owner). No Keep open recorded on any of them, no viewer
  connected. The first sweep after restart suspended Plaud and Grant
  (`clone.idle_suspended` 14:22:55Z/14:22:56Z); their working copies remain on
  disk. Henry stays running with reason `active_turn`. One warm copy is running
  and is not counted.
- Capacity from this chat (project Veneer): `1/5` machine, `0/2` this project
  before open; after `open` `2/5` and `1/2`. A second project opened a browser
  while ERVP held a slot, without waiting.
- Turn-end release observed live (audit `clone.turn_end_suspended`): this
  chat's copy paused at 14:24:12Z, 44 seconds after its last command, and
  Henry's paused at 14:24:09Z when its turn ended. Both rows went to `stopped`
  with the working directory intact (this chat's copy: 95 MB of Chrome profile
  data plus its downloads folder still on disk). Avery reopened its copy in the
  same minute and was correctly retained as `recent_activity` while active.
- The test copy was then deleted with an explicit `stop`; capacity read `0/5`
  and `0/2` for this project afterward. No test copy is left running.

## Limits

Five browsers still run at once, two per project. Five truly simultaneous browser
tasks, or three in one project, queue (20 seconds in the manager, then a durable
continuation for bot Opens). In-memory page state between turns is lost unless
`keep_open` was called. This build does not raise the slot count.
