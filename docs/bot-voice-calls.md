# Live voice in chats and VeneerBots

Use the phone icon beside the chat composer, or the call button on a bot card. Tap **Start voice** in the floating panel. The conversation stays open; navigating to another thread keeps the call pinned to its original agent and conversation. The panel displays both identities and links back to that thread. An unsaved new chat needs its first message before a call can be attached.

Explicit spoken instructions use the real runner's message-steering path. An active agent can receive work while the voice conversation continues; providers without live steering retain it in the normal queue. Thinking aloud and hypothetical discussion should not dispatch work. The voice model is instructed to clarify ambiguity and dispatch only explicit requests.

The runner's delivery disposition distinguishes queued, running, steered, and delivered messages. These are delivery states, not proof of task completion. The voice service watches visible replies, status changes, structured questions, and bot decisions. Each notification includes fresh visible agent messages and current status, so the voice can report from new evidence rather than reuse an earlier tool response. Notifications wait while the user is speaking, including when they arrive during another response. It relays actual results and questions during the call. Explicit spoken business decisions use the native versioned decision path without a duplicate approval click. Separate tool-permission prompts retain their existing approval UI; voice does not grant tool permissions or handle secrets.

## Thread context at call startup

A pinned call now loads the authorized thread's actual messages before creating the room or starting the voice worker. An unavailable thread fails with a context-loading error rather than opening a contextless call. Requested recaps use that supplied context; empty question or decision lists do not imply an empty conversation or no completed work. Current thread evidence takes precedence over potentially mistaken earlier voice replies.

Context includes up to 24 recent visible user/assistant messages, with a 36,000-character page budget. Long messages retain their beginning and ending within a 4,000-character limit. Coverage reports omitted older messages and clipped messages. The voice can retrieve older pages using `read_chat.beforeMessage` and the returned `coverage.olderBefore` cursor. Hidden reasoning and tool output remain excluded, and permissions are checked again after the runner snapshot returns.

The reported call was pinned to the correct thread. Its saved voice transcript incorrectly described a clean slate, while the runner retained the conversation and deployment summary. The corrected context reader was checked against that real thread and includes the deployed voice feature summary.

## Large bot decision queues

Calls load a catalog of ten short decision previews plus the selected decision's first proposal page. Further catalog pages are available through `list_decisions.offset`. The selected decision is read directly with the caller's permissions, including decisions older than the UI's first forty items. Startup and live update notices use the same bounded decision representation.

Proposal question, recommendation, consequence, and blocked action are retrieved in 1,500-character pages through `read_decision.offset`; coverage provides the next offset. The voice instructions require reading remaining proposal constraints before advising approval. Evidence is limited to eight labels and discussion to four recent excerpts of up to 1,000 characters; coverage makes those limits explicit and directs users to the decision thread for complete discussion. The full decision and audit records remain persisted. Existing assignee, version, explicit-answer, and task-approval checks remain in force.

Saved voice context contains six recent entries of up to 600 characters each; older entries remain saved. Current thread context still uses the existing 24-message/36,000-character reader. On the reported Grant call, a read-only measurement found approximately 123,000 startup characters, including 107,000 decision characters. After the change, a fresh Grant snapshot measured approximately 22,000 characters (the live decision queue had also grown).

Worker failures expose only fixed error categories, including recognized context limits, authentication, quota, rate limits, and a generic connection fallback. Raw provider messages, request bodies, and secrets are never returned or logged. Fatal errors outside the SDK session event also terminate the isolated worker with sanitized reporting. Unknown failures no longer tell users to replace credentials that may already work.

## Access and persistence

Directly signed-in staff can call conversations they can access. Private conversations, business membership, and viewer restrictions use the same checks as ordinary chat. Structured question answers use the existing conversation-management permission; bot decisions still require the assigned approver and current proposal version. Agent bearer tokens cannot open human voice calls. The older unscoped Henry coordinator remains limited to owner/consultant sessions and their accessible owned chats.

