# Direct-human vendor email binding — build 533

The repair adds a native, prospective authorization record for an original bot’s exact vendor email reply. It does not turn an ordinary draft into a human-approved draft, invent a delegation, or send email automatically.

## What changed

- `read_vendor_email_context` discovers authentic source IDs and returns bounded complete native direct messages, original result anchors/replies, shared voice dispatches, decisions and drafts. Caller-private voice sessions are not exposed. Voice dispatches are correction/hold context, not substituted direct-message authority.
- `inspect_vendor_email` binds the proposed email to an authenticated human source in the original executor’s own conversation. The executor semantically reviews unconditional composition **and** sending, the full instruction, every later human message, existing draft/decision records, all body spans and scope support. Status, quoted reports, wording edits, conditions and ambiguity do not confer authority. Context drift requires fresh inspection/review; there is no keyword consent classifier.
- `bind_vendor_email` persists immutable exact source, author, executor/user/business, account, one recipient, thread/replied-to message, subject/body and attachment hashes. Actual retained attachment bytes are checked under existing chat-file ACLs. Stable-key retries read the existing binding. Sources already consumed by native decision answers cannot mint another vendor authority; the original approval path and named executor remain binding. Old drafts, approvals and financial records remain untouched.
- `claim_vendor_email` rechecks original ownership, registration, active human access, complete current context, attachment bytes, current semantic review and five-minute executor source/permissions/duplicate/ownership observations. Only the first committed claim returns `execute:true`. The original bot must use its existing authorized Gmail connection once and recheck source/bytes immediately before dispatch.
- A durable business/account/thread fence and source fence survive replacement keys, UNKNOWN, failure and revocation. An explicit unclaimed correction may create an immutable successor for the same thread/recipient and executor. Once claimed, no successor or second attempt is possible. Concurrent identical binds reconcile, and concurrent claims return at most one execution response.
- `read_vendor_email`, `record_vendor_email_delivery` and `revoke_vendor_email` preserve immutable attempt/receipt history. Sent means verified provider acceptance reported by the original executor, not recipient delivery. Exact provider/message/account/recipient/thread/replied-to message/payload/idempotency proof is required; a receipt cannot be reused for another attempt. Receipt reconciliation grants no new send.

This follows the existing original-executor delivery trust model. Native code does **not** independently fetch Gmail or atomically mediate the subsequent browser/connector click. Source observations and receipt proofs are accountable executor readback, not authenticated server-side Gmail attestations. Existing connector/browser permissions, ownership and tool approval gates remain required. No sender transport, credential grant, profile or login is installed or changed.

The feature intentionally supports one recipient, retained PDF/image attachments, one thread per native human instruction and one attempted reply per thread. For ambiguous overlap, ordinary native draft claims to the same business/account/recipient are conservatively blocked; prior authorized/attempted ordinary messages to that recipient also block a new binding pending reconciliation. This is not general multi-recipient email or financial authority.

## Reconciled live context (read-only)

The September 30 diagnosis in coordination `c290431e-88fd-4fa1-8b68-06ac50501009` was confirmed: ordinary drafts lacked native `authorized_by`; existing composed-message derivation was SMS-only. CS-lane presentation did not establish vendor-email authority.

The October 2 refresh also found a scope mismatch:

- Clara’s authenticated September 30 direct human source `ae0bb34f-c473-451f-9deb-548fd20b6b3e` requests a corrected existing PO and a reply with the updated PDF. Continuing applicability must be reviewed by original Clara against all later context and actual source evidence.
- The reported October 2 voice instruction was in Finn’s original conversation `fba422e0-f9a7-43b5-b130-f4cbe4034380`, turn `2ec223d4-0078-44e5-a08a-73b67f4ae8a9`. It was not a native direct-human source in Clara’s conversation. No source UUID, author, executor or consent was fabricated or imported from its forwarded report.
- Clara’s retained visible draft `9c9af016-1157-4e89-a6ad-7d9ccdc9421e` is the separate LCI8045 apology, without an attachment, on thread `1a0ed9fec122364a`. It cannot stand in for the corrected ADB PO reply on `1a0ed1e465e92446` to message `1a0eda3dbb69a40b`.
- The handoff did not establish the exact current subject/body/recipient list for the ADB reply. Original Clara must establish these through her own authorized mailbox access, along with fresh duplicate/UNKNOWN state and the attachment contents/hash. This is evidence/execution work, not a request for duplicate human consent.
- Finn’s native same-PO resend receipt `1001282` at `2026-10-02T12:03:35.861Z` remains reported source evidence, not independently verified provider delivery by Platform Dev. It must not be replayed. The separate accounting-thread reply remains with original Clara `7f83ff8e-43a3-4c16-b2bd-c304dd946d11`.

