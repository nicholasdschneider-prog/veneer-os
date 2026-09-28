# BUILD437 — original payload and human-source hashes

The strict prospective authority tuple now includes `payloadHash` and
`sourceInstructionHash`. Creation verifies the full saved payload and original
source/consumption provenance; service reads recheck both against the immutable saved
snapshot. The authority hash commits both fields. Wire hashes and explicit binding
field selection are unchanged. Missing proof fails closed; nothing is retrofitted.

The read-only native compatibility check found **zero positive dispatch authority
records** before editing. No production records, credentials or provider endpoints
were used for testing. No migration or protected registry/config change was made.

The retained exact confirmation `build436-dto-authority-hash-auth-confirmation-v1`
was read from its authorized coordination delivery (message16,23:30:24UTC); the
normal coordination reader had not yet included that queued message. Source locator,
server-generated redemption key, prepare-expiry readback and dedicated auth semantics
are preserved. This narrow correction does not enable sender or service transport.

## Shared fixture and changes

The golden vector was independently generated with Python sorted compact UTF-8 JSON.
Tests verify canonical bytes, authority/binding digests, missing/tampered tuple fields,
changed body, mismatched stored hashes and original actor/source provenance.

- [Golden fixture](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build437-golden.json)
- [Tuple schema](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsContract.ts)
- [Original proof checks](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsAuthority.ts)
- [Service validation](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsVerifier.ts)
- [Hash regression tests](/Users/archerclawdington/veneer-os/server/test/composedSmsHashes.test.ts)
- [Lifecycle regression tests](/Users/archerclawdington/veneer-os/server/test/composedSms.test.ts)
- [Employee/resumed-agent catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Contract](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/contract.md)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build437.md)

Validation and deployment receipt follow below. Actual sender/guard evidence and
service custody remain unavailable; no customer approval, derivation or dispatch was
performed by the builder.

## Validation

Node24 root typecheck passed. Focused tests:114 passed across8 files, including employee/restricted guide and resumed-agent instruction coverage. Full root tests passed: server2793 passed/5 skipped, web909, browser-manager54, installer29. Root build and diff whitespace checks passed before restart. The shared fixture checks full UTF-8 canonical bytes independently generated in Python.

## Deployment

Implementation `7ea08f36ea9eaa4d009b1b2be4e57e7f7f21c0cf` was pushed to origin main. Supported root `npm run restart` completed on Node24.21.0. At 2026-09-28T23:42:39.849794+00:00, all five local services returned HTTP200 and all4545 built artifacts matched the pre-restart inventory. Both protected reader registries retained their hashes, UID501 and0600 regular-file permissions. Public front door returned302; authenticated end-to-end chat was not tested.

[Runtime receipt](/Users/archerclawdington/veneer-os/docs/reports/composed-sms/build437-runtime.json). Source436 can adopt the required tuple fields and shared golden vector now. Actual sender/guard/service trust remain separate unavailable prerequisites; this deployment performed no customer action or production authority creation.
