# BUILD804 native QBO phases, observations and private transport

Implemented native-only; source integration and accounting acceptance remain unavailable. No production restart, source edit, live QBO refresh/provider call, credential read, grant/enrollment or accounting effect occurred.

The strict v2 contract adds immutable correlated phase evidence and a same-grant fence, private owned-process invocation/readback, and independently authorized Bill observations. The native session stays in the native server. Byte-pinned helper code gets only its exact operation bytes through private pipes; no caller-selected command, environment or bearer. Durable STARTED precedes each first permission. Crashes/lost replies retain uncertainty and the original permanent effect reservation. Receipt-only reconciliation cannot grant new refresh/dispatch entitlement. Exact historical replay remains idempotent. V1 schema/receipts keep their original meaning; missing phase proof is never manufactured.

Read-bill independently requires assignment/accounting permission/admission and the same grant/lock before refresh. Its native stored observation pins Bill/company/SyncToken/material/result/capture time. It supplies no write authority. Update uses exact observed SyncToken; attachment operations use identity/freshness evidence without claiming a provider CAS. Observation freshness is rechecked at dispatch and historical readback cannot extend it.

## Verified and limited

Root typecheck/build passed. Focused: 104 passed. Full suite: server 4,043 passed/16 skipped, web 1,015 passed, installer 32 passed, browser manager 52 passed.

[Contract](./contract.md), [schema/artifact manifest](./schema-manifest.json) and [validation receipt](./validation.json) retain the exact interface and verification. Focused tests use disposable in-memory native databases, synthetic facts and a compiled fake child process. The fake helper demonstrates isolated framing, byte freezing, no inherited application environment and tamper rejection; it is not the canonical QBO runtime. Employee guide access and staged/resumed-agent guidance tests pass with no ordinary prompt advertising an active capability.

A concrete runtime compatibility issue was exposed offline: installed Homebrew Node and copied system Python could not execute from the frozen directory with their external runtime dependencies. The adapter refuses rather than falling back. The accepted canonical helper runtime/dependency bundle remains a specific source/native acceptance prerequisite. No source/provider test was used to investigate it. This implementation is not a general OS sandbox or proof against another same-UID process.

Boris received the early contract and returned concrete review requirements (process closure, phase ordering, rotated-token persistence, exact dispatch scope, observations and common grant fences). Those requirements informed the implementation. The normative parser/process contract was then sent to Boris and Clara for final read-only review. Final source/accounting acceptance has not been received. Native reservation now precedes child launch; helper qbo.lock and held-byte validation must precede the refresh-start request. This refinement is documented and was communicated explicitly.

## Remaining named prerequisites

- Platform and Clara: actual authoritative one-owner assignment and independent accounting-policy adapters, existing grant/business/account mapping and current custody evidence. Production defaults still refuse before helper execution.
- Boris with Platform: accepted runnable frozen runtime/module closure, canonical helper v2 private-pipe adapter with independent sanctioned-parent verification and standalone/copy refusal, durable source write-before-call/readback ledger, no-retry/redirect behavior, and all consumers honoring the shared refresh/persistence fence. One specified provider request is supported per dispatch; the existing multi-request attachment verifier cannot be treated as a complete single-query verification.
- Clara: accounting acceptance of real integration receipts. No duplicate business approval is requested.
- Deployment: explicit approved maintenance window and drained turns. No restart was attempted.

## Native changed files

- [phaseContract.ts](/Users/archerclawdington/veneer-os/server/src/qbo/phaseContract.ts)
- [phaseBoundary.ts](/Users/archerclawdington/veneer-os/server/src/qbo/phaseBoundary.ts)
- [helperProcess.ts](/Users/archerclawdington/veneer-os/server/src/qbo/helperProcess.ts)
- [boundary.ts](/Users/archerclawdington/veneer-os/server/src/qbo/boundary.ts)
- [routes.ts](/Users/archerclawdington/veneer-os/server/src/qbo/routes.ts)
- [0179_qbo_phase_transport.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0179_qbo_phase_transport.sql)
- [qboPhases.test.ts](/Users/archerclawdington/veneer-os/server/test/qboPhases.test.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
