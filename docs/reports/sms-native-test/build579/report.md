# Build 579 — constrained harmless native bootstrap

This milestone implements a working default-deny Seatbelt launcher for fixed
harmless C and Node 24 processes on macOS arm64. Successful bootstrap and actual
denials are recorded together. It is not another preparation ledger and it does
not start a provider or model.

Build #579 was verified running in the Veneer queue before changes. This chat was
the sole editor. Existing staged work through dc22c3d is preserved; the previous
misrouted competitors were idle/withdrawn per the current root commission.
No ERVP source changed, no successor/handoff was created, and no shared bot was
stopped or evicted for capacity.

## Observed results

[Raw receipt](./acceptance.json) captures 2026-10-05T18:45:47.215087Z through
18:45:48.016970Z on Darwin arm64. It pins source, executable, profile and 20 actual
Node runtime executable/library hashes. Temporary paths in profiles are
synthetic workspaces, not credentials. Receipt hashes bind reproducible evidence;
they are not a service-authenticated native run manifest.

| Process/profile | Actual exit | Measured elapsed | Observation |
| --- | ---: | ---: | --- |
| Unsandboxed synthetic C control | 0 | 165.021 ms | Target file/write/symlink, live TCP/Unix sockets and both spawn controls accessible; synthetic fd3 and environment marker present |
| Active C default-deny | 0 | 25.400 ms | Bootstrap and private read/write work; outside read/write/symlink, TCP/Unix, self/other spawn and fork return EPERM; fd3 closed and parent marker absent |
| Same C profile without literal root read | -6 (SIGABRT) | 27.073 ms | Launch failure only; never counted as enforcement |
| Fork-enabled diagnostic C profile | 0 | 10.957 ms | Child inherits file/TCP denials; fork is permitted only in this diagnostic, and same-executable spawn consequently succeeds |
| Active Node 24 default-deny | 0 | 76.533 ms | Node 24.21.0 boots; private read/write work; outside read/write/symlink, TCP/Unix, self-spawn and shell-spawn return EPERM |

These are measured harmless process durations, not model/reply/SMS latencies.
The sockets were genuinely listening on synthetic loopback/Unix endpoints:
EPERM is not inferred from a missing server. A forbidden outside write remains
absent after sandboxed runs, and the synthetic secret canary is unchanged.
The diagnostic child's return status attests file/TCP denial inheritance; it is
not the active admission policy.

Adding read permission for the **literal root directory** fixes the restrictive
SIGABRT with a one-rule A/B difference. It does not grant descendant reads.
The evidence identifies a reproducible omitted bootstrap resource, not the
precise internal dyld syscall. Node additionally needs exact public dylib aliases,
symlink intermediates and literal ancestor reads for dyld resolution, plus
workspace ancestor metadata. A private empty OpenSSL config prevents a shared
config read. Unknown non-System dependency forms fail closed.

## Enforced launch boundary

The fixed package accepts only a new receipt output path, never a provider
command, arbitrary network destination, caller profile or credential material.
Default-deny profiles grant no network or active process-fork access.
The launcher scrubs the environment, uses private HOME/TMPDIR and directories,
closes inherited descriptors, ignores stdin and captures output in newly created
private files. Limits: no core dumps, eight seconds CPU, ten seconds elapsed per
child, 64 descriptors, 1 MiB file size and 16 KiB accepted output per stream.
Temporary artifacts/sockets are removed on completion.

This assumes a trusted OS, owner account, source and public toolchain/runtime.
Public System/usr-lib code and specific public Homebrew libraries remain readable.
It does not claim protection from privileged administrator tampering or universal
file unreadability. No shared credentials, business target or connector was
accessed by the probes. Repository tests use their normal synthetic fixtures.

## Reproduce and prerequisites

See [package instructions](/Users/archerclawdington/veneer-os/scripts/fixture-host/README.md).
The current development host already has macOS arm64, sandbox-exec, Xcode
Command Line Tools clang/otool, Python standard library and public Homebrew
Node 24. No new host installation or owner action is needed for this milestone.

Run from the checkout:

```sh
python3 scripts/fixture-host/bootstrap.py --receipt docs/reports/sms-native-test/new-host-receipt.json
python3 scripts/fixture-host/bootstrap_test.py -v
```

