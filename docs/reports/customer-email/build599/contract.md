# Customer-email direction: frozen native contract, build 599

October 6, 2026. **Staged native implementation, not installed, enrolled, activated or customer-send ready.** Native workspace: `/Users/archerclawdington/veneer-os`, queue #599. ERVP lead remains chat `2d1d47a2-f3a9-4e15-9ff7-96e678fb39c6` and source build #597 was not requeued. This specification exports no purchasing authority and changes no business approval, original draft or Address hold.

The actual strict schemas and bounds are in [wire-contract.json](./wire-contract.json) and [customerEmailContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailContract.ts). The wire manifest serializes Zod types, strict object fields, enum/literal values, bounds, regex checks and nullability. Refinement implementations are pinned by the native source artifact. Source adoption must use these exact schemas, not the earlier proposed tool names/prose alone.

| Pin | Value |
|---|---|
| Projection | `customer-email-direction-dispatch/v1` |
| Contract hash | `f525e16c1ec36f2964f0999e16b12848dfdec9d7b37afdb55d97269157919991` |
| Native artifact hash | `5cc1af250ff6c5fe84f46ea54b0a7e246cfcd7aa0784ec0ae3ad0ed3bc05f8f5` |
| Wire file SHA-256 | `4ba1d616c2ae749a436d6875c319689b0604c4d0556b48ffc04523d98cb8a81c` |

The [artifact manifest](./artifact-manifest.json) lists exact source paths and SHA-256 values. Native trust rejects a different contract/native artifact hash. Tests recompute the native artifact from actual files. Hashing uses recursively sorted object keys, preserved array order, UTF-8 canonical JSON and SHA-256. The native artifact digest specifically hashes the ordered `{path,sha256}` file manifest. It excludes its generated constant file to avoid a circular digest.

## Native human/bot API

Base `/api/bot-communication/customer-email-direction`, with normal existing native authentication and an authenticated original bot conversation. Every operation is POST with a strict body. Human enrollment routes are separate; tools cannot enroll.

| Operation | Tool | Strict input schema / behavior |
|---|---|---|
| `/context` | `read_customer_email_direction_context` | `emailInput`: exact source owner/kind/ID, named executor, draft/version. Source-owning registered bot only; complete native context independent of any purchasing decision. |
| `/inspect` | `inspect_customer_email_direction` | `emailCaptureInput`: input plus registration, persisted source capture and genuine canonical case/customer/order UUIDs. Original source owner only. |
| `/bind` | `bind_customer_email_direction` | `emailBind`: exact inspection hash/key and semantic full review. Creates separate prospective immutable authority, never ordinary authorization or a decision answer. |
| `/read` | `read_customer_email_direction` | `{authority_id}`; original source owner or executor. Historical read remains nonexecuting. |
| `/lookup` | `lookup_customer_email_direction` | `emailLookup`: exact original owner/source kind/ID/draft/key. Lost-bind lookup, no new key or execution. |
| `/accept` | `accept_customer_email_direction` | `emailConsume`: authority, fresh own source capture, original request key and full payload hash. Original Grant executor only. |
| `/claim` | `claim_customer_email_direction` | Same schema; acceptance required. Original executor reserves once, always `execute:false`. The immutable reservation event ID is `claim_id`. |
| `/receipt` | `record_customer_email_direction_delivery` | `{authority_id,claim_id}`. Original claiming executor requests authenticated source readback; caller provider IDs/proofs are rejected. |
| `/revoke` | `revoke_customer_email_direction` | `{authority_id,request_key,reason}`. Original source owner only. Revocation preserves every fence and cannot cancel an already associated intent. |

`emailInput` uses `source_owner_id`, `source_kind` (`direct_message` or `result_reply`), `source_id`, `executor_id`, `draft_id`, `draft_version`. Do not substitute `expected_draft_version` or `executor_conversation_id` from other contracts. Capture input adds `registration_id`, `capture_id`, `canonical_case`, `canonical_customer`, `canonical_order`.

Native context includes both original participants' authenticated direct human messages, complete result anchors/replies, decision discussions/events, shared voice dispatches, later human corrections, exact drafts and retirement audits. Caller-private voice sessions are never read. Existing ACLs are checked before returning context. Other business records, including historical memberships/deleted drafts, are exposed only as IDs/revision hashes; they do not create a broader private-history grant. The inventory includes native decisions, drafts and receipts, delegations, instruction obligations, compositions, routine records, vendor authorities and return claims.

