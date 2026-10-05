# Build #578 — concrete native-host and authentication blockers

**The isolated native SMS runtime remains incomplete. No native provider was
started.** This continuation verified source ownership, refreshed the staged
boundaries and ran real, harmless OS bootstrap probes. It did not implement or
install the remaining native runtime, fixture transport, telemetry or monitoring
UI. Existing runtime source remains at commit `029a783`.

## Fresh ownership and authorization

`list_build_queue` reported **Veneer #578 running** before any validation.
Competitor chat `34ec3d8b-31c4-4a03-87dd-da702d513a3f` was idle and reported
skipping its own misrouted #576 with no edits or validation. No other queue item
was changed. The origin’s authenticated conversation was read at
`a57783f8-afbc-47e6-8da6-202fa6a5cc76`; its latest direction retains the test-only
boundary and the permanent ordinary CS training-chat requirement. No successor
chat, source editor, bot, human identity or source enrollment was created.

The original ERVP interface, playbook, scenario corpus and sandbox evidence
remain reference inputs. This build does not import the deterministic Python
responder as an agent or copy it into the platform runtime. No ERVP source
change occurred; commits `46433b56` and `271daa86` remain present.

## What the actual OS probes establish

Only `/usr/bin/true` ran, with either an empty environment or explicitly
scrubbed PATH/HOME/TMPDIR/LANG. The latter HOME/TMPDIR were disposable fixture
paths, not login or service homes. Output was captured and additional file
descriptors closed. No credential value was read or passed. No actual secret,
business file, keychain, browser, business socket or external network target
was probed.

| Probe | Observed result | Interpretation |
| --- | --- | --- |
| Unsandboxed, empty environment | exit 0 | Harmless executable works |
| Unsandboxed, scrubbed environment | exit 0 | Environment control works for this executable |
| Seatbelt allow-default, empty environment | exit 0 | Sandbox launcher is usable |
| Seatbelt allow-default, scrubbed environment | exit 0 | Launcher also works with scrubbed environment |
| Minimal deny-default profile | SIGABRT, no output | Tested restrictive bootstrap fails |
| Deny-default plus runtime basics | SIGABRT, no output | Added tested allowances do not resolve failure |
| Deny-default plus Mach lookup control | SIGABRT, no output | This tested control still fails |
| Deny-default with broad file/process allowances | exit 0 | Permissive diagnostic control works; unsuitable isolation |
| Deny-default with system file paths | SIGABRT, no output | Tested filesystem restriction still fails |
| Deny-default with process-exec* and system paths | SIGABRT, no output | Tested execution/filesystem profile still fails |

The broad successful profile is a **diagnostic control, never an accepted model
profile**. None of these results proves forbidden file/network/process/credential
access is denied. They do not prove that Seatbelt, macOS or the kernel is broken,
or that a suitable profile is impossible. The exact missing resource or abort
cause was not established. No provider-compatible profile was tested. Even
standard-descriptor inheritance needs its own accepted host audit; these
harmless bootstrap controls are not that audit.

`vfkit`, `limactl`, `qemu-system-aarch64`, `podman` and `docker` were absent from
PATH. This does not exclude installations elsewhere. Nothing was installed or
removed. A VM is one possible boundary, not a required purchase established by
these probes.

[Raw observed controls and full follow-up profile strings](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build578/isolation-probe.json)