No production authority, claim, draft edit, business send, purchase-order action, profile/login mutation or grant change was performed by this build. No accounting action is certified by these tests.

## Validation and deployment

Root typecheck passed. The final full `npm test` passed: 3,335 server tests (15 existing skips), 968 web tests, 51 browser-manager tests and 29 installer tests: **4,383 passed**. All 40 new vendor-email tests passed. The guide browser fixture passed for full/restricted roles, the new callout and mobile/desktop rendering; normal/elevated instruction delivery passed.

Two default-concurrency runs timed out in different unchanged browser-viewer tests; the affected file passed alone. The complete final suite passed with `VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1`. No assertions or timeouts were weakened and no tests were newly skipped. The final root production build passed (only the existing Vite chunk-size advisory). Implementation commit `488b08a` was pushed to `origin main` before restart. The authorized root restart interrupted this agent after web/runner replacement; fresh inspection confirmed the restart process had stopped, web and runner were healthy, and build #533 still owned the slot. The remaining app-runner, terminal and browser-manager services were then restarted through `npm run restart -- veneer-pro-app-runner veneer-pro-term veneer-browser-manager`, without repeating the web/runner restart.

Independent readback at **2026-10-02 12:58:11 UTC** confirms all four application PIDs changed and are running, the browser manager is healthy, and the live migration `0146_vendor_email.sql` hash exactly matches both source and built SQL. The compiled MCP catalog contains all seven vendor-email tools and the guide release is marked new. Native production vendor authority/claim counts were both zero. See [the deployment receipt](./build533-deployment.json).

`npm run health` reports healthy local web/runner and four tunnel edge connections. The public front door responds HTTP 302; authenticated end-to-end chat delivery and an actual Clara email were **not** tested. Service health and migration readback are deployment evidence, not business acceptance.

Synthetic coverage includes preserved pending business holds, rejection of already-consumed decision sources, source/actor attribution, wrong or revoked owners/authors, later corrections and voice holds, exact scope drift, changed/unregistered attachment bytes, body coverage, immutable history, old-draft preservation, cross-path duplicates, concurrent binding/claim, permanent UNKNOWN/failure fencing, exact receipt scope and duplicate receipt rejection. Tests never contact Gmail or run business actions.

The isolated guide browser fixture verifies full/restricted employee access, the new-feature callout, search, desktop/mobile layout, refresh and aging. Catalog/instruction tests verify normal/elevated fresh/resumed delivery without changing frozen role snapshots.

## Changed files

- [Native vendor-email service](/Users/archerclawdington/veneer-os/server/src/bots/vendorEmail.ts)
- [Immutable authority and attempt migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0146_vendor_email.sql)
- [Native communication routes](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [Ordinary draft duplicate guard](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [Vendor-email MCP definitions](/Users/archerclawdington/veneer-os/server/src/mcp/vendorEmailTools.ts)
- [MCP discovery and routing](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [Employee and agent capability catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Feature guide release documentation](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Behavioral and HTTP tests](/Users/archerclawdington/veneer-os/server/test/vendorEmail.test.ts)
- [Employee/resumed-agent contract tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Isolated guide browser verification](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/vendor-email/build533.md)


## Retained verification artifacts

- [Typecheck log](/Users/archerclawdington/veneer-os/out/build533-typecheck.log)
- [Final full test log](/Users/archerclawdington/veneer-os/out/build533-tests.log)
- [First viewer timeout](/Users/archerclawdington/veneer-os/out/build533-tests-timeout.log) and [second viewer timeout](/Users/archerclawdington/veneer-os/out/build533-tests-timeout-2.log)
- [Production build log](/Users/archerclawdington/veneer-os/out/build533-build.log)
- [Initial restart log](/Users/archerclawdington/veneer-os/out/build533-restart.log) and [remaining-service restart log](/Users/archerclawdington/veneer-os/out/build533-restart-remaining.log)
- [Post-deployment health log](/Users/archerclawdington/veneer-os/out/build533-health.log)
- [Before-deployment process/migration snapshot](/Users/archerclawdington/veneer-os/out/build533-before.json)
- [Independent deployment receipt](/Users/archerclawdington/veneer-os/docs/reports/vendor-email/build533-deployment.json)
- [Isolated guide verification log](/Users/archerclawdington/veneer-os/out/build533-guide.log), [vendor feature desktop capture](/Users/archerclawdington/veneer-os/out/build533-guide/vendor-email-desktop.png), and [restricted employee mobile capture](/Users/archerclawdington/veneer-os/out/build533-guide/vendor-email-employee-mobile.png)
