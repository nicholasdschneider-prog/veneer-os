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