The design constraint is consistent with Chromium’s documented sandbox approach:
it enumerates resources before loading application frameworks and notes that
more permissive profiles trade away security. That is an engineering reference,
not acceptance of any profile tested here.
[Chromium Mac Sandbox V2 design](https://chromium.googlesource.com/chromium/src/+/main/sandbox/mac/seatbelt_sandbox_design.md)

## Authentication cannot be borrowed from ordinary sessions

The current native sign-in code was inspected without starting it or reading
any account credential:

- [Codex device authentication](/Users/archerclawdington/veneer-os/server/src/codex/deviceAuth.ts) stages a human sign-in and normally adopts it into the ordinary account registry. Its source warns that starting login against an existing home deletes that home’s auth file. No login attempt was made.
- [Claude setup-token flow](/Users/archerclawdington/veneer-os/server/src/claude/setupToken.ts) supplies ordinary provider authentication through a human-driven flow and shared service context. No token flow was started.
- The [staged fixture gate](/Users/archerclawdington/veneer-os/server/src/fixtureTests/readiness.ts) has no accepted isolated host, fixture authentication registry or native fixture transport. Ordinary sign-in capability is not an accepted nonshared fixture boundary.

This finding concerns the supported fixture path. No inventory of stored
credentials was read, and this report does not claim that no provider account
exists elsewhere. The commission forbids acting as the human, borrowing
credentials and making shared secrets readable to the fixture process. An
authenticated fixture identity therefore cannot be manufactured by this agent
or inferred from the normal owner account.

## Exact prerequisites before any native session

1. **Working, constrained provider bootstrap:** implement and test an OS-enforced
   host around the selected native provider and every descendant, with exact
   executable/version/profile hashes. Supply a resource inventory that permits
   necessary runtime libraries but denies unrelated files, login/service homes,
   business data, keychain, shared IPC, arbitrary processes and inherited
   capabilities. Prove allowed synthetic reads work and forbidden attempts
   fail. The aborting profiles above cannot be installed as this host; broad
   diagnostic allowances cannot be promoted to it.
2. **Nonshared native sign-in within that host:** an actual authorized human must
   complete the existing approved provider mechanism in a dedicated protected
   identity after host enforcement exists. Bind the selected provider account
   and credential boundary to the fixture principal. No shared-home copy,
   pasted/exported token, owner impersonation or model-readable secret file.
   This commission’s human-enrollment prohibition remains in force.
3. **Closed provider-only egress and isolated tool transport:** implement and
   accept a mediated provider path plus an authenticated synthetic fixture
   channel. Prove arbitrary destinations, loopback business APIs, DNS/redirect
   bypasses, browser/Doppler/shell/shared-agent tools and customer memory cannot
   be reached. Backend tools must validate exact run/session/customer/order and
   material revisions; a hidden tool list or caller attestation is insufficient.
4. **Materialized approved role training:** bind exact approved shared CS
   playbook bytes/version and fixture profile to the run, separate from each
   customer’s history. The product-context playbook is a proposed design, not
   standing business authority. Preserve cancellation/refund human gates,
   AutoShip SMS pause and the inactive proposed hour window.
5. **Accepted native lifecycle and evidence path:** implement native session
   association, durable capped 1/3/5 admission, serialized customer turns,
   immutable effect intents and terminal/UNKNOWN reconciliation. Do not retry
   uncertain model/tool/sink effects under another key. Add observed queue,
   provider/model, tool, substantive reply, mutation readback and sink events,
   with authenticated lineage and compatible clocks. No hidden reasoning or
   private data. Sink acceptance never establishes carrier delivery.
6. **Read-only native monitoring and acceptance:** implement observed unanswered
   age, p50/p95/max with failed/unanswered totals, duplicates/wrong-order effects,
   handoffs and unsupported-success review. Then run all 15 native scenarios
   and the requested cold/warm/busy-owner/failure/429/cutoff/concurrency matrix.
   The current synthetic preparation timeline is not that native monitor.

These are unresolved implementation/materialization and identity prerequisites,
not missing customer business consent. No new business approval is requested.
No exact accepted native profile or enrollment receipt exists in this staged
fixture interface to redeem. Restarting the current source would only install
the existing blocked preparation routes; **deployment alone cannot make this
experiment executable**. No deployment or restart was authorized or performed.

The permanent ordinary CS training chat and shared role-level playbook remain
requirements, not installed capabilities. Workers must consume pinned guidance
with isolated customer histories; routine training should not require a
development thread. No bot/training enrollment was performed in this build.

## Validation and missing measurements

The unchanged fail-closed preparation/API and guide tests were rerun under Node
24: **52 passed** (21 fixture, 31 guide).
[Guard test output](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build578/guard-tests.log)

Only diagnostic artifacts were created. No software source, dependencies,
schema, deployment configuration or executable automation was changed, so
root typecheck/full tests/build were not repeated. Their #577 results remain
historical evidence, not new #578 execution measurements.

Actual native runs: **0**. Provider/model startup, tool round trips, substantive
reply, mutation readback, sink acceptance, latency percentiles and carrier
delivery remain **null**. All 15 native scenarios and the nine requested
customer/admission combinations remain **unrun**. Cold/warm/busy-owner/failure/429/
cutoff races are not evaluated against a real agent. The harmless `/usr/bin/true`
probe durations are OS diagnostic timings, never agent latency. No concurrency
or customer-experience readiness is claimed.

[Preserved #577 implementation and test report](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/report.md)
[Preserved staged interface and full engineering requirements](/Users/archerclawdington/veneer-os/docs/sms-native-fixture-tests.md)
[Preserved pending native scenario results](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/native-results.json)

No live customers/SMS, production order or financial mutation, vendor
submission, postage, shared credential access, source/human enrollment,
provider session, restart, eviction or rollout occurred. Unrelated work is
preserved. The originating Assistant receives this blocker evidence directly.
