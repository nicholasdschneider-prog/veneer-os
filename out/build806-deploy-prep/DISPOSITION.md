# Veneer partial deployment, 2026-10-13: disposition for Nick

Status 2026-10-14. **No option below is deployment-ready.** No window is requested here.

## What happened

- On the evening of 10-13, web crashed on a network-library bug (88 times since 09-29) and launchd
  restarted it automatically.
- The restart loaded a newer build than the one approved for deployment, because building
  overwrites the files a restart loads. That build also added five database tables: two for purchasing recovery
  (migration 0178) and three for QBO (migration 0179). All are empty, verified
  unchanged since.
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
- `63d0ddb`: the activation step now refuses while any bot is mid-task or any browser is in use.
  It checks again right before reloading and undoes itself if that check fails. It can be limited
  to the five Veneer service jobs (web, runner, mini-app runner, terminal, web watchdog), leaving
  the browsers and the tunnel alone.

Until something is deployed in an approved window, web can still crash and come back on the same
10-13 build.

## Your options

1. **Hold.** Keep the current mix (web 10-13 build, old runner) while the repair evidence is
   reviewed. Nothing changes; the crash risk stays as it is now.
2. **A separately bounded maintenance window using the guarded activation**, after the open gates
   are reviewed. The plan is REPORT.md section 23.1.
   - It restarts five jobs: web, runner, mini-app runner, terminal and web watchdog. Open
     terminal sessions and local mini apps restart too.
   - It needs your own-words approval naming all 11 commits `f9c59dd..63d0ddb`, those five jobs,
     the window, and the accepted limitation.
   - Gate 1 is still UNMET: there is no verified way back to the old runner, because its bytes
     were never kept. Only you (or someone you verifiably authorize) can accept that
     limitation, in your own words. No bot can waive it. The BUILD801 owner assesses only the
     purchasing and UNKNOWN fences; the existing deployment owner (a6e39d6e) executes only the
     bounded plan you approve.
   - Gate 4 is also open: the QBO read check's own-session caller lookup is unverified.
3. **A checkout-mode restart (web and runner only, without the locked-copy fix).** This also needs
   its own exact, bounded approval: the commits, the two services and the window. It keeps the
   hazard that caused this incident: after it, any later build goes live the next time a service
   crashes, without approval. It is listed for completeness, not recommended.

No option is deployment-ready today.

Owner: Platform Dev a6e39d6e. Evidence: [REPORT.md](./REPORT.md), sections 13–23.
