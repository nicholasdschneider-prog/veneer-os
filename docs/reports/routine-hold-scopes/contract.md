# Scoped native holds — BUILD278

This adds current supplemental scope classification, not business approval or message authority. Original decision proposals, answers, results and events remain immutable. It does not import legacy email approval or implement BUILD250 transport. Unknown scope stays blocking. Source BUILD279, not deployed277, must implement the identity exporter described here.

## Dedicated identity evidence (independent of send eligibility)

`POST /api/routine-message/verifier/scope-evidence`, authenticated by the separately configured routine Cloudflare service and an active owner-enrolled routine trust. Never forward a bot bearer or use the return identity. This endpoint does not require native ready, a send lease, category eligibility or a post-0085 case: it only stores identity evidence. Source access still requires current authenticated custody and an authoritative complete projection. It grants no send eligibility to old cases.

Exact schema (`scopeEvidenceSchema` in source):

```json
{
  "schema_version": "routine-hold-identities/v1",
  "trust_id": "enrolled trust", "business_id": "verified native business",
  "request_key": "stable unique source capture key",
  "decision": {"id":"native ID","version":1,"proposal_hash":"64hex","event_revision":0},
  "target_case": null,
  "account_id":"registered routine account", "source_origin":"https://source-origin",
  "principal_id":"authenticated own principal", "executor_id":"native executor",
  "adapter_digest":"final reviewed source artifact SHA256",
  "captured_at":"2026-09-23T23:00:00.000Z", "source_revision":"complete fenced source revision",
  "completeness":"complete-customer-sister-alias-order-closure/v1",
  "next_cursor":null, "truncation":"none", "case_count":1,
  "cases":[{
    "canonical_case":"source conversation UUID", "ticket":"exact persisted ticket",
    "customer_id":"persisted customer UUID", "customer_alias_ids":[],
    "orders":[{"order_id":"persisted order UUID","binding_id":"canonical conversation locator + related_order_id field","binding_version":"exact order_binding_version","binding_explicit":true,"audit_id":null}],
    "source_reference":"bounded authoritative record locator"
  }],
  "identity_manifest_hash":"canonicalSha256(cases)",
  "closure_hash":"canonicalSha256({completeness,cases})"
}
```

For the intended send case's independent closure use `decision:null,target_case:UUID`. Exactly one must be non-null. Target must occur in cases. Decision evidence must match the current native business, decision version, canonical parsed proposal hash and maximum immutable native event rowid. Native owner review/list supplies this tuple; the source does not infer it from prose. Source evidence is new observed data, not proof of historical authority.

Case array sorts ascending canonical UUID; aliases sort ascending UUID; order array sorts ascending order UUID. All IDs unique within their arrays; 1–100 cases, at most100 aliases/orders per case, exact case_count, no cursor/truncation. Canonical JSON sorts object keys and preserves arrays. Values are exact, not trimmed identity guesses. No customer body, credentials, raw headers or whole-chat history is exported.

The trusted source must establish **transitive closure** over persisted same-customer sisters, contact/Shopify customer aliases and shared explicit order relationships, with cap+sentinel and revision fencing for new relationships. Missing/ambiguous relationships or incomplete closure deny at source; a literal completeness string alone is not evidence. Shared case/customer/alias/order identities block native unrelated-case exclusion. `binding_id` is a stable source locator, not an invented audit ID: e.g. `cs_conversations/<UUID>/related_order_id`. Persisted explicit flag must be true. `audit_id` is the real audit ID when one exists, otherwise null; no synthetic ID. Unverified legacy order associations must deny projection, not disappear as empty orders.

Evidence accepted only within15 seconds, with at most5 seconds future skew. Response `{evidence_id,execute:false}`. Request key conflict fails; immutable same-key replay returns its ID, never retimestamps evidence. Source revision is distinct from stable identity/closure hashes. The source exporter must be in the final enrolled adapter digest; deployed277 digest is not the future exporter.

## Genuine owner scope review

Authenticated **current human business owner only**, preserving original decision read ACL. No bot, forwarded cookie, historical actor fabrication or policy membership substitute.