An existing receipt cannot be overwritten. Bootstrap aborts, absent/invalid
observations, unsupported hosts, missing controls, incorrect denial results,
output overflow or timeout produce no accepted receipt.

## Validation

- Six Python tests passed, including actual C/Node bootstrap, every required
  denied-result tamper, missing positive controls, descendant failure,
  environment/descriptor boundary failures, unsupported host, abort/ack rejection,
  scrubbed environment and receipt overwrite refusal:
  [raw host tests](./host-tests.log).
- Scoped server tests: 53 passed across host bootstrap, preparation admission/
  manifest/receipt/access guards, and guide delivery:
  [raw scoped tests](./scoped-tests.log).
- Root typecheck passed: [raw typecheck](./typecheck.log).
- Full root npm test passed: installer 29, server 3,419 (15 skipped), web 1,008, browser-manager 51; [raw full tests](./full-tests.log).
- Root npm run build passed; [raw build](./build.log). Vite emitted its chunk-size warning.
- No restart, installation, deployment or model start followed validation.

The existing preparation test verifies staged guidance reaches fresh/resumed
agent instructions and retains employee route denial. The feature guide describes
the fixed harmless package and keeps the provider host unavailable.

## Next coupling scope and owner setup

Keep /start unconditionally denied; this build adds no toggle or bypass.
The next implementation must couple this proven process boundary to a fixed,
inventoried native provider command and a dedicated, approved nonshared
authentication mechanism. The actual provider's resource/auth requirements
must be tested without broadening access to shared homes, credentials,
connectors, shell, browser or arbitrary destinations. A provider startup failure
must remain a failed bootstrap; the harmless Node result cannot certify it.

Implement a fixture-only transport peer started by the trusted supervisor, with
an authenticated per-run/session capability and a closed synthetic tool registry.
The native worker must receive only its bounded transport and isolated history,
not a normal shared MCP bundle. Persist immutable authenticated run/training/
profile lineage before process start; reject absent or mismatched materialization.
Bind the same pinned role-training snapshot from the permanent ordinary CS role
conversation to each isolated customer history. Preserve cancellation/refund
human approval, proposed hour-window inactivity and AutoShip SMS pause.

Then couple actual queue/admission and provider startup/output/tool/substantive
reply/readback/local-sink telemetry to durable input receipts and safe UNKNOWN
reconciliation. Implement read-only monitoring over those real traces; carrier
delivery cannot be inferred from sink acceptance. Admission/concurrency and
the prepared 15 scenarios remain unrun; model, reply, SMS-sink and carrier
measurements remain **null**, not these harmless bootstrap durations.

No owner action is required now. After the dedicated provider/auth/transport
setup is concretely implemented and pre-auth isolation evidence accepted, the
minimal owner action is the provider's supported sign-in in that dedicated
setup. Never copy shared credentials, impersonate the owner, sign in as builder
or request duplicate business consent. A separately authorized deployment is
still necessary to install any eventual application/runtime coupling.
This report does not authorize it.

## Changed files

- [Launcher](/Users/archerclawdington/veneer-os/scripts/fixture-host/bootstrap.py)
- [C probe](/Users/archerclawdington/veneer-os/scripts/fixture-host/probe.c)
- [Node probe](/Users/archerclawdington/veneer-os/scripts/fixture-host/node-probe.cjs)
- [Host tests](/Users/archerclawdington/veneer-os/scripts/fixture-host/bootstrap_test.py)
- [Package instructions](/Users/archerclawdington/veneer-os/scripts/fixture-host/README.md)
- [Server test integration](/Users/archerclawdington/veneer-os/server/test/fixtureHostBootstrap.test.ts)
- [Staged feature guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Fixture test documentation](/Users/archerclawdington/veneer-os/docs/sms-native-fixture-tests.md)
- [Report](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/report.md)
- [Acceptance receipt](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/acceptance.json)
- [Host test log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/host-tests.log)
- [Scoped test log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/scoped-tests.log)
- [Full test log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/full-tests.log)
- [Typecheck log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/typecheck.log)
- [Build log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build579/build.log)
