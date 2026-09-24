# AutoShip candidate notification contract v1

Native interface only. Source OrderOps owner a4bc7b0c-e56a-4b90-b4bc-cb71cbc88e68 implements source capture/outbox and current eligibility. Henry2c5de4ad-00b4-4be2-abf7-25f34eb787a3 coordinates normal candidate behavior directly. No protected huddle access is used.

## Authority and binding

Only business `5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86` and existing recipient `1dcb56c5-be80-43c9-9b68-2817b931ecda` are supported. Native receipt is notification acceptance, **never shipping eligibility, per-order approval, purchase permission, delivery of goods or provider effect proof**. The worker must freshly read OrderOps eligibility, per-order grants and shared duplicate/unknown-effect state. No second executor or polling loop is created.

The source origin is owner-enrolled, not asserted per event. `order_id` is canonical OrderOps UUID. `order_revision` is an opaque exact source material fingerprint, not a native eligibility attestation. The source owns the fingerprint manifest and verified relationship of candidate to order/stock evidence. Native validates transport, schema, registered account/business/recipient and immutable event binding; it does not query order data or independently establish stock truth.

## Setup — not performed by BUILD299

1. Authorized Cloudflare operator creates a **new dedicated** Access application for `nicksworld.dev/api/autoship/candidates/*` and Service Auth policy allowing one dedicated source service token. Preserve other human/verifier/return/routine policies. Configure native protected env `VP_AUTOSHIP_CANDIDATE_CF_AUD` and `VP_AUTOSHIP_CANDIDATE_CLIENT_ID`. Audience and client must differ from human, AutoShip decision verifier, return and routine identities. The JWT resolver validates issuer, RS256 signature, audience and exact service `common_name`, rejecting human email identities. No configuration means ingress401.
2. Source custodian reviews exact canonical production account/origin and deployment boundary for a **candidate-specific** registration, and stores the new token only through its approved protected secret/runtime custody. Proposed source configuration names: `OO_AUTOSHIP_CANDIDATE_ORIGIN` (base https://nicksworld.dev), `OO_AUTOSHIP_CANDIDATE_CF_CLIENT_ID`, `OO_AUTOSHIP_CANDIDATE_CF_CLIENT_SECRET`, `OO_AUTOSHIP_CANDIDATE_SOURCE_ID`, `OO_AUTOSHIP_CANDIDATE_ACCOUNT_ID`. These names are a setup contract, not a claim of existing config. Send Access service headers only to the pinned origin, reject redirects; do not copy any return/routine token, user cookie or bot bearer.
3. A genuine authenticated current native business owner POSTs `/api/bot-communication/autoship-candidates/sources` with the following exact reviewed nonsecret fields: `business_id`, `recipient_id`, `account_id`, canonical HTTPS `source_origin`, dedicated `client_id`, `audience`, stable `request_key`. Bot actors are rejected. Account/origin require explicit source-custodian evidence; deployment names or tenant strings are not account proof. Native checks current owner and active worker registration/business/ownership. The request returns immutable `id` (source_id); identical owner request returns the same record; changed request conflicts. No production registration has been performed by this release.
4. Source custodian installs the returned source_id and exact binding in its own adapter/runtime, validates offline fixtures, then obtains separately authorized acceptance. A notification must never be used as an approval workaround.

## POST /api/autoship/candidates/events

Dedicated service JWT only, JSON body at most16KiB, strict schema:

```json
{
  "schema_version": "autoship-candidate/v1",
  "source_id": "owner-enrolled-source-uuid",
  "event_id": "immutable-source-event-key",
  "candidate_id": "source-candidate-key",
  "order_id": "11111111-1111-4111-8111-111111111111",
  "order_revision": "opaque-source-material-fingerprint",
  "occurred_at": "2026-09-24T12:00:00Z",
  "business_id": "5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86",
  "account_id": "reviewed-candidate-source-account",
  "recipient_id": "1dcb56c5-be80-43c9-9b68-2817b931ecda",
  "kind": "order.new_candidate"
}
```

For `kind: "stock.newly_eligible"`, additionally require:

```json
{
  "stock_change": {
    "inventory_item_id": "exact-source-inventory-item",
    "location_id": "exact-source-location",
    "evidence_kind": "authenticated_stock_event",
    "evidence_id": "exact-authenticated-stock-event-or-receipt",
    "revision": "exact-stock-evidence-revision",
    "confirmed_at": "2026-09-24T11:59:00Z"
  }
}
```

`evidence_kind` is `confirmed_receipt` or `authenticated_stock_event`. The latter supports a verified stock update without fabricating an AutoPO receipt. `stock.newly_eligible` is a candidate classification meaning **reevaluate after confirmed stock change**, not certified shipping eligibility. One event identifies one order/inventory-item/location relation; source assigns stable keys to multiple relations. No free-form instruction/body/recipient override fields are accepted.

Source normalizes Shopify inventory/location GIDs to their exact numeric ID strings; do not send slash-containing GIDs. Source must recompute receipt `payload_hash` over the complete canonical request, including `kind` and `stock_change`, since those fields are not separately echoed.

IDs/revisions are1–200 ASCII alphanumeric/dot/underscore/colon/hyphen; order UUID and UTC ISO datetime required. Future occurred_at > five-minute clock skew rejects; stock confirmation must not postdate occurred_at. No maximum past age is imposed on durable source events, because notification is not current authority. The worker must establish fresh eligibility regardless of event age. Source should emit only after confirmed source commit; unknown or speculative receipts are not stock evidence.

Success200 returns immutable `autoship-candidate-receipt/v1`: `delivery_id`, `source_id`, `event_id`, `candidate_id`, `order_id`, `order_revision`, `business_id`, `account_id`, `recipient_id`, canonical sorted-key `payload_hash`, `accepted_at`, `status:"accepted"`, `shipping_authority:false`. Source must pin all identity/order/event fields. Exact same source/event payload returns that original receipt and never creates another wake. Any changed payload under that key is409. A changed order revision is a new source event, not permission to overwrite the old one. Duplicate prevention for external shipping remains OrderOps's shared responsibility.

## GET /api/autoship/candidates/sources/:source/events/:event

Dedicated same enrolled service identity only. Returns `{receipt, delivery:{status, source_revoked, worker_started, shipping_authority:false}}`. Receipt is the original immutable acceptance record; current delivery status is separately `pending`, `delivered` or `cancelled`. Delivered means durably queued to the worker, not necessarily processed or shipped. `worker_started` is the durable native start admission. Source, event, candidate, worker, account and order remain in the receipt. GET never enrolls, requeues or sends.

Lost POST response: query exactly the same source/event. A404 means no committed native receipt was observed; source may retry the **identical** original event/key after authenticated readback, never fabricate a new event to evade uncertainty. Source revocation permits same-service read-only receipt reconciliation while still checking active current owner/worker access. Revoked/inactive native identity or removed worker access blocks readback; operator reconciliation is then required. No broad event listing or chat access is exposed.

Errors use `{error:string}`:401 absent/wrong dedicated transport;403 wrong source identity or current owner access;404 source/event not found;409 revoked/current binding conflict, changed replay, invalid timestamp relationship;400 invalid schema;405 unsupported method/path; oversized JSON413. Responses no-store. Raw JWTs/headers/body are not logged.

## Revocation and ordering

Genuine current business owner POST `/api/bot-communication/autoship-candidates/revoke` with `{source_id,reason}`. Revocation is immutable; identical reason retries succeed, conflicting reason fails. Pending source wake rows are canceled atomically. No unrevocation or broad reconnect fallback.

Acceptance runs in SQLite IMMEDIATE transaction: source access/revocation, event uniqueness, wake and receipt persist together. Durable queue insertion invokes a second current-source check **inside** its existing receipt/queue transaction, so revoke-before-enqueue prevents queue persistence. Before the queued provider turn starts, another IMMEDIATE transaction checks source and current recipient, then records one start marker. Revoke-before-start denies; start-before-revoke cannot recall a notification already starting. Notification never grants business authority, even after start. Reconnection uses existing durable wake idempotency; source event replay cannot create another message. Unknown provider/business effects are outside this reference-only notification service and must never be retried from its receipt.

No source setup, owner enrollment, live dispatch, customer/provider action or credential access was performed in this build. Configured source and live acceptance remain separate from deployed interface.
