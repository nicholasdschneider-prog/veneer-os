# BUILD443 — bounded authority observations

Authority GET now captures one observation timestamp and exports expiresAt = min(observedAt + 15 seconds, persisted authority expiry, sender evidence expiry, registration expiry). BUILD442 ensures registration expiry cannot exceed credential/custody limits. Dependencies that expire during validation are denied rather than receiving a fresh window. Earlier dependency expiry, immutable tuple/hash, durable expiry, prepare expiry and one-time association semantics remain unchanged. GET returns execute:false, creates no entitlement and cannot renew durable authority.

Deterministic synthetic tests cover long-lived observations, subsequent GET without stored changes, short durable/sender/registration limits, exact expiry and expiry during validation. Initial fixtures attempted an immutable-row update and were correctly rejected; corrected fixtures set bounds before creation or advance the clock. No guard/schema/source changes, credential retrieval or production business actions. Trust activation remains absent. Employee instructions are unchanged, so no catalog change is needed.

Changed files:

- [composedSmsVerifier.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsVerifier.ts)
- [composedSms.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)

Read-only comparison with source server/composed-sms-contract.ts validateAuthority confirms its observation condition: observedAt <= now < expiresAt and expiresAt-observedAt <=15,000ms. Native tests assert those same long/short bounds without changing authority/wire fields. No source files were changed or source application tests executed.

Validation: Node24 root typecheck, focused131, full tests (server2,841 with5 skipped, web909, browser54, installer29), and root production build passed before restart. Standard bundle-size advisory only.

Deployment: `2b44505735e51dcf1e09272994bf5fc09e429618` pushed and restarted using root npm run restart on Node24.21.0. Verified 2026-09-29T00:51:05.384058+00:00: all five services HTTP200 and4,547 matching artifacts; native service registry absent. No activation or business action.

[Runtime receipt](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build443-runtime.json).
