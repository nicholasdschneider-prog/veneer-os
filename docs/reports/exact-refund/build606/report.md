# BUILD606 exact refund authority — staged, not deployed

Implemented a dedicated exact-approval issuer/verifier with permanent order-wide financial identity, independently authenticated source intent readback, first-only reservation, and receipt-only reconciliation. Native bots always return execute:false/refundEntitlement:false. No return, restock, notification, label, insurance or customer SMS entitlement is included.

Boris accepted the frozen contract for disabled implementation and source planning at 2026-10-06T17:00:49.600Z in coordination9c58c4e8-e076-4954-8032-b32851ef4c01. This is not operational source acceptance. See [review receipt](./review-receipt.json), [contract](./contract.md), [normative preimage](./normative.json), and [strict parser goldens](./golden.json).

Contract SHA256: `42afab55b95731f9ac32229fb08a8cbd2482dba07f3437b2a5330c093f99912b`. Seven fixed digest projections and a realistic post-success reconciliation vector are parser-validated. UNKNOWN retains authentic partial provider IDs without success inference. Permanent action identity omits amount, payment, version, case, registration and request keys. No expiry, rollback or revocation releases the action. Claim-before-revoke is a local SQLite linearization, not distributed cancellation or protection from unmediated external refund writers.

The current exact intent's own reservation bookkeeping is authenticated separately and excluded from eligibility inventory; no actual effect or uncertainty is excluded. Source acceptance must prove this projection and every refund writer's shared mediation. Source rolls back locally only into permanent same-key reconciliation; even verified no-effect rollback grants no new attempt.

## Live evidence read, no business effect

Read the exact native decision/context and retained source assessment/principal report. Current proposal and retained revised snapshot canonical SHA256 both equal `8f7459cd268a9409c5b6e828cf413a8d9c78664c01a0983a24ef1bf6072af9c4`; answered payload hash `bf4089cab6795713b82354ffff34c38a5d8b625780eb55631903af083353cb9a`. These checks preserve history; they do not issue authority. No production enrollment, authority, claim, source intent, refund, lease, provider/customer test, credential retrieval or source edit occurred.

Miles remains original executor. His retained independently verified principal is evidence, not a fresh account/store/payment enrollment. Sale7875105816728 remains a candidate requiring actual source proof. Existing Y4DYW5 refundAuthorized:false and BUILD525 scope are unchanged.

## Remaining prerequisites and owners

- Boris, sole OO601 consumer owner: implement the accepted dedicated evidence/intent projection and all-path refund mediation; provide executed writer/race/provider-boundary acceptance. Native locks cannot prevent external refund races.
- Existing rightful custody/source owners with Boris: dedicated CF service audience/client, hashed bearer, separate scoped readback custody, actual Miles source-principal/account/store enrollment and exact payment/customer/item/material/refund-inventory mappings. No reused return/SMS/custody grant or fabricated mapping.
- Original Miles only, after setup and fresh source facts: inspect the unchanged approval, read full bounded context and submit accountable semantic review. Builder performs no issuance. Separate SMS follows only independently verified refund success under its own authority.
- Deployment owner: resolve BUILD505 retained Chrome/preview preservation before any root restart. No release of that constraint was established. No root restart or production migration was performed.

## Shared artifact consequence

The staged BUILD605 email feature pins shared config/index/botTools bytes. Their refund additions required an explicit current artifact hash update to `d2912dfa355288bf6d968cfd24f7180e55378c981e443470675f976dad480ead`. Historical BUILD605 receipts are preserved. Email contract and implementation are unchanged; old acceptance does not validate changed bytes. See [append-only artifact delta](./shared-email-artifact-delta.json). Boris was notified before source acceptance.

## Validation and deployment

[Final validation and compiled-artifact receipt](./validation.json): root typecheck passed; full root suite passed (29 installer, 3,643 server with 15 skipped, 1,008 web, 51 browser-manager); root build passed. A final scoped rerun also covers the added deterministic single-clock observation regression. Initial full-suite failure was the shared email artifact pin introduced by these shared-file changes, corrected explicitly; no clean-baseline claim. Focused final checks: 56 refund tests +139 email regressions +33 guide tests =228 passed. Employee catalog and fresh/resumed-agent instruction delivery verified. Deployment is staged only; readiness is unavailable without source integration and dedicated trust.

## Changed implementation and guide files

- [server/src/bots/exactRefundContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/exactRefundContract.ts)
- [server/src/bots/exactRefund.ts](/Users/archerclawdington/veneer-os/server/src/bots/exactRefund.ts)
- [server/src/bots/exactRefundRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/exactRefundRoutes.ts)
- [server/src/db/migrations/0154_exact_refund.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0154_exact_refund.sql)
- [server/src/config.ts](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [server/src/index.ts](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [server/src/bots/routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/test/exactRefund.test.ts](/Users/archerclawdington/veneer-os/server/test/exactRefund.test.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [server/src/bots/customerEmailArtifact.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailArtifact.ts)
- [docs/bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
