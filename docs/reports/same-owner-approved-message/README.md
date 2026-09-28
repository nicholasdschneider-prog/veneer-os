# Approved messages with the same owner and executor

BUILD413 permits the authenticated decision owner to bind an approved message to itself **only when the original immutable scope already names it as executor**. The old delegation check rejected that arrangement even though read-only inspection accepted its proof. No schema, approval, account, source resolver or ordinary-draft migration is involved.

The change removes only the owner/executor inequality restriction. Same-business access, active users/bots, current original approver authority, version, original approval event, proposal snapshot/hash, exact scope/hash, named executor and canonical-case/ticket equality checks remain. The existing immediate transactions and unique constraints enforce one delegation per decision version, one accepted draft per delegation and one execution claim. Cross-bot delivery is unchanged.

Readiness is advisory proof validation, not source eligibility or permission to send. Acceptance creates the exact bound draft; it never attaches authority to an ordinary draft. Current material checks and RUNNING remain required before claim. Revocation blocks use. Unknown effects require reconciliation, not another claim or send. A sent receipt requires the original claim key and matching verified provider/account/recipient/case/hash/idempotency proof. Record that receipt while the decision is still RUNNING, before completing the decision.

## Original-owner resume prerequisites

Boris/Grant acceptance precedes any separately authorized Avery execution. Platform Dev performed no live inspection, decision, approval, draft, delegation, claim, lease, source or customer action.

For the supplied reference, Avery remains both owner and named executor of decision `0ab8477b-128c-4558-8293-711a41dd602d` v1. Retained reference approval event `ac27d01d-2f40-45ba-8e2e-26fc1b27d13d`, scope hash `8e0ce8c72b5325e7c6ffb21ca9513edae344897bcdf2d71b61ee729fa1851c8e`, and equal case/ticket `CS2Z22` are not fresh runtime assertions.

1. Original Avery calls `inspect_approved_message` with that exact decision ID and expected_version 1. Verify current approval/event/version, owner/executor, complete scope and hash against the retained reference. Any change or missing proof stops this same-v1 path.
2. Reconcile current source identity, recipient, latest inbound, duplicates, prior/unknown effects, local-hour rules, own lease and attachment bytes through existing supported source access. A reported historical null lease is not a current lease.
3. Only Avery calls `delegate_approved_message`, using the returned scope verbatim, its exact named executor ID and a stable request key. The same Avery calls `accept_approved_message` with the returned delegation ID, identical scope and a separate stable acceptance key. Reconcile existing IDs/keys before any retry; conflicts do not justify new keys.
4. Preserve the existing material-check/RUNNING lifecycle, then use `claim_message_draft` with fresh send_check and the exact returned scope hash. Execute only on the first execute:true using the returned idempotency key. Replays never authorize another effect.
5. Record actual provider delivery proof through `record_message_delivery` with the original claim key before marking the decision complete. Uncertainty is not failure or permission to resend.

Unbound draft `66965892-54d4-497c-9d81-ee7489a26784` is not retrofitted, retired or used by this repair. No new approval/version is required solely because the owner is also the named executor. BUILD250 unequal UUID/ticket mapping remains separate and unchanged; it is not a prerequisite for this equal-ID native path. This implementation does not establish source execution readiness or provider delivery.

## Verification

Synthetic SQLite and HTTP fixtures cover inspection → same-owner delegation/acceptance → one claim; exact replays, conflicting keys/payloads, stale versions, unrelated/human actors, original approval preservation, unbound-draft preservation, active-registration/approver/user/delegation revocation, unknown outcomes and receipt guards. Both same-owner and cross-bot HTTP fixtures race delegation, acceptance and claims. The canonical-case equality negative remains covered.

Scoped tests: 55 passed across messageDelegation, botFeatureGuide and instructionContext. Catalog checks verify dated discovery, restricted employee access and resumed-agent delivery. Root typecheck, full npm test and production build passed before restart: 2,612 server tests (five existing skips), 907 web tests, 42 browser-manager tests and 29 installer tests. Vite reported its existing large-chunk warning. Implementation `8d72899` was pushed to origin main. The detached root restart completed for all five services on Node 24.21.0. At 2026-09-28T15:03:39.592Z all five services returned HTTP 200. The restart also reported the public front door reachable (302) and four tunnel edge connections; authenticated end-to-end chat and customer delivery remain unverified. No migration or configuration change was needed. [Runtime receipt](./runtime.json) records the built delegation, tool guidance, catalog and web entry hashes.

## Changed files

- [messageDelegation.ts](/Users/archerclawdington/veneer-os/server/src/bots/messageDelegation.ts)
- [messageDelegation.test.ts](/Users/archerclawdington/veneer-os/server/test/messageDelegation.test.ts)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Existing transport contract](/Users/archerclawdington/veneer-os/docs/reports/approved-message-delegation/contract.md)

Guide: `/#/bot-guide?feature=approved-message-delegation`.

- [Runtime receipt](/Users/archerclawdington/veneer-os/docs/reports/same-owner-approved-message/runtime.json)
