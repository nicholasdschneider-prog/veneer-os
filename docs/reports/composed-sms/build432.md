# BUILD432 — composed SMS evidence consumer

Native implementation continues the existing SMS incident. It directly validates the dedicated correspondence DTO under separate custody, preserves exact human/email/draft evidence, records prospective composition authority only when required evidence exists, and implements named-executor acceptance, single-use claims, UNKNOWN reconciliation, receipts and revocation. The ordinary draft and original email answer remain unchanged. A supplemental duplicate guard prevents ordinary claims against derived actions.

**Live SMS is not enabled.** Source v1 explicitly supplies no verified sender ownership or accepted native-action transport. Its consumer returns correspondence facts and the sender proof blocker, without inventing a relationship, sender identity or transport. The positive single-use lifecycle is verified with a synthetic server-owned adapter only. No production authority/obligation/draft/claim/customer/provider mutation or credential retrieval was performed.

## Original-owner next step and source dependency

The source owner must supply the deployed dedicated correspondence receipt and scoped read-use custody extension, then implement/agree current sender evidence and native action/executor/sender/unchanged-wire-payload dispatch association. Existing manual SMS payload deduplication and configured credentials do not satisfy those contracts. No new customer choice is identified and no duplicate approval is requested.

Once those facts and accepted source adapter exist, original Grant performs `inspect_composed_sms` on the actual current source/draft/version and both exact case UUIDs, reviews the complete context and derives the exact reply prospectively. Original Tess alone accepts and executes only a first supported claim. Any uncertainty stays on the original action; no generic manual-send fallback. Platform does not impersonate either bot. See the [executable contract](./contract.md).

## Validation and deployment

Root Node24 typecheck and the focused suite passed (87 tests). Full root npm test passed: 2,746 server tests (5 skipped), 909 web tests, 54 browser-manager tests and29 installer tests. Coverage includes semantic-review provenance, exact body spans, channel-only/ambiguous denial, source identity/hash/completeness, account custody before credential retrieval, copied drafts, concurrent/replayed claims, transport/context drift, revocation, expiry, UNKNOWN and receipts. Employee full/restricted and resumed-agent catalog delivery passed. Root production build and git diff --check passed; Vite emitted its existing chunk-size advisory. Deployment receipt follows after restart. No live acceptance test was performed.

## Changed files

- [composedSms.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSms.ts)
- [composedSmsReader.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsReader.ts)
- [communication.ts](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [instructionObligations.ts](/Users/archerclawdington/veneer-os/server/src/bots/instructionObligations.ts)
- [routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [config.ts](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [0130_composed_sms_authorities.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0130_composed_sms_authorities.sql)
- [composedSms.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)
- [composedSmsReader.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsReader.test.ts)
- [composedSmsTools.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsTools.test.ts)
- [botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [contract.md](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/contract.md)
