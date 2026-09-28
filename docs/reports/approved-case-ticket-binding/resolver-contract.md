# Authenticated approved-case resolver — BUILD425

September 28, 2026. This native implementation continues BUILD250. The original
[BUILD250 report](./README.md) remains a historical record of its documentation-only disposition.

The platform preserves `canonical_case` (UUID) and `payload.ticket` (short code)
exactly as approved. For unequal identifiers, authenticated source reads establish
that both refer to the same persisted case. No approval, recipient, body, attachment,
executor or proposal hash is rewritten. Equal identifiers retain the existing path.

**Native implementation and live source activation are separate.** No production
resolver registration, credential read, case read, delegation, claim or send was
performed by this build. BUILD426 deployed dedicated capabilities with account/business/runtime identity and a
bounded read-only case projection; BUILD428 adopts those exact endpoints. Native-server
credential-use permission and protected registration remain separate activation requirements.
Identity is never filled from tenant labels, return/routine authority or historical associations.

## Operator registration and custody

The supported native registration mechanism is a protected deployment manifest,
not a bot enrollment endpoint. `VP_APPROVED_CASE_REGISTRY_FILE` selects an absolute,
regular, non-symlink file owned by the service user with no group/other permissions
(mode 0600). Reads are bounded to 128 KiB. The strict schema is exported as
`approvedCaseRegistrySchema` from `server/src/bots/approvedCaseResolver.ts`.
No HTTP request may provide a registration, origin, credential, business or alias.

The authorized native operator installs this manifest only after the original source
custodian has verified the account boundary and explicitly permitted **native-server
use** of each original bot's own retained credential. This is technical custody
registration, not a new customer-send approval or owner impersonation. Mere machine
Doppler access, a secret name or a matching bot display name is insufficient.

Manifest shape (types below, not an enrollable production payload):

```typescript
{
  schema_version: 'approved-case-registry/v1',
  registrations: [{
    id: string, active: boolean,
    business_id: UUID, business_owner_user_id: number,
    account_id: string,
    source_origin: 'https://orderops-dev-web-production.up.railway.app',
    runtime: { projectId: UUID, environmentId: UUID, serviceId: UUID },
    payload_accounts: string[], expires_at: ISO8601,
    provenance: {
      custodian_id: UUID, receipt: string, registered_at: ISO8601,
      authority: 'approved-message-resolver-custody'
    },
    callers: [{
      conversation_id: UUID, user_id: number, principal_id: string,
      credential: { project: string, config: string, name: string }
    }]
  }]
}
```

Registration selects exactly one caller/account match. Both the original decision
owner and immutable named executor require one current same-business caller binding.
The registered business owner must still be the active native owner. Current native
bot registration, user, conversation and original approver access remain enforced.
A human actor or another bot cannot invoke the resolver as the named caller.
The configured credential reference is read at use time through the existing protected
Doppler CLI helper and passed in memory directly to the pinned source. Credential
values, source error bodies and broad case content are not persisted or returned.

The retained proposed source deployment boundary for this integration is Railway project
`71cc77d6-9c0d-4770-9d6d-62b8c4bb516c`, environment
`530025e2-352d-443c-a8ed-e589fc20621d`, service
`ede1932e-b3f9-4e7b-b1be-45804dfbe842`, at the literal origin above. This tuple does
not by itself establish an account, native business or authorization to use credentials.
BUILD425 has not independently verified that live tuple; the source owner’s current
review was source-only, not a live deployment attestation.

To revoke, the authorized operator sets the registration inactive or removes it from
the protected manifest; already prepared observations re-read the manifest inside
native stage validation. Changed registration hashes invalidate existing delegation
mappings, including receipts; do not silently rebind existing rows. Preserve the old
nonsecret custody receipt/manifest in operator change history. Source access revocation
is checked through capabilities on every new resolver request. No approval is revoked
or altered by a resolver configuration change.

## Exact authenticated source contract

For each stage, using only that native caller's registered own bearer:

1. `GET /api/cs/approved-case/capabilities`.
2. `GET /api/cs/approved-case/conversations/{approved-canonical-UUID}` with **no query parameters**
   (in particular no `includeOrderMatches`).
3. The same capability GET again, denying source principal/account/runtime revocation
   or drift across the case read.

The capability projection must contain:

```typescript
{
  ok: true,
  access: {
    principalId: string, fullOrderOpsAccess: true,
    accountId: string, nativeBusinessId: UUID,
    sourceOrigin: string,
    runtime: { projectId: UUID, environmentId: UUID, serviceId: UUID }
  }
}
```

Every field must equal the registered values for the actual authenticated caller.
The source must establish these fields from its authoritative current account/business/
runtime custody, and that this authority covers the dedicated case read. Reflecting request
values, hardcoded tenant names or unrelated return/routine enrollment is not sufficient.

The dedicated case response must contain persisted `id`, `ticketNumber`, `customerId`
and an ISO `updatedAt`; optional `relatedOrderId`, `orderBindingVersion` and
`orderBindingExplicit` are projected if present. The returned `id` and `ticketNumber`
must exactly match both unchanged approved strings. Missing, conflicting, malformed,
foreign or inaccessible evidence fails closed. Unknown response fields (including
messages) are discarded. Each response is capped at 1 MiB, all network calls share a
10-second abort deadline, redirects are refused, and requests use no-store caching.
Oversized responses block; no partial response is used as proof. There is no fallback
to the broad legacy case GET or legacy capabilities, including on 404/503/auth failure.

The observation is valid for at most 5 seconds after the final capability read and
15 seconds total including credential retrieval; negative clock drift denies. The
exact caller, original proposal/scope hashes and registration are rechecked in the
existing native transaction. No observation can be submitted or reused by a bot.

