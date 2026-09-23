# Routine service custody and owner setup

BUILD278 prepares this plan; it does not provision service credentials, enroll a policy/trust, adopt source0085 or classify live decisions as a test. No return or AutoShip identity is reused. [Nonsecret prepared packet](./setup-packet.json) deliberately contains nulls for facts not yet established; do not submit it as an enrollment request.

## Established custody versus pending proof

Platform732 owns dedicated native service setup. BUILD259 established authenticated Doppler operator and Cloudflare provisioning custody; retained nonsecret evidence is [that rollout receipt](../return-service-rollout/README.md). On BUILD278, names-only tool checks confirmed connected `main/prd` healthy and `CLOUDFLARE_ACCOUNT_EMAIL`, `CLOUDFLARE_GLOBAL_API_KEY`, `VP_PAGES_CF_API_TOKEN` present. No values were retrieved. Native protected env metadata showed no `VP_ROUTINE_VERIFIER_*` keys and mode0600. These observations establish available operator tooling, not a new service identity or current permission to impersonate a human owner.

Original OO custodian a4bc7b0c owns source schema/config injection and BUILD279 exporter. Approved source store is Doppler `ervp/prd`, runtime OrderOpsProduction/production/orderops-web. The proposed NEW routine account is `orderops-routine-source-5a12b745-9946-44ad-98bf-195fba5d5f30`, explicitly confirmed by the source custodian against the exact tuple/origin in the packet. It is not an inferred Railway/CF/native business account and grants nothing until genuine owner enrollment.

Retained277 commit/digest proves only that deployed adapter, not the future scope exporter. **Final deployed279 digest and manifest are required before finalizing trust.** Current native owner/executor membership and the named executor's OWN current capability receipt/credential-custody association must also be established through supported authenticated contracts. Old documented chat→principal strings are not sufficient. No customer or lease probe is needed for the capability receipt.

## Exact operator rollout sequence (separate concrete rollout)

1. Platform732, through existing authorized Doppler/CF operator custody, inspect existing Access apps/service token names metadata and dedupe `orderops-routine-message-verifier` and `nicksworld.dev/api/routine-message/verifier`. If existing resources exist, verify their custody/policy; never rotate/recreate automatically. Prefer an already-authorized narrowly scoped provisioning credential; any global key must remain use-time only and be sent directly to Cloudflare, never source runtime.
2. Provision a **new dedicated** self-hosted Access path application for `/api/routine-message/verifier/*` and a service token. Its Service Auth policy permits only that token; audience/client must differ from human, AutoShip and return. Preserve existing paths/policies. Record only application/token/policy IDs, audience/client and expiry. Store the new client secret directly in `ervp/prd/OO_ROUTINE_VERIFIER_CF_CLIENT_SECRET`; do not print it, write it to a report/temp file or put it in process argv.
3. Install nonsecret `VP_ROUTINE_VERIFIER_CF_AUD` and `VP_ROUTINE_VERIFIER_CLIENT_ID` in the protected native env, preserving other keys/mode0600. Native source/config restart follows an exclusive native queue boundary and passing root checks. Never directly invoke service managers. Test unauthenticated/human/return/AutoShip rejection and dedicated authentication with an absent synthetic draft ID only; no customer capture/claim.
4. OO custodian separately adopts0085 through its pinned supported apply/check contract, then verifies exact runtime injection of `OO_ROUTINE_VERIFIER_ORIGIN=https://nicksworld.dev`, `CF_AUD`, `CF_CLIENT_ID`, `CF_CLIENT_SECRET`, `ACCOUNT_ID`, `PRINCIPAL_ID`, `EXECUTOR_ID`, `BUSINESS_ID`, `SOURCE_ORIGIN`, `ADAPTER_DIGEST`, later `POLICY_ID` and `TRUST_ID` (all names have the `OO_ROUTINE_VERIFIER_` prefix). Secret transfer is approved-store→runtime direct at use; values never appear in logs. Presence in Doppler is not runtime injection. Deployed source enforces the registered Railway tuple. Final279 contract governs any additional required names. Do not copy return token/trust/account values.
5. Platform732 prepares the final **nonsecret reviewed** policy/trust requests from the exact source receipt and current owner/executor proof. Owner performs the genuine authenticated actions below. Source custodian injects returned policy/trust IDs under its exclusive boundary and verifies configuration metadata. No bot manufactures the owner actor or uses borrowed cookies.
6. Source exporter supplies identity observations independent of send readiness. Owner reviews native obligations through the new list/review/bind workflow. Unknown/global/unavailable records remain blockers, not cases to close. Grant independently validates deployed/configured behavior. Only then may the named executor perform separately authorized actual work; exact provider receipt and zero repeats determine business completion. Pre-marker source uncertainty remains a separate denial, not waived by scope registration.

## Actual supported owner actions

In the owner's genuinely signed-in Veneer session, use same-origin authenticated JSON POSTs. Do not execute these from a bot or external credential/session. There is no new account signup or duplicate per-email business approval.

First: `/api/bot-communication/routine-policies/enroll` with exact verified `business_id`, new `policy_key`, `expected_version:0` (or supported current version), stable `request_key`, actual source_reference/policy_text, verified `executor_ids`, and only `categories:["missing_information"]`. Read current policies first via `/routine-policies/list`; do not duplicate existing enrollment. Policy text must preserve BUILD203 limits and source279's narrower evaluator; this is current enrollment, not signing a September22 transcript retroactively.

Second: `/api/bot-communication/routine-messages/trust` with the final `trust_request_template` fields from the packet, replacing every null from verified receipts. Native verifies the configured dedicated audience/client and current owner/executor/policy. Save the returned `trust_id`; no source effect follows automatically.

Third: owner `/routine-messages/hold-scopes/list`, `/review`, `/bind` as specified in [the exact contract](./contract.md). Review requires the original authorized decision and real complete source case closure. This is a current supplemental scope classification, not approval of sending. Unknown scope may be recorded explicitly with no evidence, but it still blocks.

A human can submit a **fully prepared reviewed payload** from the same-origin browser console using the installed endpoint, without sharing cookies:

```js
// Human operator only, after reviewing the finalized nonsecret payload.
const response = await fetch('/api/bot-communication/routine-messages/trust', {
  method: 'POST', credentials: 'same-origin',
  headers: {'Content-Type': 'application/json'}, body: JSON.stringify(reviewedTrustPayload)
});
if (!response.ok) throw new Error('Enrollment rejected; stop and review the response');
await response.json(); // nonsecret trust_id receipt
```

**No owner submit is requested now:** final279 exporter digest, dedicated service identity/injection and current executor custody proof are still absent. The packet lists exactly what the platform/source custodians must finish before presenting one usable owner request. Nick is not being asked to design infrastructure or reapprove a customer email.