Every later human/result/shared voice/decision event requires an exact citation and semantic classification. Second-level timestamps are conservatively treated as potentially later throughout their entire second; no ordering is guessed against a millisecond source timestamp. A `status_only` classification supplies no consent. Supersession/ambiguity fails. Every body character requires contiguous supported span review from authentic human context; all draft fields are pinned by the full payload hash. Review is accountable semantic input from the original source owner, not a keyword classifier or an automated interpretation of historical consent.

No truncation is accepted: each surface is bounded at 5,000 rows and 2 MB, with a 2 MB aggregate context bound. Missing chronology, source, result context, draft or media fails. This version has no accepted native media-byte review manifest: attached-file markers and native image/document evidence are explicitly unreviewed and block binding rather than accepting an assertion that bytes were seen. It supports the plain, no-attachment email case only when the complete human/source context is actually available without omitted media.

## Dedicated service API

Base `/api/customer-email-direction/verifier`, mounted before the ordinary human identity gate. Requires all three: `X-Customer-Email-Registration-Id`, `Authorization: Bearer …` matching the registration's SHA-256 hash, and a separately authenticated Cloudflare Access service JWT for the exact dedicated audience/client. The header name is case-insensitive; HTTP callers normally use `x-customer-email-registration-id`. Ordinary, purchase, routine and return CF identities are refused. Accepted dedicated registry custody is also mandatory. Generic Gmail credentials cannot call this boundary.

| Method / path | Input / output |
|---|---|
| GET `/authorities/:id` | No query fields. Exact projection, authority hash, `execute:false`; never private native human text. |
| GET `/authorities/:id/context` | No query fields. Complete current native inventory keys/revisions, context revision, inventory hash and explicit missing media. No unrelated private chat content or assertion of unrelatedness. |
| POST `/associations` | `emailAssociation`: authority ID/hash, original claim ID, persisted source intent ID, stable original request key, exact context revision and fresh capture ID. |
| POST `/associations/lookup` | `{authority_id,intent_id,request_key}`. Exact original lookup; returns `execute:false,dispatchEntitlement:false`, including after lost response. |
| POST `/authorities/:id/readback` | Empty body/query. Authenticated exact original source-intent fetch and append-only readback, always nonexecuting. |

The **first** successful association response has `execute:false,dispatchEntitlement:true`, `association_id`, `authority_hash`, `idempotency_key`. The association is committed in an immediate native transaction **before** this response. This entitlement is for the accepted source's exact durable intent, not a generic bot send. A repeat of identical association input returns `dispatchEntitlement:false`. Changed keys/intents/hashes fail. Native serialization and uniqueness reject competing associations. The original first response is never reconstructed by lookup.

The source must already have persisted `association_requested` for the exact intent/key/payload/authority/native context. An UNKNOWN, attempted, already associated or provider-committed intent cannot obtain a fresh entitlement. The source must durably commit its pre-provider dispatch marker and revalidate actual source/native revisions, ownership, suppressions, lease and shared locks before its single provider invocation. The native implementation does not itself dispatch or retry Gmail.

## Source producer/readback API to adopt

These are new dedicated source routes, **not installed by native build #599**:

* GET `/api/cs/customer-email-direction/captures/:captureId`: uncached own-principal Sage/Grant read, plus separately scoped service read for an existing persisted Grant capture. Return strict `customer-email-capture/v1`. Request carries only the persisted capture UUID; no caller material or actor assertion. The source owns capture creation and complete evidence gathering.
* GET `/api/cs/customer-email-direction/intents/:intentId`: dedicated service credential, exact persisted own Grant intent. Return strict `customer-email-intent/v1`. This is read-only reconciliation, never dispatch or retry.

Native readers use distinct Sage, Grant and service Doppler custody references. The source must independently collect persisted case/customer/order/principal/account/runtime identity, exact connected account/recipient, lease, all relevant correspondence/material/directions/holds/suppressions and ordinary/routine/return/cross-channel intent/effect records. Source schema fields are neither bot assertions nor permission to invent canonical case or customer identities. Every wire response is tied to the accepted registration, source/runtime/artifact/guard hashes and full payload. The service can read a persisted Grant capture but cannot manufacture one by impersonating Grant.

Capture freshness is at most 15 seconds, rechecked before transactional consumption, with a 5-second post-read bound and live lease/custody expiry. `snapshotHash` hashes every capture field except itself. Fresh captures may have new observation/capture IDs, but material/scope/identity/shared-fence hashes and canonical order/customer/case must remain the authority's original exact values. No contact/account/payload/default normalization is performed.

