# BUILD425 — authenticated approved case mapping

Native implementation validated September 28, 2026. Deployment verification is pending
in this revision; this is not a repaired live send-path or customer delivery receipt.

## Implemented

The existing inspector/delegate/accept/claim/receipt routes now resolve unequal approved
UUID/ticket identifiers through a protected operator registration and the native caller's
own source identity. The original approval, both identifiers and all transport hashes stay
unchanged. Supplemental mapping/provenance is immutable, current authority is rechecked,
and concurrent claims still permit one execution. Equal-ID messages, same-owner delivery,
ordinary drafts and completed-state receipt-only reconciliation retain their boundaries.

The [executable contract](./resolver-contract.md) contains the registry schema, exact
source capability/case projection, use-time custody, freshness/drift rules, endpoint/tool
sequence and source-owner findings. It is implemented native code, not a claim that the
current source already supports its missing capability fields.

## Validation

- Node 24 root typecheck passed.
- 115 focused tests passed (resolver 41, existing delegation 48, catalog 15, instruction
  context 11). Actual HTTP fixtures cover authenticated route wiring and competing claims.
- Full root `npm test` passed: server 2,676 passed / five existing skips; web 907 passed;
  browser-manager 42 passed; installer 29 passed.
- Root production build passed. Existing Vite large-chunk warning remains.
- Employee guide access and fresh/resumed, full/restricted agent instruction delivery
  are covered by catalog/instruction regressions. No UI behavior changed.

Tests use synthetic SQLite/HTTP/source responses only. No production credential, case,
provider, decision, draft, delegation, claim, lease or customer action was used as a test.
No ordinary draft was retrofitted and no old approval was revised.

## Outstanding live integration

Source owner ae5d6289 confirmed no applicable authenticated account/business/runtime
projection or caller-specific native-server credential custody yet exists. It also found
initialization DDL in capability/authentication GET paths that may recur after restart;
schema adoption alone does not certify write-free reads. The default broad case response
may exceed the explicit 1 MiB cap, which fails closed. Retained Railway pins were not
independently verified by this source-only review.

The original source custodian must establish the capability projection, a genuinely
side-effect-free metadata-read boundary, current deployment/account/business proof and
permission/reference for each original bot's own credential. Then the existing native
operator can install the protected registration under the contract. These are technical
custody facts, not another customer approval. No return/routine authority is reused.

The original case owner then re-inspects the same current approved version, delegates its
unchanged exact scope once, and the named executor follows the existing source/lease/
material/duplicate checks and one-time claim. Actual verified provider and native receipt
readback remain the operational success criterion. Builder performs no customer execution.
Brian's stale v3 remains unusable; Grant's newer instruction remains separate.

Nick's later screenshot reports a separate SMS draft authorization-link failure. Its exact
retained scope/error was requested through the existing coordination; this report does
not claim the mapping change repairs an unbound or differently authorized SMS draft.

## Changed files

- [Resolver](/Users/archerclawdington/veneer-os/server/src/bots/approvedCaseResolver.ts)
- [Delegation](/Users/archerclawdington/veneer-os/server/src/bots/messageDelegation.ts)
- [Draft lifecycle](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [Authenticated routes](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [Configuration](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [Immutable mapping migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0128_approved_case_mappings.sql)
- [Resolver regressions](/Users/archerclawdington/veneer-os/server/test/approvedCaseResolver.test.ts)
- [Catalog regressions](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Capability catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Tool instructions](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [Employee/agent guide](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Current transport contract](/Users/archerclawdington/veneer-os/docs/reports/approved-message-delegation/contract.md)
- [Historical BUILD250 report](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/README.md)
- [Resolver contract](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/resolver-contract.md)
- [This implementation receipt](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/build425.md)