Voice transcripts are isolated by **caller and conversation**, including shared team threads. Reconnecting loads bounded saved history. A spoken instruction sent into the actual thread is visible there under the caller's identity. Persistent instruction receipts suppress retries with the same instruction ID. An uncertain delivery is not automatically retried: check the source chat before resending. No raw audio recordings are saved.

The database and legacy API field `bot_conversation_id` / `botConversationId` now also accept ordinary conversation IDs. Existing bot call links and saved history remain compatible.

## Controls and iPhone behavior

- **Start voice** begins audio activation and microphone permission inside the tap handler.
- **Mute** keeps the call connected while disabling microphone transmission.
- **Standby** disconnects the room and microphone. Resume creates a new connection using saved history.
- **End** stops audio; the close button also dismisses the panel.
- **Enable audio** appears when browser playback needs another user gesture.
- A previous call from another tab can be ended before reconnecting. Calls expire after 55 minutes; missing heartbeats release abandoned sessions.

Dictation is preserved. Live voice and dictation cannot capture the microphone together. Close the voice panel to return to composer dictation.

Connect AirPods before starting and select the output in iPhone Control Center. Keep Veneer in the foreground. Screen lock, switching apps, phone calls, or Bluetooth changes can interrupt browser audio. A wake lock is requested when supported; this is not an uninterrupted background PWA calling service.

## Configuration

The runtime vault needs these names; never paste their values into chat or source files:

| Name | Purpose |
| --- | --- |
| `LIVEKIT_URL` | `wss://…livekit.cloud` project URL |
| `LIVEKIT_API_KEY` | LiveKit project API key |
| `LIVEKIT_API_SECRET` | Matching LiveKit secret |
| `OPENAI_API_KEY` | OpenAI API access |

