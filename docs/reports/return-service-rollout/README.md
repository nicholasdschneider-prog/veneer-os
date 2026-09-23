# BUILD259 — dedicated return verifier rollout

Same Platform Dev owner; continuation of BUILD257. No customer effects or live return acceptance.

## Provisioned

Existing operator custody was verified using the connected Doppler user profile and Cloudflare API. Provisioning credentials were injected only for the API operation; values were neither displayed nor copied into OrderOps. The dedicated service secret was piped directly into approved Doppler project **ervp**, config **prd**.

Nonsecret identifiers are in [provisioned.json](./provisioned.json):
- Dedicated application on nicksworld.dev/api/return-exception/verifier.
- Separate audience and service client from human and AutoShip applications.
- Service Auth policy permits exactly the new named service token.
- Existing human/AutoShip application policies were not modified.
- Protected native runtime configuration now contains VP_RETURN_VERIFIER_CF_AUD and VP_RETURN_VERIFIER_CLIENT_ID, preserving existing entries and mode0600.
- Source store has OO_RETURN_VERIFIER_ORIGIN, OO_RETURN_VERIFIER_CF_AUD, OO_RETURN_VERIFIER_CF_CLIENT_ID and OO_RETURN_VERIFIER_CF_CLIENT_SECRET. The global provisioning key and Avery credential were not transferred.
- Token lifetime is 8760h; rotation must replace the exact policy token and source secret together. No automatic rotation or token deletion is implemented by this operation.

Original OrderOps owner confirmed the adapter expects base origin https://nicksworld.dev and appends the verifier path. Source runtime injection into OrderOpsProduction/production/orderops-web remains its custodian's responsibility; presence in Doppler is not proof of runtime injection.

The initial Python default User-Agent triggered Cloudflare error1010. An honest application User-Agent, Veneer-Return-Verifier/1.0, resolved the transport rejection without changing security policies. Before native restart the authenticated dedicated request reached Veneer's fail-closed unconfigured route401; unauthenticated requests were denied at Access and the dedicated token was denied on AutoShip.

## Owner enrollment — deliberately not performed by a bot

The existing supported human endpoint remains:
POST /api/bot-communication/return-exception/trust

It requires an actual signed-in current native business owner. Platform Dev cannot invent that human identity, borrow cookies, or enroll via a bot credential. This is trust setup, not duplicate customer approval. No owner signup is needed.

Known fields:
- business_id: 5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86
- executor_id: 170ab267-448c-4b13-97f4-5f24db2f3652 (Avery)
- client_id and audience: provisioned.json
- stable request_key: build259-y4dyw5-avery-return-trust-v1

Still needed to finalize a verified payload:
1. Avery's own authenticated GET /api/cs/leases/capability principalId receipt, with her own credential remaining in her custody. Grant coordinates this read-only identity check; no lease or case operation is needed.
2. Original OrderOps source custodian's verified canonical source origin/account interpretation and runtime/executor credential-custody binding. Capability exposes principal, not accountId. Documented chat/principal IDs or tenant='ervp' alone are not full proof.

No value is guessed for account_id, principal_id or source_origin. Once these proofs arrive, Platform Dev can fill the exact nonsecret payload and provide one authenticated owner action. The source consumer additionally needs OO_RETURN_VERIFIER_TRUST_ID and verified ACCOUNT_ID/SOURCE_ORIGIN/BUSINESS_ID/EXECUTOR_ID bindings. Setting environment strings is not enrollment authority.

## Contract and verification

The [BUILD257 contract](../scoped-cs-return/contract.md) remains authoritative for exact mapping, one claim, source fingerprints, singleton final item and same-intent recovery. All local return restrictions remain. Service authentication tests use only an absent synthetic claim key; there is no map/claim/return/label/refund/customer test.

[Cloudflare service-token API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/) and [Access application API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/) were checked for the bounded provisioning operation.

Changed artifacts:
- [Provisioning script](/Users/archerclawdington/veneer-os/docs/reports/return-service-rollout/provision_service.py) — inspect by default; explicit provision mode refuses duplicate named resources rather than rotating credentials.
- [Read-only transport check](/Users/archerclawdington/veneer-os/docs/reports/return-service-rollout/check_transport.py) — injects dedicated service credentials at use, blocks redirects, prints no headers/tokens.
- [Nonsecret receipt](/Users/archerclawdington/veneer-os/docs/reports/return-service-rollout/provisioned.json).
- [Living capability catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts).

Final checks, restart and post-restart authentication results are recorded below.

## Post-restart result

Implementation/setup commit **9877182**, pushed origin main. Root typecheck, full tests (server2311 passed/5skipped, web865, browser40, installer21) and production build passed before complete detached root restart. All five service health endpoints returned200.

Public read-only synthetic-key checks after restart:
- Dedicated service → native404 **Claim not found**: Cloudflare and native verifier authentication both succeeded.
- No identity →401.
- Fake human JWT →401.
- Dedicated return token on AutoShip path →403.

No live claim lookup key was used. All native trust/mapping/claim/ack tables remain empty. Read-only verification still finds active Nicholas user1 as ERVP owner. Shared CS hands now13 for Nicholas and13 for Ali; count growth reflects newly arriving work, not a test mutation.

Avery provided her own authenticated capability receipt at2026-09-23T19:07:37Z:
principalId veneer:cbf4e12b-b0ea-44fb-95fc-0e99613dc313, authorized=true, enforcementMode=required, oneActiveLeasePerPrincipal=true. Source endpoint https://orderops-dev-web-production.up.railway.app/api/cs/leases/capability. Her credential stayed in her custody. This proves current named principal only; it does not establish the source account/runtime binding. Source custodian was asked for that final proof before preparing owner enrollment.

Authenticated Railway metadata independently confirms project71cc77d6-9c0d-4770-9d6d-62b8c4bb516c (OrderOps Production), production environment530025e2-352d-443c-a8ed-e589fc20621d and orderops-web serviceede1932e-b3f9-4e7b-b1be-45804dfbe842. These are deployment identifiers, not automatically an OrderOps account_id. The source custodian must define/verify that final binding; Platform Dev will not silently substitute a Railway or Cloudflare ID.

The infrastructural rollout is operational. Owner enrollment remains pending source-custodian account/origin proof and then one genuine Nicholas-session POST; no infrastructure work is delegated to Nick. A follow-up will collect that proof and finish the exact nonsecret request rather than ask for another customer approval.
