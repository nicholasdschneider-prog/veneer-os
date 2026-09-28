# BUILD439 — strict composed SMS readback

Native-only schema alignment with the current source438 contract. Readback expiry
and nullable UUID redemption key are required; REDEEMING requires a nonnull key.
Association request keys must be UUIDs. Sender account IDs and receipt revisions use
the exact source AC regex and positive safe-integer constraints.

The source contract was inspected read-only at
`Order Ops/server/composed-sms-contract.ts`. No source edits, credentials, provider
reads, production authority changes, migrations or protected configuration changes
were made. No sender adapter or service trust is enabled.

The new synthetic golden fixture uses a valid AC account and recomputed dependent
digests; the historical BUILD437 vector is preserved. Wire/authority/binding canonical
algorithms and the required original payload/source hash commitments are unchanged.
No full authority extension is needed in source readback.

Focused tests passed: 86 across three files. Regression coverage includes absent and
invalid fields, null REDEEMING key, unsafe revision, invalid account IDs, strict
readback shape, forged matching binding hashes, and expiry/replay without renewed
entitlement. Current user/agent instructions do not change, so no catalog revision
is needed for this parser-only correction.

## Files

- [composedSmsContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsContract.ts)
- [composedSms.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)
- [composedSmsHashes.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsHashes.test.ts)
- [composedSmsVerifierRoutes.test.ts](/Users/archerclawdington/veneer-os/server/test/composedSmsVerifierRoutes.test.ts)
- [contract.md](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/contract.md)
- [build439-golden.json](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build439-golden.json)

## Validation

Node24 root typecheck and the full root test suite passed before deployment: server 2,810 passed / 5 skipped, web 909 passed, browser-manager 54 passed, installer 29 passed. Full-suite guide and instruction tests remain passing. Focused tests: 86 passed.

Root production build passed (standard large-bundle advisory only); whitespace diff check passed. No migration was needed.
