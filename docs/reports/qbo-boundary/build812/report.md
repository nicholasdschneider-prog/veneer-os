# BUILD812 — staged native QBO correction

Native-only correction; not deployed, not helper-accepted, not accounting-ready.
No production restart, native operation, helper/QBO/provider/credential call,
enrollment or ERVP change was performed. All executions used offline fixtures.

The patch checks effective execution UID against the accepted descriptor before
reservation and immediately before spawn, without switching identity. Phase writes
use one monotonic clock sample. Regression leaves durable open history and the
grant/effect fence; recovery cannot silently resume the invocation. Bill capture
is bounded by the exact immutable same-invocation/provider-request dispatch start,
including UNKNOWN reconciliation, with no reservation-time fallback.

Existing BUILD792 terminal consistency and historical receipt-ID replay remain
covered and unchanged. Stored schemas, historical artifacts and migrations are
unchanged. The synthetic damaged-history test removes a row only in an in-memory
disposable database to demonstrate that missing dispatch proof denies observations.

## Evidence

- [Corrected contract](./contract.md)
- [Validation receipt](./validation.json)
- [Byte manifest](./schema-manifest.json)
- [Phase implementation](/Users/archerclawdington/veneer-os/server/src/qbo/phaseBoundary.ts)
- [Process implementation](/Users/archerclawdington/veneer-os/server/src/qbo/helperProcess.ts)
- [Offline regressions](/Users/archerclawdington/veneer-os/server/test/qboPhases.test.ts)
- [Capability catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Guide](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)

## Readiness limits

Boris owns later source adaptation and review of this corrected interface; Clara
owns accounting acceptance. Authoritative assignment/accounting/existing-grant
adapters remain missing. The unconditional 30-second SIGKILL persistence risk,
frozen runtime/dependency custody and independent sanctioned-parent verification
remain unresolved. Native source alone does not enforce the canonical helper.
Deployment is pending explicit human-approved maintenance and drained turns.
No new approval, consent, grant or enrollment was requested.
