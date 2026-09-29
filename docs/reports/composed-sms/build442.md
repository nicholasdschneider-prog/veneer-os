# BUILD442 — composed service expiry bounds

Required protected credentialExpiry evidence binds actual token UUID/expiry, custody cap, bearer/readback expiry, verification actor/time and immutable receipt hash. Schema and use-time checks reject missing evidence, future verification and registration expiry beyond any dependency. Equality at expiry is denied. Existing inactive/revocation, registration hash drift and one-shot association safeguards remain enforced. Registration hashing commits all new evidence; no old authority is retrofitted.

Historical provisioned.json expiresAt remains the requested cap, now explicitly labeled; effectiveExpiresAt is 2026-10-28T00:14:26Z. Permission receipt and protected429/434 registries unchanged. No credential retrieval, renewal, source edits, provider probes or customer/business actions. Registry remains absent. This does not supply scope closure/classification, source writer acceptance or positive current-process sender evidence. The expired candidate sender observation cannot be extended.

The loader validates protected operator attestations, not live CF token status. Earlier revocation is enforced through active registry/current dependency checks; actual custodian verification and disablement remain required. No claim of distributed token-revocation discovery.

## Changed files

- [composedSmsTrust.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsTrust.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [composeGuardFixture.ts](/Users/archerclawdington/veneer-os/server/test/composeGuardFixture.ts)
- [composedSms.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)
- [composedSmsVerifierRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsVerifierRoutes.test.ts)
- [contract.md](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/contract.md)
- [provisioned.json](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/setup/provisioned.json)
- [activation-plan.json](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/setup/activation-plan.json)

## Validation

Node24 root typecheck passed; focused 144 passed; full root tests passed (server2,837 with5 skipped, web909, browser-manager54, installer29). Root build passed before restart; standard bundle-size advisory only. No production business acceptance tests.

## Deployment

Implementation `8aec7c36896038d5a6c4bc04c9f94a683ff8610c` pushed and deployed through supported root restart on Node24.21.0. At 2026-09-29T00:42:56.296019+00:00, all five actual service health endpoints returned200; all4,547 build artifacts matched. Initial generic /health probes were corrected to the service-specific paths used by restart.mjs (retained in receipt). Protected429/434 files remain unchanged UID501/0600. Compose service registry remains absent. Public front door302/tunnel healthy does not verify authenticated customer workflow.

[Runtime receipt](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build442-runtime.json).
