# Scoped CS evidence and exact return-exception contract

September 23, 2026 · BUILD257 · Platform Dev owns the native producer; original OrderOps owner owns the consumer.

## Decision context

Existing eligible humans in the explicitly opted-in nonexclusive CS queue can read the proposal and decision discussion when a referenced source is a same-business, same-owner team conversation. This is decision-bound context already recorded by the proposing bot, not a generated source summary. No proposal/version/approval is edited or migrated.

The response adds positional `evidence_access` and `image_access`: `source_access` or `decision_context_only`. Restricted source links render as nonlinks; restricted images render “Image not shared with your account.” Original source chat/file/image routes retain their ACL. A label plus source chat ID does not expose that chat's history or all files. Foreign/private source references cannot use this exception. Existing source access remains valid independently. New membership, approval rights and whole-chat grants are not created.

All 11 affected reference patterns have synthetic coverage. No teammate accounts, grants or approvals are changed. No Mackenzie/Kenzie account is assumed.

## Exact return authority

Only the retained Y4DYW5 decision and reviewed interpretation in `RETURN_INTERPRETATION` are supported. This explicit current interpretation pins decision/version, original immutable proposal hash and approval event, Avery, business, canonical case, order and draft. It means **one unused STP54-067 item, quantity 1, return-window exception only**. It is not a parser for arbitrary prose or a fabricated historical typed approval. Raw proposal and original answer/event/human/time accompany the supplemental receipt.

The unique authoritative OrderOps order-item ID and Shopify line ID come from the later trusted complete capture. An ambiguous/missing exact SKU stops mapping. Every other return restriction stays in force. `allowNonreturnable`, `allowDamage`, `waiveShipping`, and `refundAuthorized` are false. The contract does not purchase a label or authorize a refund. Current native approval/version/approver authority and active executor/trust are rechecked before first claim.

## Supported setup — separate from deployment

1. **Cloudflare account administrator / source service operator:** create a dedicated Access application for the public path `/api/return-exception/verifier/*` and a dedicated Service Auth policy permitting only the OrderOps return-verifier service token. Use a different audience and client ID from both the human application and AutoShip. Ensure this more-specific path policy wins. Keep credentials only in approved source secret storage; never paste them into chats or logs.
2. **Platform operator:** configure `VP_RETURN_VERIFIER_CF_AUD` and `VP_RETURN_VERIFIER_CLIENT_ID` in the existing protected runtime environment. These identify the dedicated application and service. The existing Cloudflare team domain/issuer is used. Normal required checks and root restart apply to deployment/configuration. Absent or reused configuration fails closed. Service requests require a cryptographically verified Cloudflare assertion with the exact audience and `common_name`, no human email identity. Human cookies, bot bearers and AutoShip identity do not authorize this API.
3. **Authenticated current native business owner:** use the existing human-authenticated endpoint `POST /api/bot-communication/return-exception/trust`. Body:
   ```json
   {
     "business_id": "<verified-native-business>",
     "executor_id": "<reviewed-Avery-native-chat>",
     "client_id": "<dedicated-service-client-id>",
     "audience": "<dedicated-CF-audience>",
     "account_id": "<authoritatively-verified-OO-account>",
     "principal_id": "<verified-own-Avery-OO-principal>",
     "source_origin": "https://<canonical-OO-origin>",
     "request_key": "<stable-enrollment-key>"
   }
   ```
   This records a **new explicit trust enrollment by the actual current owner**, not a historical signature. The owner must obtain account/principal identity through the supported authenticated OrderOps identity/enrollment contracts. Documented chat/principal strings or business names alone are not proof. A bot, manager membership, user-agent header, or a generic `eligible=true` assertion cannot enroll. The endpoint is an authenticated API, not a new bot tool or settings UI. No live enrollment was performed by BUILD257.
4. **Original OO owner:** configure the dedicated service transport and trust ID server-side; implement the bounded capture, local transaction/intent/outbox contract below. Never forward bot credentials to Veneer. The source service is explicitly trusted to verify its own current principal/account/enrollment/lease and complete material under source-side custody. Veneer does not pretend to independently fetch or authenticate source facts from arbitrary URLs.
5. **Independent acceptance:** verify configured identity rejection/acceptance, exact mapping and local consumer safety with isolated fixtures, then independently inspect the retained case under existing authorization before any live continuation. Code deployment alone is not configured trust or end-to-end acceptance.

Revocation: authenticated owner `POST /api/bot-communication/return-exception/revoke`, body `{trust_id,reason}`. Immutable and idempotent for identical reason. Revocation before claim denies; a prior claim remains authorization for only its exact pending submission. It never undoes external effects. Replacement enrollment gets a new request key; old enrollment remains audited.

## Producer API / source capture

Dedicated service paths:

