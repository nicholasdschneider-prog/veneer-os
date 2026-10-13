# BUILD785 — native QBO caller and operation boundary

Implemented and staged; not deployed, helper-enforced, or accounting-accepted.

The native API uses the existing per-turn X-VP-Agent-Token and current native user/chat registration. It never accepts Anna/Clara labels, request IDs or environment claims as identity. It binds an independently resolved one-owner assignment and separate accounting permission to exact company/account/existing grant, executor, source IDs/revisions, operation, target/SyncToken and payload/attachment hashes. The permanent logical-effect fence survives changed job/key/owner/revision/payload. One initial reservation only; uncertain responses, rollback and revocation do not release it.

The production facts resolver is deliberately unavailable. It cannot convert policy files, Todos or conversation receipts into enforceable assignment or accounting authority. No new OAuth, service, grant, enrollment, live assignment, QBO refresh or accounting effect was created. No ERVP source edits occurred. The existing canonical helper and qbo.lock remain untouched.

## Actual evidence and review

[Read-only source hashes and Anna discovery](./source-readback.json) record the canonical helper files reviewed. Anna's exact native chat was active; this proves neither QBO permission nor OrderOps enrollment. The old coordination request returned404 and no huddle membership/access bypass was attempted. Authorized search recovered the September24 Clara requirement for trusted caller/job receipts.

Clara reviewed the disabled contract in coordination f8c59105-a5d8-44db-ae26-50be1ad37cb5. Her concrete corrections were incorporated: independent assignment and permission evidence, exact source identifiers, operation-specific scope, timing/entitlement clarity, strict output schemas, durable provider-evidence linkage, and atomic terminal-receipt consistency. Her review is not accounting activation. The contract was sent to Boris in existing coordination9c58c4e8-e076-4954-8032-b32851ef4c01 before any helper adaptation; native owns no ERVP job.

[Contract](./contract.md) and [schema byte manifest](./schema-manifest.json) specify native inspect/admit/read/reconcile, existing authenticated transport, hash domains and failure semantics. A first admission may be consumed only by a separately accepted canonical helper. Native execute:false is not a generic financial grant. Current production cannot return a positive admission.

## Remaining exact integration work

1. Native Platform and Clara must identify an actual enforceable existing job/assignment backend and current independent standing-accounting-authority binding. No such record ID/schema was verified. Procedural policy hashes and ownership labels are insufficient; do not invent a replacement grant or request redundant invoice approval.
2. Existing source/custody owners must establish the genuine nonsecret business/account/existing-grant mapping. ERVP LLC, realm9130349709097176, CompanyInfo1 and clara_connector are retained source constants, not native grant IDs.
3. Boris must review and implement the canonical helper invocation adapter in its own serialized source slot. It must consume the ORIGINAL existing authenticated native transport after local validation/opened-byte hashing and qbo.lock, before any credential access/refresh; block raw/unadmitted paths and close payload/attachment TOCTOU. No shared Clara bearer or new service/grant.
4. The helper must retain rotated-token persistence even if the admission expires; fresh native inspection and original expiry/material/readiness checks precede provider dispatch. No renewed entitlement. Receipt adapter must independently authenticate durable provider evidence. Native synthetic tests do not prove these source behaviors or all-path mediation.
5. Clara must accept actual source/native receipts before Anna business use. No live job was offered as a test; completed accounting sources remain excluded.

A single coordinated technical evidence step is needed: existing owners provide the real assignment reference/revision, original executor, authority reference/revision/provenance and exact allowed scope, business/account/existing-grant mapping, and canonical helper invocation/receipt mechanism. This is not a new accounting approval ceremony. Missing evidence keeps admission closed.

## Validation and deployment

Root typecheck and build passed. Focused tests: 78 passed. Full suite: server 3,993 passed/15 skipped, web 1,015 passed, installer 32 passed, browser manager 52 passed. See [validation receipt](./validation.json). Focused offline checks cover actual synthetic native session resolution, all five helper operations, foreign caller/job/account/company scope, revocation/expiry, concurrent reservation, changed payload/source/owner replay, UNKNOWN/lost reply/failure, receipt correlation and terminal conflicts. Source/provider/credential functions are never invoked. Employee guide access and staged-feature behavior for fresh/resumed agents are tested; no live capability is announced in ordinary prompts.

Root checks use the configured single worker and shared development lock sequentially. No root restart or production migration is performed. Deployment requires explicit human-approved maintenance and drained active turns; only affected services may restart then. Unrelated782 and later changes/artifacts were preserved.

## Changed code and guide

- [server/src/qbo/contract.ts](/Users/archerclawdington/veneer-os/server/src/qbo/contract.ts)
- [server/src/qbo/boundary.ts](/Users/archerclawdington/veneer-os/server/src/qbo/boundary.ts)
- [server/src/qbo/routes.ts](/Users/archerclawdington/veneer-os/server/src/qbo/routes.ts)
- [server/src/db/migrations/0177_qbo_operation_boundary.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0177_qbo_operation_boundary.sql)
- [server/src/bots/routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [server/test/qboBoundary.test.ts](/Users/archerclawdington/veneer-os/server/test/qboBoundary.test.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [docs/bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
