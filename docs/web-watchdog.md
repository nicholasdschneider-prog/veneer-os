# Web polling overload prevention

The October 7 incident overloaded the synchronous web event loop with repeated full decision hydration. Build #632 reduced that work; build #635 adds regression coverage, bounded polling and independent observation.

The question desk and server background loop already prevent overlapping passes. Call polling now allows one request at a time, aborts after 15 seconds and aborts on unmount. The Bots screen shares one in-flight overview/detail read within the same component and exact filter/business/focus/decision scope, pauses periodic reads while hidden, and cancels old reads for explicit refreshes after edits. Completed results and execution authority are never cached.

`server/test/decisionPollingLoad.test.ts` seeds 540 historical decisions, 18 waiting questions, three viewers, six bots and discussion/answer history. It limits SQL preparation and reads, verifies history growth does not increase detailed question hydration, and checks access revocation, stale evidence, answers and fair rotation. Timing is measured separately to avoid flaky wall-clock test gates. Call polling continues in hidden tabs so incoming call behavior is preserved:

```sh
node --import tsx scripts/decision-polling-benchmark.mjs
```

A post-suite run measured median 8.1 ms, p95 16.7 ms and full overview 98.5 ms; 30 snapshots plus the overview used 390 ms CPU over 359 ms wall time. The benchmark uses only synthetic in-memory data and prints median/p95 snapshot latency plus total CPU and wall time. On this Mac, healthy-load acceptance is median below 25 ms, p95 below 100 ms and full overview below 150 ms. Deterministic query-count limits remain the release gates; concurrent test workloads can distort time measurements.

## Independent monitoring

`com.veneer.web-watchdog` is a separate Node 24 launchd process. It does not depend on the web event loop, credentials or the runner’s availability to collect evidence. It probes loopback health every 30 seconds with a three-second deadline, records attributable process CPU and event-loop p99 delay from a small atomic diagnostic file, and retains 120 sanitized observations in SQLite. CPU attribution requires the advisory PID to own the loopback listening socket, with unchanged process start time between samples. Missing or stale telemetry stays unknown. It stores no response bodies, browser data, process arguments or credentials.

A bad observation is failed health, latency at least 1.5 seconds, CPU at least 85%, or event-loop delay at least 250 ms. Three consecutive bad observations trigger a durable native wake in the enrolled repair chat. Recovery requires three consecutive good observations with independently attributed PID, finite CPU and fresh loop telemetry. Missing, stale, malformed or unattributed measurements reset the recovery streak and leave an open incident unresolved; a known bad measurement still counts even when another metric is unknown. HTTP-reported PID and loop values cannot substitute for the collector's independent attribution. Alert state and wake creation commit together; there is one alert per incident and a ten-minute cooldown between incident alerts. Duplicate observations within 20 seconds and gaps over 90 seconds cannot build a false consecutive streak. No services are automatically restarted and no bots are canceled.

Sample persistence and repair-chat binding reserve SQLite's write lock before reading state, with a one-second busy timeout in the collector and installer. This avoids the deferred read-to-write upgrade race in WAL mode. A failed sample write rolls back the sample, state and notification together; there is no immediate retry or replay. The next scheduled pass collects a new observation. Sample failures log only the fixed categories `busy`, `locked` or `other`, never exception messages, SQL or private values. Tests use two independent connections to an isolated WAL database to exercise lock contention and rollback at notification creation.

Platform Dev installs or rebinds it after typecheck, scoped/full tests and build:

```sh
node installer/install-darwin.mjs --web-watchdog-only \
  --data-dir /absolute/path/to/data --port 3100 \
  --watchdog-chat EXACT_PLATFORM_DEV_CHAT_ID --watchdog-owner EXACT_OWNER_ID
```

Add `--dry-run` to validate ownership and print only the nonsecret watchdog plist. The targeted path reloads only the watchdog, with no provider provisioning or runner/web/browser/terminal restarts. Full Mac installs also provision the observer; its repair recipient still needs explicit binding. Rebinding an open incident to another owner/chat is refused.

The dedicated maintenance chat must remain unarchived and its owner active. The incident/build chat can be archived independently. If the maintenance chat is archived or ownership becomes invalid, samples remain but wakes are blocked. A stopped runner delays native wake delivery. Recovery confirms measured health, not completion of a customer action. Logs are in `~/Library/Logs/veneer-pro/veneer-web-watchdog.log`.