- `POST /api/return-exception/verifier/mappings`: body is strict `returnCaptureSchema` in `server/src/bots/returnException.ts`.
- `POST .../claims`: `{mapping_id,request_key,scope_hash,source_capture}`.
- `GET .../claims/:request_key`: read-only same-key reconciliation.
- `POST .../acknowledgments`: `{request_key,scope_hash,local_submission_id,local_committed_at,local_receipt_hash}`.

Unknown fields are rejected. Captures need:
- `schema_version=orderops-return-source/v1`, trust/request IDs, capture time, source/enrollment revisions, exact account/principal.
- `completeness=complete-parent-and-child-material/v1`: the trusted OO implementation must actually enforce complete bounded capture and reject truncation/sentinels/inconsistent reads; this literal from an untrusted caller is never authority.
- Own lease canonical case/principal/revision/expiry; at least 30 seconds remain.
- Persisted conversation ID/customer/order/binding version and `binding_kind=persisted`.
- Order ID/number/Shopify ID, material fingerprint `version`, complete items with native order-item ID/order ID/Shopify line ID/raw nullable SKU/positive purchased quantity.
- Draft ID/order/case, material fingerprint `version`, return/draft state, selected items and policy snapshot SHA256.
- Capture age at most 30 seconds (5-second forward skew tolerance).

Orders have **no fabricated customer ID**. The persisted case→order binding is the declared source relation. Source SKU strings are not trimmed or normalized; non-target nulls are allowed. Only exact reviewed SKU matches. Native item ID is not return-request item ID or SKU.

Order/draft `version` values are 64-character SHA256 material fingerprints, **not updated_at alone**. Canonical JSON sorts object keys and preserves array order. OO must define and version its complete relevant parent-and-sorted-child manifest, sort child collections by stable native ID, retain exact database timestamp precision, and include relevant policy/date/customer-binding/assignment/material fields. Hashes cannot hide omitted children. Veneer binds these hashes and the complete capture immutably; OO owns truthful capture and fresh locked comparison. The consumer owner confirmed this contract and will publish its exact source field manifest during its implementation.

Receipt `schemaVersion=veneer-return-exception/v1` includes `audience` (CF AUD) and separate `serviceClientId`, immutable mapping ID/revision, source capture/revision/origin/fingerprint, raw original approval/proposal and explicit supplemental interpretation. `scope` binds business/account/executor/principal, native decision/version/hash/event, native+Shopify order/item, case/customer/binding, draft/order fingerprints, quantity and narrow flags. `scopeHash` is canonical SHA256.

## Item-add, final claim and recovery

Item-add mapping may have zero selected items and only reserves eligibility locally. Before submit, obtain a **fresh unclaimed mapping with a new mapping request key** after draft/item/lease changes. A final claim requires the exact singleton authorized item/quantity. Mapping must still be fresh; claim capture equals that mapping byte-for-canonical-byte. Drift requires remap only while unclaimed. Never submit new capture under an old mapping.

OO persists a pending submission intent with final mapping/scope/key, serializes order/draft/itemset/reservation/revocation and fresh local gates, then obtains the native claim with the same stable key. Native SQLite immediate transaction checks current native state and atomically inserts a unique claim per decision. A second key/version/mapping cannot claim it again. Revoke-before denies; claim-before establishes exact authorization. No automatic claim expiry, abort/reissue or new-key retry exists.

`execute:true` means this request newly established the claim. `execute:false, authorized_submission:true, same_pending_intent_may_complete:true` on authenticated same-key reconciliation means:
- do not issue another claim or create another intent;
- OO may finish only the original persisted intent after locked proof of no local commit/effect, unchanged exact material scope and fresh local eligibility/lease/enrollment;
- if already committed, return the existing receipt/ack; do not append another outbox item;
- changed material after claim stays blocked for reconciliation, never remaps/reissues;
- renewed lease/enrollment is checked separately from the immutable captured evidence;
- reconciliation itself never authorizes purchasing, sending, refunding or replaying an external effect.

OO relocks/revalidates and atomically consumes eligibility with local RMA/status/outbox creation. All portal/legacy/background consumers must honor the narrow marker or deny; no broad adminOverride. Unknown local outcome remains pending, query the same key. Native acknowledgment records one immutable local receipt, not successful label/refund completion. Original OO owner owns that transaction and dispatcher closure.

## Six source-review findings

All six were accepted and resolved in the producer: no invented order customer ID; raw nullable SKU; full parent/child fingerprint contract; fresh unclaimed remap; explicit same-intent recovery; separate audience/client fields. Original OO owner reviewed the revised DTO source and reported no further producer incompatibility. That review is not end-to-end acceptance.

## Validation and rollout status

See README.md in this folder for actual check, commit, health and read-only visibility results. No production trust, source mapping, claim, approval, draft, return, label, lease or customer mutation is part of this build.
