# BUILD510 — bounded opaque Gmail attachment IDs

Native-only compatibility repair for the existing 59766K evidence path. No provider call, customer action or production decision mutation occurred. Implementation is staged, not deployed.

## Change and bound

The Gmail branch of `evidenceSourceSchema` previously trimmed `attachment_id` and capped it at 400 characters. It now accepts nonempty strings up to 4,096 JavaScript string code units and performs no trimming, truncation, normalization, case conversion or format rewriting. This is an explicit local resource limit with headroom above the reported approximately 450-character opaque IDs, not a claim about Gmail's maximum. No format regex is imposed. The existing 24-evidence-item limit continues to bound aggregate proposal input. Optional omission retains its historical meaning; image/document binding still requires an attachment ID.

Only this Gmail field changes. Message/account/filename and OrderOps attachment bounds, strict object fields, conversation/connector access, account selection, source fetch, attachment size/MIME and content-hash checks are unchanged.

## Downstream inspection

Both decision create and revision routes use the shared proposal/evidence schemas, then `bindDecisionEvidence`. The binder passes the unchanged parsed ID to `gmailAttachment`; `composioGmailFetchers` places it directly into `GMAIL_GET_ATTACHMENT` arguments. The MCP evidence source schema declares attachment_id as a string without a conflicting length/format rule. The web evidence display consumes retained hashes; no separate attachment-ID form/parser or URL conversion was found in the inspected source. No downstream widening was needed and no unrelated field was changed.

## Synthetic verification

Disposable SQLite evidence tests exercise 401, 450 and 4,096-character opaque strings, including boundary whitespace and non-ASCII/punctuation, through shared proposal parsing, native raise/revise, evidence binding, retained image readback and the real Composio argument-construction function with a mocked SDK. IDs match exactly on both requests and stored versions. Empty, null, number, object, array and 4,097-character IDs fail before transport; unrelated strict fields and bounds still reject. The missing-account path remains denied without another mocked transport call. Connector resolution/API-key functions are fixtures, not borrowed credentials or proof of production integration.

Final Node 24 validation: root typecheck passed; 59 scoped tests passed; full root suite passed 4,285 tests with five declared server skips (installer 29, server 3,244, web 963, browser-manager 49), using two Vitest workers. Production build passed with a Vite large-chunk warning. Validation details are in [validation.json](/Users/archerclawdington/veneer-os/docs/reports/gmail-attachment-ids/build510/validation.json).

The initial full run and isolated rerun exposed a calendar-expired synthetic registry in the existing approved-case resolver HTTP test (fixed expiry 2026-10-01T00:00:00Z). That test alone now sets its expiry to 60 seconds after its actual run clock. Production expiry enforcement and the resolver’s explicit expired/revoked fixtures are unchanged. The combined evidence/resolver scoped run passed 59 tests afterward. This additional test-only correction is included transparently; no clean initial full run is claimed.

## Deployment and original-owner resumption

No restart is authorized under the outstanding BUILD505 preview-preservation constraint. The latest retained coordination clarification at 2026-10-01T00:12:32.570Z states that runner restart discards process-local pinned bridge proof and no supported continuity/adoption mechanism exists. Generic restart permission would not itself solve that exact-copy recovery. The supplied hold revision is historical context, not live preview proof or permission inferred from expiry. BUILD510 does not reset, probe, recover or destroy that browser. Deployment therefore remains blocked pending resolution of that preservation constraint and an authorized supported service deployment.

Owen retains original case ownership. Preserve the reporter's `out/cs/59766K/2026-10-01` chat_file image workaround and any already-created decision. After actual deployment, Owen must freshly read/deduplicate under own identity and use the current exact decision version. Reconcile an existing decision before any justified update; do not recreate a question or seek duplicate approval solely because the native bound was repaired. Supported long-ID evidence is not approval or permission to send, claim, refund or perform another business action.

No new tool or workflow was introduced; existing capability instructions remain valid. This narrow field compatibility fix does not announce deployed functionality or require a capability catalog change.

## Changed files

- [service.ts](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [approvedCaseResolver.test.ts](/Users/archerclawdington/veneer-os/server/test/approvedCaseResolver.test.ts)
- [decisionEvidence.test.ts](/Users/archerclawdington/veneer-os/server/test/decisionEvidence.test.ts)
- [Report](/Users/archerclawdington/veneer-os/docs/reports/gmail-attachment-ids/build510/report.md)
- [Validation receipt](/Users/archerclawdington/veneer-os/docs/reports/gmail-attachment-ids/build510/validation.json)
