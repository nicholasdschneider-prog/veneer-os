# AutoShip candidate interface — BUILD299

Implemented native authenticated order/stock candidate notifications for the existing ERVP worker only. No ticket event impersonation, polling, new executor or shipping authority. [Executable contract and setup](./contract.md) includes exact source and owner endpoints, DTOs, receipts, errors, freshness, key custody and revocation ordering.

The original OrderOps owner reviewed the documented contract as compatible with its planned adapter. Stock provenance distinguishes confirmed receipt from authenticated stock update, with exact inventory item/location. Source uses numeric Shopify IDs and validates the complete canonical payload hash. Source implementation/provisioning/enrollment and independent live acceptance remain outstanding. No source registration, credentials, customer/provider action, or live notification was used to test this release.

## Validation

Root typecheck, full npm test and build passed: server2,441 passed/5 existing skipped, web880, browser-manager40, installer21. Additional final manager integration fixture passed with the8-test candidate suite: identical wake replay remains duplicate and revocation suppresses queued candidate work without interrupting unrelated work. Focused candidate routes, existing bot and scheduler suites passed80 tests before that additional fixture. Full/restricted guide browser checks passed; catalog/current-resumed instruction tests passed. Existing bundle-size warning remains advisory.

Synthetic tests cover source owner/bot/foreign identity, dedicated config separation, exact immutable event replay, payload conflict, source/account/business/recipient/order binding, required stock provenance, lost-response read-only reconciliation, revocation/worker inactivity/owner change, no shipping authority, durable manager receipt and real competing SQLite connections at acceptance and queued-start admission. No runtime source was enabled.

## Implementation files

- [Candidate service and schemas](/Users/archerclawdington/veneer-os/server/src/botWorkflows/autoshipCandidates.ts)
- [Dedicated authenticated ingress](/Users/archerclawdington/veneer-os/server/src/botWorkflows/autoshipCandidateRoutes.ts)
- [Immutable ledgers](/Users/archerclawdington/veneer-os/server/src/db/migrations/0121_autoship_candidates.sql)
- [Owner setup and revocation routes](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [Wake access checks](/Users/archerclawdington/veneer-os/server/src/bots/delivery.ts)
- [Transactional queue and start guards](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Separate runtime configuration](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [Service-only mount](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [Employee and resumed-bot guidance](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Service, race and manager fixtures](/Users/archerclawdington/veneer-os/server/test/autoshipCandidates.test.ts)
- [Transport boundary fixtures](/Users/archerclawdington/veneer-os/server/test/autoshipCandidateRoutes.test.ts)

## Deployment receipt

Code `2c5fd62` pushed to origin main and deployed through detached root restart. All five services reported healthy: web75365, runner75383, app-runner75411, terminal75687 and browser-manager. Read-only verification 2026-09-24T16:24:10.700102+00:00: web/runner and browser-manager HTTP200; unauthenticated synthetic reconciliation path HTTP401, Dedicated candidate identity required. Schema-only inspection confirms four candidate tables and eight immutable triggers from0121. No live event/enrollment/customer rows were read or written for verification.

Interface deployed; dedicated CF/config, reviewed source registration, source adapter and live acceptance remain separate prerequisites. This release does not activate normal AutoShip execution.
