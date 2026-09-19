# Voice calls with VeneerBots

Every registered bot can be called from VeneerBots (`#/bots`):

- **Bot roster** — the phone button beside a bot opens a call with it.
- **Decision cards and the decision thread** — "Talk with *bot* about this" opens a call focused on that decision, so you can talk it through and decide out loud.
- **A bot's chat** (opened from VeneerBots) — the phone button in the header calls that bot.

The call route is `#/bots/talk/<conversationId>` with an optional `?decision=<id>`. The original all-agents coordinator, Henry, remains reachable at `#/voice` but no longer has entry points on the Chats or Tools screens.

This is a LiveKit/OpenAI voice session that speaks *for* the bot from its real chat, decisions and pending questions. It is not the bot's own model on the line: the bot keeps working in its chat, and the voice line relays what you say to it, reads its replies aloud when they arrive, and records the decisions you state explicitly. Saved conversation history is kept per bot, separately from Henry's.

## Setup

Create a project at [LiveKit Cloud](https://cloud.livekit.io). In the connected runtime Doppler configuration (currently `main/prd`), supply these names through secure secret cards or Settings → Credentials → Vault:

| Name | Source |
| --- | --- |
| `LIVEKIT_URL` | Project URL, `wss://…livekit.cloud` |
| `LIVEKIT_API_KEY` | Project Settings → Keys |
| `LIVEKIT_API_SECRET` | Matching LiveKit API secret |
| `OPENAI_API_KEY` | [OpenAI API keys](https://platform.openai.com/api-keys) |

Do not paste keys in chat or commit them. Runtime Doppler refreshes periodically; **Check setup again** refreshes the displayed availability. Calls use OpenAI `gpt-realtime`, the Marin voice, and input transcription. Both providers may bill usage separately from subscriptions. No paid account or plan is purchased by the implementation.

The first trial accepts LiveKit Cloud project URLs only. A self-hosted media server needs separate networking/TLS work; the existing Cloudflare web tunnel is not a substitute for WebRTC media transport.

## iPhone and AirPods

1. Connect AirPods before opening the call. Select the desired route in iPhone Control Center.
2. Tap **Call *bot*** and allow microphone access. **Enable *bot*'s audio** appears if Safari blocks playback.
3. Speak normally and interrupt when needed. On a bot call the voice line reads the bot's chat and open decisions first, then tells you what it is working on or waiting on.
4. **Mute** disables microphone transmission but leaves the call connected. **Standby** disconnects the voice session and microphone; resume starts a new connection with saved reference history.
5. Keep the page open during this trial. Screen lock, app switching, calls from other apps, or Bluetooth changes can interrupt audio. A screen wake lock is requested when available; it is not a background-audio guarantee.

Calls stop after 55 minutes; tap to continue. An absent browser heartbeat ends an abandoned call after approximately 90–105 seconds. A stuck startup is ended after approximately 45–60 seconds. Only one active call per user is allowed. Leaving the voice screen ends that call. An **End previous call** control recovers a connection left by another tab.

## What a bot call can do

- Read the bot's recent visible chat messages and status (`read_chat`), and relay what you say into that chat (`send_message`, prefixed `[Voice call]`) the same way the composer would. When the bot replies during the call, the voice line is told and reads the reply aloud.
- List and read the bot's decisions (`list_decisions`, `read_decision`), post into a decision's discussion thread (`discuss_decision`, which wakes the bot but approves nothing), and record an explicit approve / reject / defer / withdraw with your reasoning (`answer_decision`). The decision's version is checked, only the assigned approver can answer, and the answer goes through the same VeneerBots service and wake-up the web form uses.
- Answer the bot's structured pending questions (`list_blockers`, `answer_question`).
- Newly raised decisions and new questions are mentioned briefly while you are both listening.

A bot call is scoped to that one bot: other chats, other bots and the Henry chat list are not available on it.

## What Henry can do

- Review up to 100 pending ordinary structured question requests across the user's own chats, including multiple prompts per request.
- Read recent visible conversation messages and current agent status. Tool output, reasoning, and secret cards are excluded.
- Save and deliver explicit answers through the existing runner's option validation and durable question resolution. Delivery is not proof that the agent completed the ticket.
- Briefly mention newly arriving questions while listening during an active call.
- Resume from saved final transcripts and decision receipts. History supplied to the model is bounded; it is not unlimited conversational memory.

Voice cannot grant tool approvals, enter/reveal credentials, independently send customer messages, start arbitrary agent work, or discover blockers that agents never recorded as questions. A source-chat link is provided for those workflows. The trial is restricted to directly signed-in owners and consultants, scoped to their own chats; agent tokens and member accounts cannot start calls.

No raw audio recordings are saved by this implementation. Final text transcripts and decision receipts are stored in SQLite. Recognizable credential patterns are redacted from transcript capture. Interrupted/incomplete utterances may not be saved. Do not speak passwords or API keys to Henry.

## Verification and remaining checks

Verified locally: real runner question validation/resolution, cross-user isolation, exclusion of secret requests, idempotent repeat decisions, persisted history, startup failure cleanup, heartbeat cleanup, missing/invalid configuration, worker/native SDK initialization on Node 24 arm64, mobile/desktop layout, and browser microphone-denial recovery. Full repository typecheck, tests, and production build are required before restart.

A real LiveKit/OpenAI media session and physical iPhone/AirPods behavior still require the LiveKit credentials and device acceptance test. Check two-way audio, interruption, mute, standby/resume, Bluetooth route changes, screen lock/recovery, a real pending question, and the source agent receiving its answer. Never describe those checks as passed merely because the UI renders or automated tests pass.

## Implementation files

- [Voice workspace and decision routing](/Users/archerclawdington/veneer-os/server/src/voice/workspace.ts)
- [Call lifecycle and room tokens](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [Isolated LiveKit voice worker](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [Authenticated voice routes](/Users/archerclawdington/veneer-os/server/src/routes/liveVoice.ts)
- [Voice migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0090_live_voice.sql)
- [Application context](/Users/archerclawdington/veneer-os/server/src/context.ts)
- [API mounting](/Users/archerclawdington/veneer-os/server/src/routes/api.ts)
- [Startup and shutdown](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [Call screen, bot and coordinator modes](/Users/archerclawdington/veneer-os/web/src/screens/LiveVoice.tsx)
- [VeneerBots entry points](/Users/archerclawdington/veneer-os/web/src/screens/Bots.tsx)
- [Bot chat header entry point](/Users/archerclawdington/veneer-os/web/src/screens/Chat.tsx)
- [Bot-scoped history migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0093_voice_bot_calls.sql)
- [Browser API client](/Users/archerclawdington/veneer-os/web/src/lib/liveVoice.ts)
- [Lazy-loaded application route](/Users/archerclawdington/veneer-os/web/src/App.tsx)
- [Workspace and HTTP tests](/Users/archerclawdington/veneer-os/server/test/liveVoice.test.ts)
- [Call lifecycle tests](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [Server dependencies](/Users/archerclawdington/veneer-os/server/package.json), [browser dependencies](/Users/archerclawdington/veneer-os/web/package.json), [lockfile](/Users/archerclawdington/veneer-os/package-lock.json)

The full test run also exposed an existing simultaneous-boot race in [migration initialization](/Users/archerclawdington/veneer-os/server/src/db/migrate.ts), fixed by rechecking under an immediate write transaction, and a millisecond-sensitive [snapshot test](/Users/archerclawdington/veneer-os/server/test/snapshot-merge.test.ts), fixed by pinning its clock.
