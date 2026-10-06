# Sonnet 5.5 customer service trial

Requested by the owner on 2026-09-29: run half of the customer service bots on Claude Sonnet 5.5,
leave the other half on Codex GPT-6 Sol, and compare after one week.

## Groups

| Group | Bot | Conversation | Model |
|---|---|---|---|
| Trial | Nora | `e9fe9b64-9b75-4280-b795-42158ae9cf16` | `claude` / `claude-sonnet-5-5` / medium |
| Trial | Owen | `26c325f7-32de-46ec-80f1-1c28e75d4b37` | `claude` / `claude-sonnet-5-5` / medium |
| Control | Miles | `8540bd53-1a6f-440e-a136-4a4c7ac7f940` | `codex` / `gpt-6-sol` / medium |
| Control | Tess | `1e96b7bb-1071-4f1d-b710-310f9fbbc9e1` | `codex` / `gpt-6-sol` / medium |

Grant (lead, GPT-6 Astra) and Avery (ticket triage, GPT-5.6 Sol) are outside the trial: their roles
differ from the four customer service agents, so they would not compare like for like. Tess stays in
the control group because Tess holds sender custody for composed SMS work.

The split balances the last seven days of turns: trial 151 (Nora 69, Owen 82), control 159
(Miles 74, Tess 85).

## Status

The trial bots are **not switched yet**. `POST /api/conversations/:id/model` refuses agent callers
("Only a user can switch the chat provider"), so the switch is made by a signed-in user from the
model picker in each bot chat. The trial week starts at the switch notice recorded in each chat.

## Baseline, 2026-09-22 to 2026-09-29 (all four on GPT-6 Sol, medium)

| Bot | Turns | Stopped turns | Decisions raised | Decision states | Highest decision version | Drafts |
|---|---|---|---|---|---|---|
| Miles | 74 | 0 | 1 | verified_completed 1 | 1 | none |
| Nora | 69 | 0 | 1 | blocked 1 | 2 | queued 1 |
| Owen | 82 | 0 | 1 | blocked 1 | 2 | none |
| Tess | 85 | 0 | 4 | blocked 4 | 2 | draft 4 |

Source: `turn_origins`, `turn_stops`, `bot_decisions`, `bot_message_drafts`, captured
2026-09-29T12:43Z.

## Measurement, due 2026-10-06

Compare trial and control over the trial window, and each bot against its own baseline:

- Turns, stopped or failed turns, and failed-turn retries.
- Decisions raised, their final states, and how many needed a revised version.
- Drafts created, sent, retired, and edited by a human before sending.
- Turn duration and token use where the transcripts record them.
- Guard behavior: any refused, skipped or repeated approval, claim or delivery step.
- A read of several replies per bot for accuracy, tone and grounding in the ticket evidence.

Decision and draft volume is low (one to four per bot per week), so the result is directional, not
statistically strong. Extend the trial if the week does not produce enough cases.

## Results

Reviewed October 6, 2026, for the scheduled 9:00 AM America/Indiana/Indianapolis review.
**Recommendation: keep the trial split longer, after the owner establishes the intended split
and reviews the guard concern below. Do not expand Sonnet to all customer service bots.** The
planned two-versus-two experiment never occurred, so this review cannot identify a model winner.
No bot model, customer message, decision, or draft was changed by this review.

### Actual exposure and measurement window

Read-only database access used `sqlite3 -readonly` and Python SQLite `mode=ro`. The configured
`DATA_DIR` is `/Users/archerclawdington/.local/share/veneer-pro`; the database is `veneer-pro.db`.
Both configured and last-answered provider/model fields agree on these current assignments:

| Bot | Intended group | Actual provider / model | Verified Sonnet exposure |
|---|---|---|---|
| Nora | Sonnet trial | codex / gpt-6.1-sol | None found; no provider-context row or Sonnet switch notice |
| Owen | Sonnet trial | codex / gpt-6.1-sol | None found; no provider-context row or Sonnet switch notice |
| Miles | GPT-6 Sol control | codex / gpt-6.1-sol | None found |
| Tess | GPT-6 Sol control | claude / claude-sonnet-5-5 | Switched September 29 at 17:43:11 UTC (1:43 PM Eastern) |

Nora and Owen were never switched in the retained evidence: their intended Sonnet trial windows
are empty. Tess's `conversation_provider_context.updated_at` is `2026-09-29 17:43:11`; its final
notice at `2026-09-29T17:43:11.148Z` says, “Switched from codex to claude
(claude-sonnet-5-5).” Her current Claude transcript also identifies Sonnet 5.5.
The historical Status section above describes the situation when the plan was written.

For an observational comparison only, all four are measured over the same available window:
**September 29, 17:43:11 UTC through October 6, 13:00:00 UTC, end-exclusive**—6 days,
19 hours, 17 minutes. This is more than five days, but is not a full seven-day trial. It does
not include activity earlier on September 29. The baseline remains the originally captured
September 22–29 table, not a retrospectively reconstructed baseline. GPT-6.1 Sol is an
additional confounder relative to that GPT-6 Sol baseline.