`updatedAt` is a conservative persisted-record revision marker, **not a complete
source-context, lease, hold or duplicate watermark**. The source custodian confirmed
that the existing GET has no such watermark. Original material/lease/duplicate/
attachment and pre-send checks remain mandatory. There is no cross-system atomicity:
a source change after the network observation cannot be prevented by a SQLite lock.
This mapping proof authorizes no provider request by itself.

## Existing executable native surface

Bot tools and strict request DTOs are unchanged:

- `inspect_approved_message` / `POST /api/bot-communication/approved-messages/inspect`:
  exact `decision_id`, `expected_version`; returns supplemental nonsecret `case_mapping`
  when ready. Missing custody/capability fields return `ready:false, missing_proof`.
- `delegate_approved_message` / `.../approved-messages/delegate`: original owner,
  immutable scope, named executor and stable request key. One delegation per version.
- `accept_approved_message` / `.../approved-messages/accept`: original named executor,
  exact delegation and scope; one authorized draft. No ordinary draft retrofit.
- `claim_message_draft` / `.../drafts/:id/claim`: current RUNNING/material checks,
  original executor, fresh mapping and existing `send_check`. Only the first claim
  returns `execute:true` with the original idempotency contract.
- `record_message_delivery` / `.../drafts/:id/receipt`: original executor and claim,
  exact delivery proof; does not call a provider or attest a bot assertion independently.

Every route resolves fresh evidence itself, before its short native transaction.
The supplemental immutable `approved_case_mapping_bindings` row binds delegation,
registration hash, fingerprint, observation and provenance. Identity fingerprint covers
account/business, case/ticket/customer and projected order binding plus registration
hash; it is separate from unchanged approval/proposal/payload hashes. Fresh acceptance
and claim observations are also retained in the immutable delegation events.

After delegation, inspect/delegate replay/accept/claim deny identity **or `updatedAt`**
drift. It is a technical blocker, not missing human approval. Do not change scope or
reapprove merely to bypass it. Registration changes require explicit custody review;
there is no automatic rebind or resumption of old rows.

Positive SENT reconciliation may accept changed `updatedAt` after sending while still
requiring the exact identity fingerprint and fresh source authority. It preserves the
original claim/idempotency/provider proof, duplicate guards and BUILD418 durable
acceptance/claim requirements for completed decisions. Changed case/customer/order/
registration/principal blocks. A completed decision stays completed; all pre-send paths
remain closed. UNKNOWN outcomes never permit reclaim, requeue or another send.

## Historical BUILD425 prerequisites (superseded in part by BUILD426/428 below)

The source owner `ae5d6289-aa2a-4266-8e68-083dc424f03f` confirmed in coordination
`d8505c9f-b634-41bf-90e9-974f5f6d365c`:

1. Current capabilities expose principal/full access/scopes only. No applicable
   authenticated account/business/runtime projection or approved-case resolver
   registration exists. The source custodian owns establishing the exact projection
   above under its own serialized source workflow; BUILD424 is not expanded here.
2. Retained principal associations and generic `ervp/prd` custody do not establish
   exact native-caller → current source-principal → own credential-reference binding,
   nor permission for this native server to use it. The custodian must supply that
   nonsecret binding/permission receipt for the original owner and named executor.
3. Current GET authentication/capability paths contain schema-initialization calls.
   They are not unconditionally write-free merely because they are GETs. The source
   custodian must establish a genuinely side-effect-free capability/default case-read
   boundary before native activation. Schema adoption alone is insufficient: current
   initialization DDL may run again after process restart. This source-side dependency
   cannot be certified merely from the GET method or an old adoption receipt. No live reads were used here.
4. Only after those facts are established does the existing native operator install
   the protected registration and verify source identity with the custodian. This build
   does not invent an account or reuse return/routine credentials. No extra customer
   approval is required for unchanged scope.

Then the original owner re-inspects the same current approved version, keeps its exact
scope, delegates once and the named executor follows existing guarded execution.
Stale Brian v3 remains unusable; Grant's newer instruction is separate. Differing
unbound ordinary drafts remain unbound. Builder does not execute, independently certify
live eligibility or claim a delivery receipt. Actual business completion requires the
original executor's verified provider receipt and native receipt readback.


## BUILD428 dedicated endpoint adoption — September 28

The native sequence above now uses only the dedicated pair. Source BUILD426 commit
`f3fe128024607080a0e50f5be7651e045e237650` and configuration deployment
`4814aa22-fcc0-46c0-9a3f-004975be2e38` were reported SUCCESS with exact health SHA at
20:42:36Z in the [source receipt](</Users/archerclawdington/Projects/ERVP/Order Ops/.veneer/receipts/build426-source-evidence.md>).
Its dedicated handler disables authentication schema initialization/cache, runs database
operations in a read-only transaction and returns only identity fields. The earlier
legacy-GET DDL and broad-response prerequisites are superseded for this dedicated path.
Nullable relatedOrderId and absent optional order-binding fields are supported without
inventing versions. Bounds, capability-case-capability sequencing, current authority,
immutable mappings, freshness and all claim/receipt guards remain unchanged.

Exact documented credential references for six source callers are available in existing
custody coordination; references alone do not grant native-server use. The remaining
activation dependency is the rightful custodian’s scoped permission/current-caller
binding receipt followed by protected native registry installation. Henry is excluded
without independent source/custody evidence. Do not add another source capability field,
repeat customer approval or use an unrelated credential. No registration or live case
probe is performed by this endpoint-adoption build. Original owner inspection follows
activation, using the same current approved version and unchanged transport scope.
