# Customer service pilot, stage 1: baseline and readiness

Build #460 · September 29, 2026 · ERVP · implements the
[accepted plan](/Users/archerclawdington/veneer-os/docs/reports/fin-customer-service-plan-2026-09-28.md)

## Result

**No customer service task runs without per-message approval today, and the reason is now visible
on one page: `/#/cs-readiness`.** The build's exit condition allowed either a live-for-pilot first
capability or the exact named blocker and owner. It delivers the second. The standing-authority photo
request cannot go live from the Veneer side: its two remaining dependencies belong to the OrderOps
source owner and then to Nick.

Delivered and verified:

| Part | Delivered | Verification |
| --- | --- | --- |
| A. Baseline | This report, from native records | Reproducible with `scripts/cs-outcome-report.mjs` |
| B. Blocker map | Below; no new send path was added | Live readiness read of production records |
| C. Readiness view | `/#/cs-readiness`, `read_cs_readiness` bot tool | 10 server tests, 2 web tests |
| D. Test harness | Saved scenarios, deterministic checker, controlled delivery tests | 7 + 7 tests; two model runs |
| E. Outcome report | Generator with results by model group | Tested; first run is the baseline below |

Not delivered: an automatic quality review of closed pilot cases. No pilot case exists yet, so there
is nothing to review. The deterministic checker is its first half; a calibrated reviewer for tone and
factual support is still to build.

## Correction to the plan

Kickoff decision 2 referred to "the existing enrolled product-label-photo scope". **Nothing is
enrolled.** The production database holds zero standing policies, zero source connections, zero source
proofs and zero routine sends. The photo-request policy exists as prepared text and as bot training,
and the owner setup page has never been able to open for authorization because its source evidence
is unset (`source: null` in
[preparedRoutineRegistration.ts](/Users/archerclawdington/veneer-os/server/src/bots/preparedRoutineRegistration.ts)).
The decision stands as a scope limit; it does not describe a working authority.

## Baseline, September 22 to 29

Customer Service subteam: Avery, Grant, Miles, Nora, Owen, Tess. Source:
[baseline-week.json](/Users/archerclawdington/veneer-os/docs/reports/cs-pilot-stage-1/baseline-week.json);
the period since September 19 is in
[baseline-all.json](/Users/archerclawdington/veneer-os/docs/reports/cs-pilot-stage-1/baseline-all.json).

| Measure | Week |
| --- | --- |
| Bot turns | 1,440 |
| Decisions raised to a person | 76 |
| Approved | 61 |
| Approved and verified complete | 20 (33%) |
| Approved and then blocked | 30 (49%) |
| Approved and still open | 11 (18%) |
| Human answers recorded | 100 |
| Human discussion messages on decisions | 123 |
| Native drafts created | 56 |
| Drafts sent with a receipt | 0 |
| Drafts never authorized | 49 |
| Claimed sends with unknown outcome | 2 |

The earlier starting number (310 turns, 7 decisions) covered Miles, Nora, Owen and Tess only. Grant
raised 56 of the week's 76 decisions and Avery 13, so most human approval load runs through the lead
and triage roles, not the four case owners.

**Two of every three approvals did not produce a completed action.** Nick answered 100 times and
wrote 123 further messages on these decisions in one week.

### Delay after approval

| Interval | Count | Median | 95th percentile |
| --- | --- | --- | --- |
| Approval to first recorded result | 61 | 3.3 min | 100 min |
| Approval to verified completion | 20 | 17.5 min | 263 min |

Bots respond to an approval quickly. The delay is small when work completes; the loss is the work
that never completes. Queue, startup, investigation and external waiting are not recorded separately,
so that breakdown cannot be reported yet.

### Why approved work was blocked

I read the recorded result of each of the 30 approved-then-blocked decisions and classified it.

| Cause | Count | What it means |
| --- | --- | --- |
| Approval could not be bound to a send | 8 | The approved message lacked structured delivery fields, or the case identifier did not equal the ticket number |
| Missing internal operational fact | 7 | Warehouse allocation, physical carton, routing or inspection record that no bot can read |
| Integration not configured or not built | 5 | Return verifier unconfigured, partial-refund action missing, issuer work not built |
| A person or another channel already handled it | 5 | The approval arrived after the customer was answered elsewhere; the block prevented a duplicate |
| Missing payment or gateway evidence | 3 | No access to the processor ledger needed before a refund |
| Missing vendor or fitment evidence | 2 | Manufacturer facts not available |

Technical causes account for 13 of 30 (43%). Missing facts account for 12 (40%): these are not
reasoning failures and no training change fixes them, because the bot has no access to the fact.
Five (17%) were overtaken by a person doing the work directly.

This data does not show reasoning quality. A blocked result records why an approved action stopped,
not whether the original proposal was the right one.

## Blocker map for the first capability

| Step | State | Owner |
| --- | --- | --- |
| Dedicated routine service connection | Configured | Platform Dev |
| Veneer policy, proof, claim and readback handling | Built and tested | Platform Dev |
| OrderOps routine source adapter deployed, with receipts | **Not supplied** | OrderOps source owner |
| Owner authorizes the policy at `/#/routine-reply-setup` | Opens after the adapter | Nick |
| First source proof and verified send | Follows authorization | Named sending bot |