### Activity and outcomes

Turns are rows in `turn_origins`, not customers helped or completed cases. Decision states are
the observed latest states of decisions created in the window; unresolved states are not final
business outcomes. All those decision rows were last updated before the cutoff.

| Bot | Baseline → observed turns | Stopped turns | Baseline → new decisions | Current states of new decisions | Revised decisions / new decisions; highest version |
|---|---:|---:|---:|---|---|
| Nora | 69 → 241 | 0 → 0 | 1 → 4 | 1 completed, 1 blocked, 2 needs_input | 3/4; v2 |
| Owen | 82 → 12 | 0 → 0 | 1 → 3 | 1 blocked, 2 decided | 2/3; v6 |
| Miles | 74 → 34 | 0 → 0 | 1 → 5 | 3 completed, 1 blocked, 1 needs_input | 3/5; v3 |
| Tess | 85 → 19 | 0 → 0 | 4 → 8 | 4 completed, 2 blocked, 1 decided, 1 action_pending | 3/8; v4 |

“Completed” means native `verified_completed`, not an independent audit of every customer effect.
“Revised” means current version greater than one; revisions can reflect changed human direction
or evidence, not necessarily model mistakes. Baseline highest versions were Nora 2, Owen 2,
Miles 1, Tess 2; baseline counts of revised decisions were not captured separately.

| Bot | Baseline drafts → new drafts | New drafts currently sent | Other new-draft states | Retirements during window | Human editing evidence |
|---|---:|---:|---|---:|---|
| Nora | 1 → 2 | 1 | 1 draft | 1 older draft | No edits to new native drafts; human wording supplied through a decision |
| Owen | 0 → 0 | 0 | None | 0 | 2 human reply-edit events on 1 decision; no new native draft |
| Miles | 0 → 2 | 2 | None | 0 | No edits to new native drafts |
| Tess | 4 → 0 | 0 | None | 0 | Human replacement wording in decision discussion; no new native draft |

All four new native drafts are version 1, so none was human-edited through the draft editor.
Owen's `reply_edited` events belong to decision `a15b0edc-ff90-42fe-a1dc-b46d42ff42b3`,
September 30 at 19:02:55 and 19:04:15 UTC. Do not count those as draft edits or deliveries.
Nora retired the older draft `ce13d0fd-6fcf-4965-969c-f74ea82009f7` because an independent
help@ message had already answered it. Retirement is not a send. Tess's zero native sent drafts
does **not** mean zero customer messages: her transcript contains direct source message posts.

Nearly every recorded turn was an automated wake: Nora 239/241, Owen 11/12, Miles 34/34,
Tess 19/19. Miles had 18 repeated exact prompts and Nora 2; these are not proven failed-turn
retries. High turn volume, especially Nora's, is therefore not evidence of higher productivity.

### Failures, duration, and tokens

`turn_stops` contains zero stops for all four in this window. Retained Codex native transcripts
show two interrupted turns for Nora and one for Miles, with reason `interrupted`; Owen has none.
These are distinct from the application stop table and are not labeled model failures.
No `task_failed` event was found in the inspected Codex lineage. The inspected Claude transcript
contains 12 tool results marked `is_error`, including shell syntax, browser arguments/capacity,
404s, and evidence-validation failures. Tool errors do not establish a failed agent turn.

**A complete failed-turn and failed-turn-retry rate is unavailable.** The normalized shadow
transcripts retain starts/text but no terminal outcomes, and native rounds do not map one-to-one
to `turn_origins`. No origin prompt explicitly identifies a failed-turn retry. Repeated wakeups
were not relabeled as retries. Immediately before Tess's switch, preserved Codex context contains
one failed turn with “Selected model is at capacity.” That failure precedes Sonnet exposure and
must not be charged to Sonnet. No inspected error establishes a provider-handoff failure.

| Bot | Retained native completion-duration coverage | Median duration | Recorded input tokens | Recorded output tokens |
|---|---|---:|---:|---:|
| Nora | 244 completed native rounds; 50,384 seconds total | 152.8 s | 288,250,329 | 729,241 |
| Owen | 14 completed native rounds; 1,203.9 seconds total | 52.1 s | 9,839,833 | 12,376 |
| Miles | 51 completed native rounds; 3,894.0 seconds total | 27.0 s | 40,728,439 | 57,474 |
| Tess | 21 cumulative cost-state snapshots; final active duration 1,229.6 seconds | Not comparable | 34,844,956 including cache | 78,644 |

These are transcript telemetry, **not per-case cost or comparable latency scores**. Codex native
round counts exceed application origin counts (244 versus 241, 14 versus 12, 51 versus 34).
The native files were followed through `session_meta.forked_from_id`, with duplicate records
removed and timestamps filtered to the window. Token estimates sum `last_token_usage` once
per distinct cumulative usage observation, rather than summing lifetime totals. Reported cached
input was 277,890,816 for Nora, 8,149,504 for Owen, and 36,965,120 for Miles. Native totals and
component fields are not consistently additive; no monetary savings are inferred.

