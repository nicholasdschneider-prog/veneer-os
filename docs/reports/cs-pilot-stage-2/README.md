# Customer service pilot, stage 2: standing authority on the ordinary send path

Build #463 · September 29, 2026 · ERVP · commit `0844195`

## Result

**The product-label photo request now waits on one step: Nick's authorization at
`/#/routine-reply-setup`.** Readiness (`/#/cs-readiness`) reports the capability as
"Waiting for owner authorization" with that single blocker. No customer message was sent by this
build, and no policy was enrolled.

## Dependency check

ERVP build #459 landed in OrderOps commit `2ec00ce4`, deployed (`/api/health` gitSha matches):
`POST /api/cs/conversations/:id/messages` accepts `idempotencyKey`, claims it in
`cs_message_send_keys` (primary key on conversation + key) before the row exists, and returns the
original message on replay with 409 on a changed payload. The Veneer claim's `veneer-message:<draft>`
key is what the executor passes there.

## What was built

- `cs_standing_policies` (immutable, one active version per business, revocable), and
  `cs_standing_authorizations` with a unique constraint on business + template + ticket.
- On `save_message_draft`, a named bot's draft whose body equals the fixed template exactly, by email,
  one customer email recipient, empty subject, no attachments, is queued at once with
  `standing_policy.applied=true` and `authorized_by` NULL. Any deviation (one character, SMS, a subject,
  an attachment, another bot, a recorded reject/defer/withdraw on the ticket, an existing request on the
  ticket, the daily cap) leaves an ordinary draft with the reasons listed.
- Claim rechecks the policy, the bot, the draft hash and version; revocation stops every unclaimed
  request and leaves a claimed one to reconcile read-only. Send-once and receipt semantics are unchanged.
- Owner page at `/#/routine-reply-setup`: exact message, limits, bot checkboxes, daily cap (default 20),
  Authorize, and Stop with a reason. The old dedicated-source page moved to `/#/routine-source-setup`;
  its tables and rows are untouched.
- Readiness, tool descriptions and the feature guide updated.

## Tests

17 standing-policy tests (owner-only enroll/revoke and replay, exact-template enforcement across seven
variations, unnamed bot, reject/defer/withdraw by ticket, one per ticket enforced by the database,
daily cap with rollover, revocation before and after claim, issuer or bot removed), 9 readiness tests,
3 setup-page tests. Full suite: server 252 files / 3,068 tests, web 135 / 915, browser manager and
installer green. Typecheck and build passed. Web service restarted; runner untouched (no runner code
changed; ERVP #461 was running).

## Not covered

- The page was not viewed in a signed-in browser.
- The ticket-direction check reads structured decision fields only (bound draft, or
  `message_delivery.payload.ticket`); prose holds in chat are not detected, as before.
- The first real send happens only after enrollment, on a genuinely eligible new case, by a named bot.
