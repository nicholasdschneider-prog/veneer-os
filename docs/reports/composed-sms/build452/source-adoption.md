# Required source adoption protocol — no source implementation or activation

Native BUILD452 implements the interface offer with SHA256 `6457641ca5d576fbd43c7828e1da6d4e81af84549ac0b0c67b8f5ef1914b1479`. Original owner ae5d accepted the hashes-only direction and seven digests, not runtime coupling, custody or guard acceptance. Source PostgreSQL implementation and acceptance remain with that single owner. No source work was queued or edited by Platform.

## Transactional adoption shared by all proof versions

1. Install one common issuer/business serialization gate in **every** legacy and correction prepare writer and precontext immutable action-binding audit writer before enabling the new version. A correction-only lock is insufficient. Keep the installed source wire, lease, material, suppression and attempt locks; publish the combined lock order and executed writer coverage.
2. Under that gate, enumerate both persisted intents and action-binding audit rows, including audit-only records. Snapshot exact IDs, action UUIDs, revisions, issuer/business scope and state. Include rejected, expired, revoked and UNKNOWN records. Never filter these away to make adoption pass.
3. For every unadopted action UUID obtain fresh exact-ID lineage from `GET /api/composed-sms/verifier/actions/:actionId/lineage` using the reviewed dedicated service amendment. This is a read-only historical mapping from durable native records; it grants no entitlement and does not renew an authority. Caller JSON or copied digests cannot substitute. The response pins issuer/business/decision/original digest/action plus current registration and observation expiry.
4. After network reads reacquire the **same** serialization gate in a transaction and re-read the complete row/revision inventory. If any writer inserted, deleted, moved or changed a row, deny that adoption attempt and reconcile read-only. Missing/expired/foreign/conflicting native mappings also deny. Do not hold an assumed cross-system atomic lock or claim distributed atomicity.
5. Atomically populate one durable common ledger enforcing uniqueness `(nativeIssuer,businessId,nativeActionId)` AND `(nativeIssuer,businessId,originalActionDigest)`. Intents and audit rows both reference that ledger; legacy writers must pass it even after migration. An audit-only record already reserves the action. Conflicting historical records remain intact and block; never collapse, discard, remap, or release them.
6. Commit adoption and prepare/audit insertion under that same gate. New correction requests require complete adoption for the relevant issuer/business. Expiry/revocation/UNKNOWN never frees uniqueness. PREPARED→REDEEMING/request-key CAS still precedes native association; source guarded SENDING commit still precedes its sole provider call. A lost response never authorizes another attempt.

The native tests include an executable SQLite protocol model for both source tables and a concurrent legacy insert during lineage lookup. This validates the proposed protocol's fail-closed behavior, **not** the actual source PostgreSQL implementation. Source owner must test the real migration, rollback/conflicts, audit-only rows, every legacy/new writer, isolation/locking and simultaneous preparations before acceptance.

## Protected amendment, not a flag

The native service registration has a new optional strict `correctionAcceptance` object. Existing registrations retain identical canonical hashes when the field is absent. No production registry was altered. Correction-v2 derivation also denies absent amendment before writing an authority or reserving a new action; it does not strand a nonexportable authority awaiting a retrofit. Inspection still returns native context and any available authorized source evidence with precise missing proof.

Required fields: `schemaVersion: compose-correction-acceptance/v1`, pinned `nativeIssuer` HTTPS origin, existing `sourceRegistrationHash`, exact offer `contractHash`, actual accepted `sourceImplementationHash`, `lineageAdoptionReceiptHash`, `custodyAmendmentHash`, accountable `reviewedBy`, `receipt`, `reviewedAt`, `expiresAt`, and exact ordered capabilities:

```
compose.correction.read
compose.lineage.read
compose.correction.associate
compose.correction.readback
compose.correction.scope
```

Expiry cannot exceed the current registration or verified credential/custody minimum. Withdrawn/revised protected registration invalidates existing binding checks. Native canonical registration SHA256 includes the entire optional amendment when installed. The existing source descriptor preimage and sourceRegistrationHash are unchanged; this is an explicit separately recorded acceptance, not reinterpretation of old receipts. Historical dispatch records retain their old registration hash and cannot be rewritten to acquire new rights. Their exact read-only lineage may be reconciled under current explicitly amended service scope. No new secret or arbitrary audience header is introduced. The original custodian must issue the actual route/version/audit amendment and the sole source owner must install its accepted counterpart. A synthetic receipt or `supported` Boolean is not installation evidence.

## Native endpoints and version

The implemented parser is [composedSmsCorrectionContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsCorrectionContract.ts). All seven original golden digests remain unchanged and are checked **after strict parsing**, including the synthetic HTTPS origin; actual use independently requires the protected source origin/runtime match.

- GET `/api/composed-sms/verifier/correction-authorities/:authorityId?revision=1&actionId=UUID`
- GET `/api/composed-sms/verifier/actions/:actionId/lineage` (no query)
- Existing `/authorities/:authorityId/current-context-v2` understands correction-v2 through current native proof validation, without the unchanged-consumption validator.
- Existing association/readback routes explicitly recognize `native-compose-sms-correction-dispatch/v1`; historical schemas retain their meaning. Old authority export and current-context-v1 reject correction proofs.

Projection contains hashes and exact SMS wire scope, never human correction text, citations, result anchors or review prose. Every first association recomputes the exact immutable projection, source binding and current native context after source readback in the immediate transaction. Scope completeness, source guard acceptance, actual sender process, fresh sender receipt and recipient timezone remain independent requirements. Actual case readiness is not established.
