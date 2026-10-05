# Build 580 — callable Codex pre-auth host and fixture transport

The staged implementation now boots a **fixed native Codex app-server** before
sign-in, verifies its effective credential/configuration state, materializes
authenticated isolated synthetic session lineage and invokes a closed fixture
stdio peer with durable intent/UNKNOWN fencing. It is executable software, not
a preparation ledger or direct model API shortcut.

This commission stops before threads, inference, actual login, enrollment or
customer effects. Device sign-in setup returns execute:false. The unchanged
fixture /start gate always denies admission. Source remains staged: no
installation, deployment, restart or rollout was performed.

Queue #580 was verified running in the Veneer workspace before edits. This was
the sole source editor, with no successor/handoff or other bot eviction. ERVP
source and its protected commits were not changed.

## Native host and measured protocol

The selected installed official native executable is codex-cli **0.145.0**,
SHA-256 1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590.
The fixed path comes from the official npm wrapper's native target. Using that
native target avoids granting wrapper subprocesses; it is the supported native
runtime, not a direct provider client.

[Final raw acceptance](./acceptance-final.json) contains actual profile and
source hashes, public linked resources, PID canary results, native process
startup/RPC/exit timestamps, same-policy denial results and a synthetic peer
round trip. Only initialize, account/read(refreshToken:false) and config/read
were sent. Both private worker and dedicated-auth hosts initialized, returned
account:null/requiresOpenaiAuth:true, and verified their effective ephemeral and
file credential stores respectively. No auth.json or native session tree was
created. No model catalog or entitlement was claimed.

Resource inventory lists 14 public System/usr-lib dylibs/frameworks. Unknown
non-System dependencies or executable hash drift block startup. The environment
is allowlisted with dedicated HOME/CODEX_HOME/TMPDIR, inherited FDs are closed
apart from controlled stdio, profile reads/writes are restricted to that home
and public runtime resources, and network/fork/subprocesses are denied.
Strict config prevents unrecognized overrides. Global requirements get exact
metadata permission only; an existing unreadable requirement is not silently
accepted. Raw stderr is discarded rather than logged.

Native SQLite startup exceeds the harmless harness's 1 MiB file limit. An
initial run failed with SIGXFSZ; the native-specific 32 MiB private file limit
permits startup, while CPU/FD/output/time budgets remain bounded. Version/help
bootstrap was investigated separately and never counted as model acceptance.

## Process-environment boundary repair

The old broad sysctl policy could inspect a deliberately synthetic sibling's
environment using KERN_PROCARGS2. Build 579's inherited-env and FD tests did not
cover this interface. No existing credential-bearing process was targeted.

The repaired shared profile permits public hw.* and fixed uname/version sysctls,
permits self process-info, and explicitly denies others process-info. The
unsandboxed and broad-policy positive controls return errno:0 and observe the
synthetic marker. The narrowed profile returns **EPERM** and observes no marker.
Each Codex setup runs this canary before native startup and fails closed if its
control or denial is absent. No environment bytes are printed or retained.

An intermediate policy that denied all process-info allowed a version probe
but trapped during actual app-server startup. The final self/others split and
public uname resources permit initialize/account/config RPC as well as the
actual environment denial. The initial conclusion that Seatbelt could not cover
this interface was too broad; the origin was explicitly corrected. A contemplated
OS-principal installer fallback was withdrawn before commit; no installer,
service-account provisioning or sign-in ran.

The same-policy C probes also observe EPERM for synthetic outside file/write,
symlink escape, live TCP/Unix sockets, self/other subprocesses and fork, with
positive controls proving access outside the sandbox. A separate fork-enabled
diagnostic child inherits file/TCP denial; that profile never admits work.
Cross-session file reads are denied, and the active launcher closes fd3 and
scrubs the inherited synthetic marker.

## Callable backend, transport and lineage