The approved customer reply (one approval, one send) is also reported blocked today: three claimed
sends by Avery have no recorded receipt, and one message authorized for Nora is overdue. Those need
read-only reconciliation by their owners. They must not be sent again.

### Decision needed from Nick

Build #459 in the ERVP workspace is making the ordinary approve-then-send path durable and retiring
the composed-SMS subsystem, on Nick's instruction to simplify. The routine photo-request path depends
on a second dedicated OrderOps adapter of the same design family. Two options:

1. **Build the adapter as designed.** Most protective; largest remaining OrderOps work; the same
   pattern that has not yet sent a message.
2. **Grant standing authority on the ordinary path.** After #459 lands, let the named bot send the
   fixed label-photo request through the ordinary route without a per-message approval, using its
   idempotency key and receipt. Far less to build. It needs a smaller Veneer change and Nick's
   explicit enrollment.

I recommend option 2, decided after #459 reports its result. Neither is started.

**Nick chose option 2 in chat on September 29, 2026.** This selects the design to build. It is not the
policy enrollment: standing authority begins only when Nick authorizes the finished policy himself on
the owner setup page.

## Test harness

Saved scenarios live in
[damaged-or-wrong-item.json](/Users/archerclawdington/veneer-os/server/test/fixtures/cs-scenarios/damaged-or-wrong-item.json):
eight synthetic cases, including the single-shipped-unit correction, multi-item ambiguity and a
customer correction mid-case.
[csScenarios.ts](/Users/archerclawdington/veneer-os/server/src/bots/csScenarios.ts) grades a proposed
next step on action, recipient, account, unnecessary requests, subject, standing authority, human
direction and unauthorized commitments. Wrong recipient, wrong account, sending against a hold, and
an unauthorized promise are critical.

Controlled delivery tests in
[csPilotDelivery.test.ts](/Users/archerclawdington/veneer-os/server/test/csPilotDelivery.test.ts) use
a synthetic provider and cover a duplicate inbound event, a repeated save, a send without
authorization, an edit after approval, a timeout after provider acceptance, and a restart after a
claim. In each case the provider is called at most once.

Not covered by a platform test: a new customer message arriving between approval and send. The
ordinary path has no source freshness check in Veneer; the executor checks the source before sending.
Build #459 does not add one either.

### First model runs

A candidate
[focused procedure](/Users/archerclawdington/veneer-os/docs/reports/cs-pilot-stage-1/procedure-damaged-or-wrong-item.md)
of about 450 words was tested against the eight scenarios, one isolated Claude Sonnet run per case.

| Run | Procedure | Passed | Critical |
| --- | --- | --- | --- |
| [1](/Users/archerclawdington/veneer-os/docs/reports/cs-pilot-stage-1/scenario-run-1.json) | Version 1 | 7 of 8 | 0 |
| [2](/Users/archerclawdington/veneer-os/docs/reports/cs-pilot-stage-1/scenario-run-2.json) | Version 2 | 8 of 8 | 0 |

Run 1 answered a cracked valve with a label-photo request. The procedure did not separate damage from
a wrong item. Version 2 adds that row; the rerun passed with no regression. This is the
find, fix, rerun loop the plan describes, completed once.

Limits: eight scenarios and one run each is a smoke test, not the 100 held-out scenarios in the plan.
The runs used Claude Sonnet through this chat's subagents, not the production bots with their full
training, and not GPT-6 Sol. The built-in model runner in `scripts/cs-scenarios.mjs` could not be
exercised because the command-line model is not signed in for this shell; the prompt-export and
answer-grading modes were used instead.

## Evidence limits

- Counts come from native Veneer decisions, drafts and turns. Customer messages sent directly in
  OrderOps or Gmail without a native draft are not counted. Several blocked results cite such sends,
  so the true number of customer replies last week is above zero and unmeasured here.
- The plan's review of 100 cases stratified by intent needs OrderOps case data, which this chat
  cannot read. That part of the baseline is not done.
- Human minutes are not recorded anywhere. Answers and messages are counts of interactions.
- Verified completion is the owning bot's recorded result, not an independent source readback.
- Model group is the chat model at report time. All six bots were on Codex models during the
  baseline week, so there is no trial-versus-control difference to report yet.

## Validation

`npm run typecheck` passed. `npm test` passed: server 251 files and 3,052 tests, web 134 files and
912 tests, with browser manager and installer suites passing. `npm run build` passed.

## Deployment

Commit `7e8f97f` was pushed to `origin main`. Only the web service was restarted
(`node scripts/restart.mjs veneer-pro`): it came back healthy, and the built page asset and bot tool
are present. The runner, app runner and terminal services were left running on purpose. This build
changed none of their code, and restarting the runner would have interrupted ERVP build #461, which
was running at the time. Bots receive `read_cs_readiness` on their next turn.

Not verified: the page in a signed-in browser. Unauthenticated local requests return 403 by design,
so the readiness shown above was read through the same service code against the production
database, read-only.
