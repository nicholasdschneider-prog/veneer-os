# Exact refund v1 — candidate for source acceptance

Native BUILD606 / source owner Boris OO601; dedicated, disabled unless actually
accepted and installed. No reuse of return-window/SMS/custody grants.

Normative strict DTOs: `server/src/bots/exactRefundContract.ts`. Hash function H is
SHA256 of recursive ordinal-key sorted compact UTF-8 JSON `{domain,value}` using
native canonicalSha256; arrays preserve order and nulls. No hash of prose becomes
approval. `pins` references existing original human discussion instruction,
version/handling, unchanged proposal hash, answer event/raw payload hash and
recording event; no proposal rewrite. Protected review receipt pins exact mapped
financial target/effect policy. Original decision owner reviews complete bounded
native human context with citations. Each subsequent use revalidates current
native state/access/context and protected registration. Only hash projections
leave native service; private discussion text never does.

Source proposed dedicated GET `/api/cs/exact-refund/evidence/:registrationId` and
GET `/api/cs/exact-refund/intents/:sourceIntentId` require separate scoped native
reader credential, no queries/redirects/fallback. Identity/enrollment/runtime must
match protected registration. Source evidence is <=15s old, hash verified, complete
all-path refund coverage with no prior effects/blockers, exact original successful
payment, adequate remaining balance and exact truthful item/tax/shipping allocation.
Unknown/all-path missing coverage blocks. Null/missing facts are never inferred.

Native bot POST `/api/bots/exact-refund/inspect` takes registrationId. Issue takes
registrationId/inspectionHash/requestKey/expiresAt/review INPUT. Bots always
execute:false/refundEntitlement:false. Native service under separate CF JWT audience
and client plus hashed bearer and X-Exact-Refund-Registration-Id supports GET
`/api/exact-refund/verifier/authorities/:id`, POST `/associations`, POST
`/associations/lookup` (same exact request), GET `/associations/:id`, POST
`/receipts/:id` with empty body. Service export never entitles execution. Only first
association returns refundEntitlement:true (execute:false).

Source MUST commit immutable intent and PREPARED event, then durable REDEEMING CAS
before association. Binding commits authorityHash, originalActionDigest, identity,
financial tuple/revisions, source evidence hash, exact intent/request/provider key,
prepared event/time/original expiry. Native fetches persisted binding itself;
bot-supplied hashes alone are not proof. REDEEMING requires null association,
attempt and outcome. Source records SENDING before the sole provider invocation,
rechecks original expiry and own lease/assignment/material/refund guards. Source
must serialize ALL refund writers including legacy/direct/RMA/admin paths; external
provider races are not solved by native SQLite. Actual mediation/writer acceptance
is an activation prerequisite, not a supported boolean.

Native permanent action digest = H('exact-refund/action/v1',
{businessId,storeId,shopifyOrderId,effect:'refund'}). This conservative order-wide
fence excludes payment/amount/items/registration/decision version/key and therefore
blocks alternate scope, alias, copied approval or alternate-payment escape.
One authority/one source intent ever for this action; revocation/expiry/rollback/
UNKNOWN never release it. Association/revoke use SQLite immediate transaction;
revoke-first denies, reserve-first permanently reserves. No distributed atomicity
or post-reservation cancellation promise. Source rollback does NOT restore refund
entitlement, even with proof of no provider effect. Same-key reconciliation only.

Source readback is the same authenticated exact-intent route. SUCCESS must correlate
association/attempt/payment/refund ID/amount/currency/provider idempotency key and
persisted receipt, not amount or HTTP acceptance alone. UNKNOWN permits nullable
refund ID but never success inference. Receipt consumer makes no provider calls.
Historical reservations can be read/reconciled after authority expiry; current
service trust must still authenticate. No customer/SMS/insurance/restock/return
label entitlement is ever included. Existing Y4DYW5 refundAuthorized:false stays.

No source route or production registration is claimed to exist. Consumer agreement,
actual accepted writer manifest/runtime and dedicated custody/enrollment remain
required before coupling/activation. This file and parser schemas are the review
surface; golden fixtures/tests will accompany completion.

## Review corrections incorporated (October 6)

`normative.json` is the frozen review preimage. CONTRACT_HASH is SHA256 of those
exact file bytes. It commits schema file bytes with only the commitment line
masked, canonical algorithm, every domain/preimage, ID namespaces, transport,
expiry/linearization, failure states and activation prerequisites. Tests enforce
both byte commitments. No summary-only contract hash. `validateAllocation`,
`validateEvidenceBinding`, `validateIntentBinding` are exported shared semantic
validators; parsers alone are never acceptance. Source may port them only under
its own reviewed queue and must pass the same golden/negative fixtures.

`storeId` is the authoritative Shopify shop numeric REST ID, not a domain/handle.
Shopify order/payment/refund/refund-transaction/line-item IDs are canonical positive
decimal strings without leading zeros/GID wrappers. No normalization. Native
business is the actual enrolled native UUID. Item `id` is OrderOps source item UUID;
`shopifyLineItemId` is explicit. `amountMinor` is the net amount for the entire
quantity; tax/shipping are separate and all sums must be safe and exact. Proof of
these source relations remains mandatory; the native approval's historical amount
cannot fabricate a payment/item allocation.

Pins now include original instruction version and handling revision. All discussion,
result anchors/replies, direct native human messages, current decision/result/state
and events are included or inspection refuses oversized context. Changes require
fresh review, never implicit continuation. Private context stays native.

Intent readback includes required nullable `sendingEventId`/`sendingAt`. PREPARED,
REDEEMING and SENDING event IDs are distinct and ordered; SENDING is within the
original dispatch expiry and requires association/attempt IDs. SUCCESS requires
those plus the exact original request, payment, amount/currency, refund ID, actual
successful refund transaction ID/status and providerReceiptHash. Terminal failure/
rollback requires an auditEventId and noRetry:true. UNKNOWN can lack association,
attempt and outcome after a lost first reply; it never proves no effect.

Lookup POST takes the original complete association request. FOUND/ABSENT both have
literal execute:false/refundEntitlement:false/retryAllowed:false; ABSENT has null
association and does not authorize resubmission. Conflicting authority/intent/key
returns409. GET association reconciles one known association UUID. Receipt POST
names association UUID, takes no caller-supplied outcome, and fetches the authenticated
original intent itself. Readback accepts changed refund inventory/remaining balance
for history but still verifies exact original binding and current service trust.
It does not re-run no-prior-effects eligibility or create entitlement.

### Reservation inventory and uncertain receipts
The authenticated intent contains required `currentReservation` matching its exact sourceIntentId, intentHash and preparedEventId. Only this own reservation bookkeeping is excluded from the eligibility evidence/refundInventory material projection; it is independently authenticated through the durable intent binding. This excludes no provider effect or uncertainty, even on the current intent. Every foreign/earlier reservation, refund attempt and uncertain effect remains in complete priorEffects and blocks first association. Source must prove this projection and all-writer serialization during implementation acceptance; a caller assertion is insufficient. Receipt reconciliation retains current effects and changed inventory without reusing them as eligibility.

UNKNOWN receipts may preserve authentic refund IDs, transaction IDs and provider receipt commitments while remaining UNKNOWN permanently for retry purposes. No ID implies success. SUCCESS requires its full sending fence and exact successful transaction correlation. Outcome audit events are distinct from prepare/redeem/send events and cannot precede the latest recorded sending/redeeming event. FOUND requires an association; ABSENT requires null. Shared validation binds all duplicated authority/registration fields and acceptance commitments, not just the authority hash.