[Package instructions](/Users/archerclawdington/veneer-os/scripts/fixture-host/CODEX.md)
describe the owner-only /api/fixture-tests/codex-host setup, training, run,
fixture-tools and device-sign-in/setup endpoints. All bots, bot sessions and
employees are denied before process startup or publication. Native commands,
RPC methods, profiles, source paths, auth tokens and owner identity cannot be
supplied by the caller.

Authenticated human publication approves exact synthetic training bytes/version
and retains explicit publication provenance. The role conversation UUID is a
desired binding, not imported evidence or a verified historical training capture.
Each session gets separate native and transport homes; lineage binds the actual
CLI/launcher/profile/runtime hashes and snapshot content. Records/outcomes are
immutable and HMAC-authenticated with distinct lineage/capability domains.
Missing snapshot, scope/owner mismatch, source/profile/training drift and
symlink/hardlink aliases block. Keys remain in protected supervisor storage;
internal capabilities travel only over private stdio and are never logged or
returned. The stdio peer has no filesystem/network/process/business connector
imports or generic tool handler.

The closed registry supports synthetic order read, preference set, local sink
accept, unresolved handoff and cancellation/refund request. A preference is
durably stored and read back for its exact order/session; another session sees
no preference. Sink acceptance is an immutable local receipt with
carrierDelivery:null. Cancellation/refund return APPROVAL_REQUIRED/execute:false;
handoffs remain UNRESOLVED_HANDOFF. AutoShip SMS pause and proposed-hour
inactivity remain unchanged.

Intent is durable before any peer execution. Repeating identical input reads the
existing result without another invocation; changed payload conflicts. Removing
the outcome, losing a response or failing transport yields UNKNOWN and never
replays after repair or database reopen. Failed setup/materialization intents
are similarly fenced. No business DB, shared adapter, customer memory, browser,
Doppler, connector or real SMS transport is used.

These are actual supervisor-to-peer fixture round trips, **not actual model
dynamic-tool calls**. Native tool requests in pre-auth are rejected. Model builtin
behavior, protected inference egress and native dynamic-tool integration remain
separate acceptance work.

## Validation and raw results

- Typecheck passed: [final log](./typecheck-final.log).
- Scoped tests passed across native coupling, preparation gate/access, harmless
  host and fresh/resumed guide delivery: [scoped log](./scoped-final.log).
- Five Python acceptance tests pass, including real native config/protocol,
  synthetic controls/denials, source/resource drift, peer capability/closed
  registry/cross-scope rejection and process-environment repair:
  [final host log](./host-tests-final-two.log).
- Full root npm test passed: installer 29, server 3,423 (15 skipped), web 1,008, browser-manager 51: [full raw log](./full-tests.log).
- Root npm run build passed: [build log](./build.log). Vite emitted its chunk-size warning.
- Source/profile receipt hashes were read back and matched; whitespace checks passed for source/docs.
- No restart, deployment, installation, account provisioning or sign-in followed validation.

The full native coupling tests additionally prove signed-lineage tamper rejection,
durable duplicate/no-replay behavior across reopen, synthetic preference readback,
sink/cancel/refund/handoff semantics, owner/bot/employee restrictions, missing
material, profile/training alias/drift rejection and failed-bootstrap fencing.
Full tests cap Vitest fork/thread concurrency at two to reduce host contention,
without eviction or alteration of shared bots.

Earlier raw logs are retained as engineering history. native-first.json and
native-hardened.json record rejected bootstrap attempts; native-second.json is
an earlier broad-policy unauthenticated protocol result.
acceptance-preliminary.json predates the PID canary and is superseded by the
qualified final receipt. scoped-tests.log and host-tests-final.log contain the
failed initial assertion that the combined deny would still expose the marker;
the observed denial prompted the successful narrow policy investigation.
principal-plan.json/installer-scoped.log record an abandoned plan/test draft,
not installed or delivered OS-principal software. None establishes model/auth
acceptance or overrides the final blockers.

## Exact next coupling and minimal owner setup

