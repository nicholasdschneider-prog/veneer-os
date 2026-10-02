# Decision evidence schema alignment — BUILD541

The callable raise/update evidence source schema was a flattened object requiring
only `system`. It advertised cross-variant fields the server correctly rejected.
The repair uses nested `anyOf` strict objects with singleton system enums, the
server's required fields and source bounds. No discriminator extensions or
conditional JSON Schema keywords are needed. Both tools share the same schema.
Gmail attachment IDs retain their opaque, untrimmed 4096-character allowance.

Generic and AutoShip proposal acceptance schemas are unchanged. On rejection,
the HTTP wrapper diagnoses the applicable proposal branch, expands nested union
errors, and reports schema-owned paths and fixed error descriptions. It emits no
submitted values, unknown field names or raw Zod messages for proposal errors.
Diagnostics are limited to 12 unique messages, 80 visited issues, depth 6 and 16
path components, with an explicit omission notice. Unknown fields are reported at
the containing object; tool instructions identify allowed fields. AutoShip remains
a separate accepted variant with its original guards. No file-access, account,
MIME, size, hash, refund, approval or execution checks are relaxed.

## Tests and scope

Offline JSON Schema validation checks both actual tool definitions and server
source/proposal parsers with valid images and records, missing IDs, cross-variant
fields, Gmail bounds and invalid types. The installed lockfile-pinned Ajv is used
only for these tests; no dependency changes. Disposable SQLite/HTTP fixtures prove
raise/update errors arrive before attachment fetch or decision mutation. Existing
attachment transport/retention tests remain intact. Catalog tests cover employee
access and full/restricted fresh/resumed instruction delivery. No live provider,
customer, decision, refund, lease or credential action was performed.

Initial new-test iteration exposed missing synthetic choices and an assertion
beyond the intended diagnostic cap; those fixture expectations were corrected.
The first full run also found a materializer test that forbade any Shopify mention
in all instructions. The new source guidance necessarily names Shopify; the test
now compares instructions before/after actual connector enrollment, preserving the
stronger guarantee that configuration adds no connector prose. Final validation: root typecheck passed; 76 focused tests passed; full suite
passed with 4,419 tests and 15 declared skips (installer 29, server 3,359, web
980, browser manager 51). Root build passed with the Vite chunk-size advisory
only. Hashes and disposition are recorded in [validation.json](./validation.json).

## Deployment disposition

**Staged, not deployed. No restart performed.** Boris's response in coordination
9c58c4e8-e076-4954-8032-b32851ef4c01 at 2026-10-02T21:03:43.671Z confirms no exact
original-owner BUILD505 preservation release or BUILD541 deployment authority is
established. Later BUILD529/533 restart receipts do not supply that release.
Hold expiry is not consent. No browser recovery, navigation, export, process
control or bypass was attempted. Runtime behavior is not claimed to have changed.

## Original-owner resumption

Avery retains A9C2787E95/order100118158. After actual deployment, Avery must freshly
reconcile existing cards, source/proposal keys and the exact current version before
any separately authorized submission. Preserve valid photos/artifacts/payloads;
verify missing IDs and actual file ownership/observation times. `orderops` needs
`ticket_id`, not order IDs or conversation IDs. `chat_file` needs conversation ID
and path, without filename. `shopify` needs order ID. A null source account/refund
field is not independently complete refund evidence. No duplicate question,
approval, automatic submission or business mutation follows from this repair.

## Changed files

- [Callable schemas](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [Proposal diagnostics](/Users/archerclawdington/veneer-os/server/src/bots/proposalDiagnostics.ts)
- [HTTP integration](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [Schema tests](/Users/archerclawdington/veneer-os/server/test/decisionEvidenceSchema.test.ts)
- [Evidence integration tests](/Users/archerclawdington/veneer-os/server/test/decisionEvidence.test.ts)
- [Capability catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Connector-prose regression test](/Users/archerclawdington/veneer-os/server/test/materialize.test.ts)
- [Guide delivery tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Employee guide](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Validation receipt](/Users/archerclawdington/veneer-os/docs/reports/decision-evidence/build541/validation.json)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/decision-evidence/build541/report.md)