`contextRevision` hashes complete native original-participant context and current ACLs. `inventoryHash` hashes the exact sorted native record key/revision inventory. Capture `records` must cover every item once, with exact revision and authenticated closure hash. Unknown/blocking/overlapping relation fails. Only the original draft may be `current_action`; every other item requires actual disjoint source coverage **and** original-owner semantic review. Hashes alone, different UUIDs, descriptive tickets, missing records, undocumented legacy scopes and caller assertions cannot certify unrelatedness. If the source cannot establish a record's scope, it must report `unknown`, and this real case remains blocked. The staged native API grants no broader native history reader to the service.

Projection retains immutable original source/executor/draft/version/full payload, genuine canonical case/customer/order, order references, source material/identity/scope/shared-fence hashes, native context/inventory, registration/contract/artifact/guard hashes, expiry and one action/idempotency key. Plain email payload has one recipient, no attachments, no cc/bcc fields. Existing ordinary `authorized_by`, draft state/version/history and purchasing decisions are never rewritten.

Native permanent fences cover original source, per-order customer-contact action and account/recipient. Ordinary/delegated/routine email claim writes serialize with the native recipient fence. Native structured return and SMS root overlaps have bidirectional migration guards. Source adoption must independently implement verified aliases/other channels and shared ordinary/routine/return intent locks; native hashes or staged code do not establish source coverage. Revocation, expiry, UNKNOWN, NO_EFFECT, receipt-save loss, replacement keys or corrected drafts never free the action.

`SENT_ACCEPTED` requires authenticated source readback with the exact original association, claim, intent, authority/payload/material/context/idempotency values, pre-provider commit marker, and real Gmail provider message/Message-ID, exact account/recipient/subject/body and empty attachments/cc/bcc. Acceptance is not delivery or address verification. `UNKNOWN` and `NO_EFFECT` are append-only nonretryable evidence; a later exact positive receipt can reconcile a prior UNKNOWN without another dispatch. Empty/capped/conflicting/unavailable reads cannot prove no send. Native receipt-save loss permits only exact readback persistence, never another provider call.

## Installation, source acceptance and owner setup

No production registry, authority, acceptance, reservation, association, customer test, send, purchasing/address edit or hold release was created. No native restart or enrollment was performed.

1. **ERVP lead** accepts this exact wire/native artifact and implements the separate source capture/intent/dispatch consumer and tested shared guard manifest under source job #597. Exact source implementation/artifact/guard and registration hashes are still missing; source coupling is not certified by native fixture tests.
2. **Original Grant** independently obtains genuine canonical source case/customer/order and current own-principal draft evidence through his connection. The draft's descriptive native ticket/customer does not prove those identities. Missing canonical evidence must remain a precise blocker; no case creation/relink/ownership change is commissioned.
3. **Nick, actual platform owner**, separately authorizes native installation/restart for the exact verified native commit/artifact. ERVP deploy permission does not authorize native installation. The new migration 0152 is unapplied by this staged task. Any existing browser-preservation restriction must also remain satisfied; no automatic restart is requested here.
4. **Actual native/business owner and source custodian** prepare the complete protected 0600 `VP_CUSTOMER_EMAIL_REGISTRY_FILE`, with distinct original Sage/Grant/service principals and credential references, dedicated CF audience/client and bearer hash, verified custody/credential/readback expiry, actual runtime/account, and exact accepted source/native/guard/contract hashes and custody/adoption receipts. No vendor/SMS/routine/return enrollment is reused. Never copy a bearer into a report or bot text.
5. **Actual authenticated human owner only**, after installed native/source setup, POSTs `/api/bot-communication/customer-email-direction/enrollment/prepare` with `{registration_id}`, reviews the exact registration and returned `confirmation_hash`, then POSTs `/enrollment/confirm` with `{registration_id,confirmation_hash,request_key}`. A provider bot conversation is rejected. This enrolls technical trust and creates no customer authority or send. `/enrollment/revoke` takes `{registration_id,reason}` and permanently preserves the enrollment audit. No owner session borrowing or builder enrollment.
6. **Original Sage**, then **original Grant**, perform genuine fresh semantic binding and independent acceptance/reservation with original source/case/draft evidence. A real successful first dedicated source association and exact positive receipt are still required before reporting actual provider acceptance.

Sage retains purchase placement; Grant retains customer sending, reply and new-address-on-file follow-through. Email acceptance does not verify a new address or release Addresshold. No second customer-consent request is introduced.