All four names were present during this build. The implementation uses the existing LiveKit Agents OpenAI Realtime integration (`gpt-realtime`, Marin, server voice activity detection). See the [OpenAI Realtime documentation](https://developers.openai.com/api/docs/guides/realtime) and [LiveKit OpenAI integration](https://docs.livekit.io/agents/models/realtime/plugins/openai/). API usage is separately metered; this change purchases no account or plan. Configuration errors point to Settings → Credentials and explain missing names or an invalid project URL.

## Verification

Repository typecheck and production build passed. The full suite passed: 2,453 server tests (5 skipped), 880 web tests, 21 installer tests, and 40 browser-manager tests.

Automated coverage includes real runner question resolution, ordinary-thread dispatch receipts, uncertain-delivery deduplication, staff/private/business access, transcript isolation, access revocation, source-thread pinning in worker dispatch, active-call preservation during work, actual reply notifications, and room cleanup. The browser panel was inspected at 390 × 844 and 1440 × 1000, including navigation pinning and an actionable missing-microphone error.

The opt-in smoke check sends synthesized PCM speech through real LiveKit/OpenAI services and receives remote audio. It routes the spoken instruction through the real conversation manager into a deterministic provider fixture, then checks that an unpredictable reference number from the fixture result is relayed during the same call. This live service check passed on September 21, 2026. It uses an in-memory database and does not act on customer tickets:

```sh
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live --recap
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live --decisions
```

The `--recap` check seeds completed work with an unpredictable delivery reference before the call begins, with no pending questions or decisions. It asks for a recap through real spoken audio and requires the reference in the assistant’s response after that question, with zero new task dispatches.

The `--decisions` check creates 45 long synthetic proposals and selects the oldest one. Real speech asks for its unpredictable reference number; the reply must contain it with zero task dispatches. This passed, as did ordinary startup recap and background dispatch/result audio checks. Reintroducing the old oversized catalog in the isolated fixture reproduced failure before user speech transcription. The provider failure fell back to a generic category, so the test does not establish a specific provider context-limit error code. No real customer decisions or tickets were changed.

Physical iPhone/AirPods testing remains required: two-way audio quality, barge-in, mute, standby/resume, Bluetooth route changes, lock-screen recovery, and a staff member's real agent workflow. A successful automated fixture does not establish those device or customer-service outcomes.

## Changed implementation files

- [Workspace, permissions, and delivery receipts](/Users/archerclawdington/veneer-os/server/src/voice/workspace.ts)
- [Call service and status notifications](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [Realtime worker](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [Human voice routes](/Users/archerclawdington/veneer-os/server/src/routes/liveVoice.ts)
- [Dispatch receipt migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0095_voice_dispatches.sql)
- [Workspace and access tests](/Users/archerclawdington/veneer-os/server/test/liveVoice.test.ts)
- [Call service tests](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [Pinned voice provider](/Users/archerclawdington/veneer-os/web/src/components/VoiceProvider.tsx)
- [Floating panel and audio lifecycle](/Users/archerclawdington/veneer-os/web/src/screens/LiveVoice.tsx)
- [Composer entry point](/Users/archerclawdington/veneer-os/web/src/screens/Chat.tsx)
- [Bot entry points](/Users/archerclawdington/veneer-os/web/src/screens/Bots.tsx)
- [Staff call availability](/Users/archerclawdington/veneer-os/web/src/App.tsx)
- [Provider mounting above navigation](/Users/archerclawdington/veneer-os/web/src/main.tsx)
- [Microphone conflict prevention](/Users/archerclawdington/veneer-os/web/src/lib/stt.ts)
- [Opt-in live media smoke check](/Users/archerclawdington/veneer-os/scripts/smoke-live-voice.mjs)

- [Sanitized worker failure categories](/Users/archerclawdington/veneer-os/server/src/voice/failure.ts)
- [Failure redaction tests](/Users/archerclawdington/veneer-os/server/test/voiceFailure.test.ts)


## Incidental noise and interruptions

The voice worker now requests OpenAI near-field input noise reduction for phone/headset microphones. Server VAD uses a 0.7 activation threshold, 300 ms of preceding audio, and 650 ms of silence to end a user turn. Automatic responses and spoken interruptions remain enabled. The existing browser microphone requests echo cancellation, noise suppression, and automatic gain control.

This replaces semantic VAD because its eagerness controls when a user finishes a turn, not how much ambient noise triggers an interruption. In this LiveKit pipeline the Realtime provider owns interruption onset; local AgentSession minimum-duration/word settings do not gate it. See the [official OpenAI VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad).

The higher threshold and provider noise filter aim to reduce incidental interruptions. Quiet speech or a microphone far from the speaker may be harder to detect; sufficiently loud coughs or nearby voices can still interrupt. Silence-based endpointing can also respond during a thinking pause longer than 650 ms. This is a calibrated default, not a guarantee that every cough is distinguishable from speech.

Run the opt-in, metered regression through actual LiveKit/OpenAI media:

```sh
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live --interruptions
```

It asks the voice to count, sends synthetic ambient hiss plus two short louder bursts while the voice is speaking, checks continued speaking state and audible output, then sends deliberate interrupting speech. It requires playback to yield within 2.5 seconds, an accurate reply with an unpredictable prior-work reference, and no task dispatch. These generated bursts are not human cough recordings. The measured interruption time starts when PCM is submitted (excluding speech synthesis), so it includes media/network delay and any leading silence in the fixture. The check passed with a measured 569 ms deliberate interruption; ordinary startup recap and live background dispatch/result checks are also retained. Physical iPhone/AirPods noise and microphone-route testing remains unverified by the agent.

- [Voice interruption and noise defaults](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [Live media regression entry point](/Users/archerclawdington/veneer-os/scripts/smoke-live-voice.mjs)
- [Synthetic noise and spoken interruption fixture](/Users/archerclawdington/veneer-os/scripts/voice-interruption-fixture.mjs)


## Saved greeting and reply style

Voice preferences are stored per signed-in person and loaded on every call, across bots, normal threads, and coordinator calls. Reply length, tone, structure, and greeting are separate settings. The closed greeting vocabulary is `brief` or `recap`; arbitrary prompt text cannot be saved as instructions.

With `greeting=brief`, a new or resumed call says only **“Hello, what can I help you with?”** and waits. It does not introduce the bot, recap work, list blockers, or lead with a selected decision. Thread and decision context remain loaded for subsequent questions. Relevant new work notifications during an active call still operate normally. People without an explicit greeting preference retain their previous recap opening; reset returns to that default.

The reported caller already had a persisted concise preference, but greeting was not supported and the worker's opening explicitly required recent-work orientation. The saved voice transcript promised a hello-and-wait opening without any greeting field to persist. Startup now uses the same greeting policy as the agent's lasting style instructions, removing that conflict. Spoken requests to remember a greeting use the existing preference tool, which confirms persistence only after successful storage. Current-call refresh errors are reported separately from successful saving.

Regression checks cover storage reopen, caller isolation, merging/reset, new thread and coordinator startup, current-call instruction refresh, and retained completed-work context. A single metered synthetic live check passed: exact brief greeting followed by an accurate spoken recap with an unpredictable existing-work reference, with no work dispatch:

```sh
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live --recap --brief-greeting
```

No physical iPhone/AirPods check was performed for this prompt change.

Changed implementation and regression files:
- [Persistent preferences and shared greeting policy](/Users/archerclawdington/veneer-os/server/src/voice/preferences.ts)
- [Startup context and tool routing](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [Worker greeting and live preference refresh](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [Persistence and style tests](/Users/archerclawdington/veneer-os/server/test/voicePreferences.test.ts)
- [Cross-session and thread tests](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [Live greeting and context verification](/Users/archerclawdington/veneer-os/scripts/smoke-live-voice.mjs)


## Talk through a customer reply — September 25, 2026

Open the raised hand’s blue waveform and select **Start voice**. The compact call
keeps the selected ticket’s action and customer request visible. Ask for the exact
reply, request wording changes, and explicitly approve the revised reply aloud.
**Hang up** ends the audio; accepted work stays with the existing case-owning bot.
There is no separate training choice. Grant’s commissioned review of authorized
CS activity maintains shared guidance separately from case execution.

The voice reader now pages all structured proposal details as well as its prose:
exact message payload, recipients, conditions, review summary and image metadata.
Metadata does not mean the voice has viewed an image. Existing conversation and
proposal-context access checks apply on every read.

The native `edit_reply` tool uses the same human reply editor as the on-screen
control. It atomically claims an available shared card when needed, preserves
account/recipient/action bindings, saves a new unapproved version, and retains
idempotent edit receipts. The caller reviews that version and gives explicit
spoken approval through `answer_decision`. Changed remedies, amounts, recipients
or other action scope still require a revised proposal from the owning bot.
Editing or ending a call does not approve anything.

Accepted general voice instructions are recorded in the caller’s saved transcript.
Their dispatch receipt no longer depends on a subsequent status lookup succeeding.
Approval wakes and accepted instruction dispatches survive normal hangup. An
uncertain dispatch is still reconciled without automatically sending it again.
Recorded approval is not proof of customer delivery; the existing source checks,
exact approved payload and verified completion requirements remain in force.

The isolated live-audio regression is:

```sh
NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live --reply-edit --brief-greeting
```

It uses synthetic speech, an in-memory case and no customer connection. It checks
an exact spoken wording edit, a separate spoken approval of the new version, and
one durable owning-bot wake remaining after hangup. Physical phone/headset and
real-customer delivery are separate from this fixture.


The September 25 synthetic live call passed: exact reply edit, separate spoken
approval of version 2, and exactly one durable case-owner wake after hangup.
The first run exposed a provider-rejected wire constraint in the new tool schema;
the compatible wire definition now leaves positive-version validation in the
server. Fixed error categories identify rejected tool definitions and network
failures without exposing provider messages or credentials. Service tests also
cover stale versions, duplicate edits, access revocation, unanswered discussion
at hangup, and dispatch completion after hangup. Phone/headset behavior remains
unverified on a physical device.
