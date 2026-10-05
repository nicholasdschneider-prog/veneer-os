# Build #577 — SMS native test preparation

**The commissioned isolated native fixture runtime is incomplete.** This commit
stages a preparation ledger and fail-closed admission boundary. It cannot run a
model or support Nick’s customer walkthrough. No actual native scenario or reply
latency has been measured. No deployment or production restart occurred.

## Verified implementation

- Human-owner-only API after existing identity and employee boundaries; bot
  tokens, including owner-backed tokens, cannot prepare runs.
- Separate SQLite preparation ledger with immediate transactions, FULL
  synchronous durability, immutable owner-bound requested manifests and stable
  input receipts. Retries reconcile existing receipts; changed input or scope
  fails. Scope, lifetime, customer, per-session turn and pending-run caps apply.
- Immutable correlated preparation traces with UTC/monotonic/process-clock IDs
  and event hash chains. No native telemetry ingestion or executable profile
  upload endpoint.
- Read-only monitoring JSON with real preparation input receipts and unanswered
  age. Reply, mutation, sink, handoff, wrong-order/duplicate effect and carrier
  observations stay null. Native failures/timeouts/UNKNOWN counters are zero
  because no native turns exist; blocked/unanswered totals are separate.
- Unconditional HTTP 503 at `/start`; no shared adapter, direct provider,
  credential, memory, browser, shell, connector or business effect path. Hashes
  do not attest that a profile/training manifest was materialized.
- Storage rejects directory/file symlinks (including dangling links) and
  hard-linked databases. Denied attempts preserve target bytes.
- Staged feature guide states these limits for humans and fresh/resumed agents;
  no new-feature announcement or active customer capability is advertised.

This proves the preparation lane cannot dispatch a business effect or model. It
does **not** prove isolation of a native model process: no such process exists
in this implementation. SQLite immutability is application-level protection,
not protection against a filesystem administrator. Supplied fixture text remains
untrusted synthetic test data; ID validation cannot detect all private text.

## Blocking engineering and installation prerequisites

The ordinary Codex adapter uses shared credential homes and adds a host browser
tool; the ordinary runtime can continue after toolbox materialization failure.
Those paths cannot be used for this experiment. The four readiness codes are:

- `ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE`
- `NONSHARED_PROVIDER_AUTH_UNAVAILABLE`
- `FIXTURE_ONLY_NATIVE_TOOL_TRANSPORT_UNAVAILABLE`
- `PINNED_TRAINING_PROFILE_NOT_MATERIALIZED`

The OS-enforced provider/descendant process boundary, approved isolated native
authentication, provider-only network mediation, fixture-only backend/transport,
pinned real training, native-session lifecycle/admission/UNKNOWN reconciliation,
observed telemetry and browser monitoring UI remain to be implemented and
accepted. Deployment alone will not enable them. `sandbox-exec` is present on
PATH; vfkit, Lima, QEMU, Podman and Docker are absent from PATH. This presence
check neither attests sandbox enforcement nor excludes software elsewhere. No
virtualization software, OS principal or credential was installed or enrolled.

[Exact staged API contract and seven prerequisite steps](/Users/archerclawdington/veneer-os/docs/sms-native-fixture-tests.md)

## Validation and raw results

Node **24.21.0** was selected through `/opt/homebrew/opt/node@24/bin`; the default
shell Node 22 executable failed to launch because a Homebrew simdjson library is
missing. No runtime/tool installation was changed to work around that.

- Root typecheck: passed.
- Focused fixture/API and guide tests: **52 passed** (21 fixture preparation,
  31 guide contracts). The 1/5/10 × 1/3/5 matrix tests preparation only; every
  start remains blocked. It is not an actual native admission/load test.
- Root full `npm test`: passed, installer **29**, server **3,417** with **15
  skipped**, web **1,008**, browser manager **51**. This run preceded the last
  storage-alias regression test.
- Final server suite after the storage guard/test: **3,418 passed, 15 skipped**,
  272 files, `--maxWorkers=2 --minWorkers=1`. Assertions and source in other
  areas were not changed.
- Two intervening default-worker server reruns failed: one desktop-message test
  timed out at 20 seconds, then a different Codex mock-process cleanup returned
  `ENOTEMPTY`. Both logs are retained. Desktop’s 17-test focused recheck and
  the final complete server rerun passed. Earlier independent validation also
  passed both tests. Their causes were not established.
- Root build: passed. Vite reported its large-chunk advisory; no build error.
- Source/JSON/report whitespace checks: passed. Verbatim raw logs retain their
  original blank EOF lines and one trailing-space diagnostic excerpt; Git
  flags that formatting. No production restart is authorized.

[Native results](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/native-results.json)
retains the source corpus hash, all **15 scenarios**, all nine native
customer/admission combinations with five requested repetitions, and
cold/warm/busy-owner/failure/429/cutoff/STOP-UNKNOWN conditions as
**NOT_RUN_ISOLATION_BLOCKED**. Actual admissions and native measurements are
null; actual native runs are zero. No sink receipt or carrier delivery exists.

### Evidence files

- [Actual blocked preparation trace](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/preparation-trace.json) — captured from the built ledger, duplicate reconciliation and failed admission, with no native run and unmaterialized profile/training.

- [Root full tests](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/full-tests.log)
- [Final server tests](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/final-server-tests.log)
- [Focused fixture and guide tests](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/targeted-tests.log)
- [Typecheck](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/typecheck.log)
- [Build](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build.log)
- [Desktop timeout rerun](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/failed-server-rerun.log)
- [Codex cleanup failure rerun](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/failed-server-cleanup-rerun.log)
- [Desktop focused recheck](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/desktop-recheck.log)

### Changed source

- [Readiness/admission gate](/Users/archerclawdington/veneer-os/server/src/fixtureTests/readiness.ts)
- [Preparation ledger and monitoring](/Users/archerclawdington/veneer-os/server/src/fixtureTests/store.ts)
- [Owner-only HTTP routes](/Users/archerclawdington/veneer-os/server/src/fixtureTests/routes.ts)
- [Authenticated API mounting](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [Staged capability guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Preparation/identity/storage tests](/Users/archerclawdington/veneer-os/server/test/fixturePreparation.test.ts)

## Ownership and preserved scope

Before edits, the fresh queue showed only #577 running. Conflicting #575 was
already absent; its owning chat c87aa0eb-1bcb-45b8-9f8a-b04a09f05451 was idle and
reported removing its own job with no edits/native sessions. This chat did not
skip another chat’s job. Initial source head was a2589ea.

The origin’s coordination lane independently ran read-only validation,
confirmed no source edits/build/commit/deploy/restart/models, and is now idle.
This chat retained sole editor/commit ownership. No bots were evicted or
restarted for test capacity.

ERVP source was read only; protected commits 46433b56 and 271daa86 are still
present. No ERVP commit was pushed or edited. Unrelated `.veneer`,
`.veneer-browser` and `out` work is preserved and excluded from this commit.
Current cancellation/refund approval gates, the inactive proposed hour window,
AutoShip SMS pause, customer ownership and production state are unchanged.
No live SMS, vendor submission, postage, financial effect, human source
enrollment, rollout or product restart was performed.
