# Veneer partial deployment, 2026-10-13: disposition for Nick

Status 2026-10-14. **No option below is deployment-ready.** No window is requested here.

## What happened

- On the evening of 10-13, web crashed on a network-library bug (88 times since 09-29) and launchd
  restarted it automatically.
- The restart loaded a newer build than the one approved for deployment, because building
  overwrites the files a restart loads. That build also added two database tables (empty, verified
  unchanged since).
- Web now runs the 10-13 build (`155b497`, pid 98183) and the runner still runs older code
  (pid 34641). Nobody approved this mix.
- The exact code the services ran before is gone and cannot be rebuilt with certainty, so there is
  no verified way back to it (gate 1).

## What has been repaired (source only, not installed)

- `929ae3e`: the crash itself. That network error now fails one request instead of the whole web
  service.
- `9b6424e`:
  - The same crash fix for the browser manager.
  - Once activated, services restart from a locked copy of the approved build. A later build can
    no longer slip in on a crash, and the previous copy is kept for rollback.
  - Activating it reloads every Veneer background job, not only web and runner.

Until something is deployed in an approved window, web can still crash and come back on the same
10-13 build.

## Your options

1. **Hold.** Keep the current mix (web 10-13 build, old runner) while the repair evidence is
   reviewed. Nothing changes; the crash risk stays as it is now.
2. **Plan a separately bounded maintenance or recovery window** after the open gates are reviewed.
   - Gate 1: no verified way back to the old runner. The BUILD801 owner must decide whether to
     accept that limitation.
   - Gate 4: the QBO read check caller's transport is unverified.
   - That window would need your own-words approval naming all 10 commits `f9c59dd..9b6424e`, the
     services restarted (all Veneer jobs if the release fix is activated), and the accepted
     limitation.

Owner: Platform Dev a6e39d6e. Evidence: [REPORT.md](./REPORT.md), sections 13–20.