ProtectedCredentialBoundaryReady remains **false**. Native 0.145.0's generated
external-token schema explicitly says internal/unsupported; it was not used.
Implement an approved native auth/refresh bridge from the dedicated supported
device-flow owner setup to the isolated worker, with no shared credential copy
or model-readable credential path, and accepted exact auth/inference egress
mediation. Current software reports PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED and
AUTH_INFERENCE_EGRESS_UNACCEPTED rather than granting login or model readiness.

Then couple actual native dynamic tool requests to the existing signed fixture
session and closed peer, bind the genuine permanent ordinary CS role-training
capture/readback receipt, and implement actual queue/admission/cutoff/UNKNOWN
telemetry and read-only monitoring. Missing role capture stays
permanentRoleChatCaptureVerified:false. No new worker persona or automatic
business authority was introduced.

No owner action is required now. After that concrete protected-auth/egress
implementation is accepted and separately installed, the minimal owner action
is supported device sign-in in the dedicated setup. No architecture choice,
duplicate business consent, builder sign-in or source enrollment is requested.
The 15 prepared native scenarios, 1/5/10 customer multi-turn/admission tests,
native startup/inference/tool/answer acceptance and real monitoring remain
pending. Native model/reply/carrier timing fields stay **null**; harmless/native
pre-auth measurements are not substitutes.

## Changed source, documentation and evidence

- [scripts/fixture-host/bootstrap.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/bootstrap.py)
- [scripts/fixture-host/README.md](/Users/archerclawdington/veneer-os/scripts/fixture-host/README.md)
- [scripts/fixture-host/CODEX.md](/Users/archerclawdington/veneer-os/scripts/fixture-host/CODEX.md)
- [scripts/fixture-host/codex.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/codex.py)
- [scripts/fixture-host/codex_test.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/codex_test.py)
- [scripts/fixture-host/peer.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/peer.py)
- [scripts/fixture-host/peer.cjs](/Users/archerclawdington/veneer-os/scripts/fixture-host/peer.cjs)
- [scripts/fixture-host/process-env-probe.c](/Users/archerclawdington/veneer-os/scripts/fixture-host/process-env-probe.c)
- [server/src/fixtureTests/codexSetup.ts](/Users/archerclawdington/veneer-os/server/src/fixtureTests/codexSetup.ts)
- [server/src/fixtureTests/routes.ts](/Users/archerclawdington/veneer-os/server/src/fixtureTests/routes.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/test/fixtureCodexSetup.test.ts](/Users/archerclawdington/veneer-os/server/test/fixtureCodexSetup.test.ts)
- [server/test/fixturePreparation.test.ts](/Users/archerclawdington/veneer-os/server/test/fixturePreparation.test.ts)
- [docs/sms-native-fixture-tests.md](/Users/archerclawdington/veneer-os/docs/sms-native-fixture-tests.md)

Final and preliminary raw artifacts (preliminary files are explicitly superseded above):

- [acceptance-final.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/acceptance-final.json)
- [acceptance-preliminary.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/acceptance-preliminary.json)
- [build.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/build.log)
- [full-tests.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/full-tests.log)
- [host-tests-final-two.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/host-tests-final-two.log)
- [host-tests-final.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/host-tests-final.log)
- [host-tests.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/host-tests.log)
- [installer-scoped.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/installer-scoped.log)
- [native-first.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/native-first.json)
- [native-hardened-two.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/native-hardened-two.json)
- [native-hardened.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/native-hardened.json)
- [native-second.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/native-second.json)
- [principal-plan.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/principal-plan.json)
- [report.md](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/report.md)
- [scoped-final.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/scoped-final.log)
- [scoped-first.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/scoped-first.log)
- [scoped-tests.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/scoped-tests.log)
- [typecheck-final.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/typecheck-final.log)
- [typecheck-first.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/typecheck-first.log)
- [typecheck-second.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/typecheck-second.log)
- [typecheck.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build580/typecheck.log)