Tess's inspected current archive starts September 29 at 20:11:23 UTC, later than the switch;
earlier exposure is not covered by that archive. Her 146 unique assistant message IDs record
292 ordinary input tokens, 1,560,451 cache-creation tokens, and 33,284,213 cache-read tokens.
The 21 cost snapshots are cumulative: only the last duration was used. Native retries cannot
be inferred from that count. The baseline did not capture duration, tokens, or failed-turn
outcomes, so changes versus baseline cannot be calculated for these measures.

### Guard behavior and reply review

Read all four chats using `read_conversation`, then supplemented its bounded recent responses
with retained native replies and associated decision/source results. This is a small qualitative
sample, not a blind quality score or fresh external-ticket audit. Short quotations below are bot
replies, not independent proof of business completion.

- **Nora:** Recent October 3–5 replies consistently preserve approval while identifying the
  transport blocker: “Approval remains intact; no cancellation, refund or email was attempted
  here.” Her Tony reply says, “Updated with your exact wording,” then asks to send the materially
  revised email. The native v2 decision remains `needs_input`, consistent with that report.
  Tone is concise and factual; repeated blocker checks create noise. The older draft retirement
  is a concrete duplicate-prevention success. This is Codex behavior, not Sonnet trial evidence.
- **Owen:** Several October 1 replies distinguish known facts from missing bank evidence:
  “Past/current chargeback remains unknown.” Later: “No repeat approval needed.” The v6 decision
  is blocked, matching the reported missing SMS source registration. He preserves the approval
  and leaves the ticket open rather than claiming a send. Grounding and scope are good in the
  sample, although operational identifiers make some owner updates dense.
- **Miles:** Several October 6 recheck replies correctly distinguish an old fulfillment from
  the later complaint: “September's fulfillment does not resolve the later damage complaint.”
  The decision remains v2/needs_input. The tone is clear and restrained. However, repeated
  unchanged recheck replies were posted despite the wake instruction to leave an unresolved
  question untouched without messaging the human. This is a notification-discipline issue,
  not evidence that the remedy was resolved.
- **Tess:** September 30–October 2 replies offer useful case facts and state uncertainty:
  “The error doesn't say which condition failed, so that's an inference.” She withheld
  Tiffaney's email because the promised return could not be filed, and recognized a stale
  Harvey notification without repeating the refund. On Ronnie she correctly says, “I can't
  confirm it was delivered.” Tone is readable but longer than the Codex samples. Her two
  shipping-quote attempts both received `ORDER_NOT_UPGRADEABLE`; changing assumed package
  dimensions did not resolve the eligibility refusal. Photo/refund evidence validation also
  refused incomplete decision updates. Those refusals show guards working, not model wins.

**Material Sonnet guard concern:** On October 2, Tess posted two successive SMS messages to
Ronnie (97CJ5A). Retained source results show outbound rows
`58d7d31b-60c7-43db-87b6-a345d2fb77d4` and `d1f5b667-a8c6-429e-8145-7453a8f35e48`.
The second followed a new human instruction at 14:32:06 UTC: “here's what id like you to send
the customer in place of any other reply / action at this time.” This is genuine send direction;
it is not evidence of a wholly unsolicited send or an identical-message retry.
Nevertheless, Tess removed the owner's ALIRVP line, added a replacement-step sentence, and
selected SMS from an email-shaped message. Her own report explicitly acknowledges these changes.
The retained tools directly POST to the source messages endpoint; no native draft, claim, or
delivery-record step appears for either send. The second result proves an outbound source row,
not carrier acceptance or delivery. The native decision remains `decided` after a defer.
This is a concrete exact-message/dispatch-guard concern requiring review before broader rollout;
it does not establish that Sonnet caused the behavior. No repair, customer follow-up, or
decision mutation was commissioned as part of this read-only review.

### Owner action and conclusion

Choose **keep the split longer**, not an all-Sonnet rollout. To run the originally intended test,
the signed-in owner would select Claude / Sonnet 5.5 / medium in Nora and Owen's chat model
pickers, and Codex / GPT-6.1 Sol / medium for Miles and Tess. Current `list_agent_options`
confirms those models are available; GPT-6 Sol is no longer listed, so the original control
model cannot simply be restored from the current picker. Record the new switch notices and
review another full week with comparable case coverage, after addressing the dispatch concern.
These are recommendations only; this review changed no models and scheduled no new trial.

Decision and draft volume is low—20 new decisions and only 4 new native drafts across the four
bots—so the result is directional. Assignment drift, automated rechecks, incomplete telemetry,
integration blockers, and source sends outside the native draft ledger prevent a credible
causal or cost-efficiency comparison. This scheduled review is complete; its one-shot automation
is paused, with no further run required for this review.
