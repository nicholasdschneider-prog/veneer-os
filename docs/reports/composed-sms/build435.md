# BUILD435 — composed-SMS service association

Native implementation only. Bot claims are reservation-only; a dedicated authenticated
source service may consume one immutable dispatch association. Receipt reconciliation
fetches persisted source evidence and records provider acceptance separately from delivery.
There is no live sender or dispatch activation in this build.

## Contract and remaining source work

The original pin was independently read in coordination
`d8505c9f-b634-41bf-90e9-974f5f6d365c`, message at22:57:35.481Z,
request key `compose-dispatch-native-verifier-contract-pin-v1-20260928`.
Source owner ae5d6289 queued counterpart BUILD436. Its retained response did not supply
an accepted positive sender/guard schema. The [current contract](./contract.md) documents
the native schemas, routes, separate service registry and fail-closed boundaries.

The original readback DTO omitted prepare expiry and the persisted redemption request
key. Platform sent the exact `prepareExpiresAt` / `redeemRequestKey` correction under
`build435-prepare-evidence-expiry-key-20260928-v1`. No acceptance or deployment receipt
for that correction was available during implementation. Native denies association
without those facts. This is an explicit pending integration, not a claimed source change.

Remaining dependencies are concrete:

1. Source acceptance/deployment of that readback extension, preserving original expiry/key.
2. Jointly accepted positive sender receipt/issuer/expiry/current-effective-client schema
   and actual source guard/locking inventory. The production433 reader remains unknown-only;
   it cannot produce the server-internal `ComposeBoundaryEvidence` required for prospective
   service authority. The future authenticated adapter is still required, not a boolean flag.
3. Actual dedicated CF audience/client, service principal and hashed native credential,
   separate protected source readback reference, executor/principal/runtime bindings,
   and scoped custody receipts in `VP_COMPOSE_SERVICE_REGISTRY_FILE`. No provisioning,
   secret retrieval or enrollment was performed. That config key remains absent.

These are technical integration dependencies, not another customer approval. Original
Grant retains human-context review; Tess retains any eventual separately valid execution.
No authority, acceptance, claim, source prepare, provider call or customer effect was
created by this build. Original email and ordinary SMS draft records were not modified.

## Behavior

- Separate immutable UUID action/authority tuple is created only prospectively from
  accepted server evidence; the old stable intent digest still dedupes copied drafts.
- Dedicated CF JWT and bearer hash gates are independent of normal bot/human APIs.
- Native reads exact authenticated source REDEEMING evidence before a transaction that
  rechecks native context, registration and original executor acceptance/reservation.
- Unique action, claim, registration+prepare and registration+request key prevent repeats.
  The source prepare observation is retained in immutable association audit.
- First service association only returns `dispatchEntitlement:true`. Retries and GETs
  cannot restore it. Native and source commits are separate; lost response remains UNKNOWN.
- Exact wire UTF-8 bytes, sender/recipient/account, hashes and idempotency are immutable.
  No body transforms, aliases, scope extension or historical approval retrofit.
- `record_composed_sms_delivery` now requests authenticated source readback with the
  original reservation. Bot-submitted delivery proofs are rejected. `SENT_ACCEPTED`
  records persisted provider acceptance, never delivery or permission to retry.

## Validation and runtime

Root Node24 typecheck,103 focused tests, full npm test (2,782server passed,5skipped;909web;54browser-manager;29installer), production build and git diff --check passed. Runtime verification follows the supported root restart. The Vite build emitted its existing large-chunk advisory; it exited successfully.
Focused coverage includes103 tests across composition, service authentication, reader,
tools, catalog, full/restricted guide routes and resumed instructions. The synthetic
source model tests prepare/redemption/SENDING ordering and lost responses; it is not
validation of an undeployed source adapter or its production database locks.

Preserved protected registry hashes:
- Email429: `60d22ba319fc8922d2f3ef7714949695b058d3f86135bfc46dd7ac3426ea7729`.
- Correspondence434: `7f2507f44577a8b9d5ec06516bb0be4a9d1222d7123461fc0910db4968c6b55c`.
Both remained UID501/mode0600/non-symlink. No protected config was changed.

## Changed files

- [docs/bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [docs/reports/composed-sms/build435.md](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build435.md)
- [docs/reports/composed-sms/contract.md](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/contract.md)
- [server/src/bots/composedSms.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSms.ts)
- [server/src/bots/composedSmsAuthority.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsAuthority.ts)
- [server/src/bots/composedSmsContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsContract.ts)
- [server/src/bots/composedSmsReader.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsReader.ts)
- [server/src/bots/composedSmsTrust.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsTrust.ts)
- [server/src/bots/composedSmsVerifier.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsVerifier.ts)
- [server/src/bots/composedSmsVerifierRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsVerifierRoutes.ts)
- [server/src/bots/routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [server/src/config.ts](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [server/src/db/migrations/0131_composed_sms_dispatch.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0131_composed_sms_dispatch.sql)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/index.ts](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/test/composedSms.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)
- [server/test/composedSmsTools.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsTools.test.ts)
- [server/test/composedSmsVerifierRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsVerifierRoutes.test.ts)