Simulation tests use an isolated database and the actual native wake scheduler with a fixture receiver. They verify durable incident deduplication, recovery, bounded retention and inaccessible-owner failure. They never overload the live Mac or dispatch business actions. The feature guide is available to ordinary and focused employees; resumed agents receive the same capability and safety limits.

## October 7 recovery hardening (build #639)

Incident `58f0db86-c7be-4320-a3ea-ffa540c88848` opened at 17:02:14Z after loop delay of 315.1 ms, a 3.07-second health timeout during a web PID transition, and loop delay of 422.1 ms. The last-120 query initially returned only 15 observations because monitoring had just started. It recovered at 17:04:15Z after three complete healthy samples on the same web PID; the final sample measured 120.9 ms latency, 32.5% CPU and 124.5 ms loop delay. This was valid measured recovery. The root cause of the transient distress remains unproved, and it does not establish the outcome of any business action.

The observer also missed a sample and logged a generic persistence failure. No exception category was retained, so that historical failure cannot be conclusively attributed. A later watchdog-only installation encountered `SQLITE_BUSY` during repair-chat binding and stopped before any reload. Build #639 therefore reserves the write lock for both binding and sample persistence, and adds fixed sample-failure categories for future diagnosis. It also prevents future missing metrics from counting toward recovery. No customer effects, active-turn cancellation or broad service restart are part of this repair.

Validation passed on Node 24: root typecheck, all 30 installer tests, 3,763 server tests (15 skipped), 1,013 web tests, 51 browser-manager tests and the root production build. The seven watchdog tests include independent WAL writers, atomic rollback at notification creation, unknown recovery metrics and stale telemetry. Employee and resumed-agent guide checks passed in both instruction modes.

At 18:08:18Z the scoped installer successfully reloaded only the independent watchdog with the unchanged maintenance binding. Before/after web, runner, app-runner, terminal and browser-manager PIDs were identical (82720, 81930, 82007, 82021 and 82024). Its next retained sample at 18:08:48Z measured healthy HTTP, 4.5 ms latency, 36.0% CPU and 124.3 ms loop delay, with no open incident. The [watchdog plist](/Users/archerclawdington/Library/LaunchAgents/com.veneer.web-watchdog.plist) points to this checkout's built observer. The updated employee/resumed-agent catalog is built and tested but remains pending the next separately authorized web/runner restart; this repair does not restart those services to activate guide copy.

## Implementation files

- [Mac installer](/Users/archerclawdington/veneer-os/installer/install-darwin.mjs), [targeted watchdog installer](/Users/archerclawdington/veneer-os/installer/web-watchdog.mjs), [installer tests](/Users/archerclawdington/veneer-os/installer/web-watchdog.test.mjs), [launchd template](/Users/archerclawdington/veneer-os/deploy/launchd/com.veneer.web-watchdog.plist).
- [Watchdog policy and durable notifications](/Users/archerclawdington/veneer-os/server/src/ops/webWatchdog.ts), [independent process](/Users/archerclawdington/veneer-os/server/src/ops/webWatchdogMain.ts), [storage migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0158_web_watchdog.sql), [loop telemetry](/Users/archerclawdington/veneer-os/server/src/ops/webLoopMetrics.ts), [background registration](/Users/archerclawdington/veneer-os/server/src/botWorkflows/background.ts), [feature guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts).
- [Watchdog tests](/Users/archerclawdington/veneer-os/server/test/webWatchdog.test.ts), [decision-load regression tests](/Users/archerclawdington/veneer-os/server/test/decisionPollingLoad.test.ts), [synthetic history fixture](/Users/archerclawdington/veneer-os/server/test/fixtures/decisionLoad.ts), [load benchmark](/Users/archerclawdington/veneer-os/scripts/decision-polling-benchmark.mjs).
- [Employee and resumed-agent watchdog guide checks](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts).
- [Bounded reads](/Users/archerclawdington/veneer-os/web/src/lib/boundedRead.ts), [bounded-read tests](/Users/archerclawdington/veneer-os/web/src/lib/boundedRead.test.ts), [Bots screen](/Users/archerclawdington/veneer-os/web/src/screens/Bots.tsx), [read API](/Users/archerclawdington/veneer-os/web/src/lib/bots.ts), [call polling](/Users/archerclawdington/veneer-os/web/src/components/BotCalls.tsx).