- `POST /api/bot-communication/routine-messages/hold-scopes/list` `{trust_id}`: complete business inventory plus previously bound records moved from that business. Authorized IDs/version/hash/event revision and binding; inaccessible records count as unavailable, never omitted from execution coverage.
- `POST .../review` `{trust_id,decision_id}`: exact native tuple, latest immutable source evidence and previous binding. Review original decision through its existing authorized UI. A source identity projection proves records/relationships, **not** the intended relevance or completeness of the decision's scope.
- `POST .../bind`:

```json
{
 "trust_id":"...", "evidence_id":"reviewed evidence ID",
 "request_key":"stable owner classification key", "expected_binding_id":null,
 "decision_id":"...", "decision_version":1, "proposal_hash":"64hex", "event_revision":0,
 "scope_kind":"case_set", "review_reference":"actual source + original-scope review reference",
 "confirmation":"complete-current-scope-not-business-approval"
}
```

`case_set` requires nonempty source evidence and owner verification that it covers **all** cases affected by that exact native obligation. A relationship that cannot be established stays `unknown`; business-wide obligations use `business_wide`. Those two kinds may use `evidence_id:null` and never exclude any case. Do not invent locators or ask a customer for duplicate business approval to classify scope. When the owner cannot determine it, the minimal prerequisite is an authoritative original obligation locator plus the complete source identity/relationship projection; only that current owner can record the supplemental classification after review.

Classification records owner/time, proposal and event revision, evidence ID/hash, full source snapshot, request hash and immutable version (new binding ID). Owner may review an older immutable observation at their own pace; it must still be the latest submitted observation for that decision, with unchanged native tuple. **This does not make it fresh execution proof.** Runtime needs a new matching observation within15 seconds. Supersession requires expected previous binding ID; conflicting retries fail.

`POST .../revoke` `{trust_id,binding_id,reason}` appends immutable revocation. Current owner can revoke after old policy/trust supersession; prior execution cannot be undone. No delete/update, no automatic reactivation. A new reviewed binding may supersede a revoked one, but never changes the original decision.

## Complete execution coverage

`POST /api/routine-message/verifier/native-context`:

```json
{"trust_id":"...","canonical_case":"...","evidence":{"target_evidence_id":"...","scope_evidence_ids":["..."]}}
```

Returns `coverage:"complete-native-scoped-holds/v1"`, exact requested binding, revision, ready, execute:false, blocking/unbound counts, supplied evidence IDs, target hash and classification hash. It does not disclose unrelated private decision text or IDs to the service. Source already possesses its submitted IDs. Capture carries the identical `native_context_evidence` object alongside `native_context_revision`. Its material case/ticket/customer must equal the target root identity; sorted context conversation IDs must equal the complete target closure case set; `material.context.snapshot_revision` must equal the target observation’s fenced `source_revision`. Different identity/material snapshots cannot be combined.

Native scans **all** decisions in the business, plus all previously bound obligations for it; no service list or handler visibility filters coverage. Every unfinished decision must have a current complete case_set classification and explicitly submitted latest fresh matching source observation. Same-case/closure overlap, unknown/business-wide/unbound, version/hash/event drift, revoked owner/trust/policy/binding, stale/missing/changed observation or moved business denies. Verified-completed records keep existing semantics; nobody may complete records merely to clear the guard.

The revision hashes the entire native decision/event set, classifications and exact evidence IDs/hashes. New decision/event, binding, revocation or later source observation invalidates previous coverage. Evidence refresh is explicit, not implicit substitution. Old callers without `evidence` retain `complete-native-business/v1` and whole-business conservative denial; they receive no scoped exclusion.

Capture, acceptance, bot reservation and first service dispatch recompute coverage inside existing SQLite transactions. Scope evidence/bind/revoke use immediate write transactions against that same database. The first dedicated dispatch association is the native linearization point; a later hold cannot undo an already authorized external effect. Source must re-lock/recollect closure/material/identity/lease after network calls before its own durable effect claim. No cross-system atomicity is asserted. Lost first response remains UNKNOWN; replay and reconciliation never send.

## Limits

This classification cannot resolve missing evidence by itself. Every unbound legacy record remains a visible explicit prerequisite. It does not clear pre-marker send uncertainty, enable factual tracking/other categories, broaden financial or customer-message authority, or replace source hold/lease/duplicate/unknown checks. Native tests are fixtures only; production bindings and customer sends are not release tests.
