# Henry live voice trial

Open [Talk to Henry](https://nicksworld.dev/#/voice), or use **Chats → Talk to Henry** / **Tools → Talk to Henry**.

This is a LiveKit/OpenAI voice coordinator for the signed-in user's Veneer work. It is not a connection to the native ChatGPT voice subscription. No existing Henry agent was configured on this install when the feature was built. Choose a working-context chat to give the coordinator its recent visible messages. It does not automatically inherit another agent's hidden state, instructions, or full memory.

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
2. Tap **Call Henry** and allow microphone access. **Enable Henry's audio** appears if Safari blocks playback.
3. Speak normally and interrupt when needed. Henry can read pending structured questions, look up their source chats, and deliver your explicit answers.
4. **Mute** disables microphone transmission but leaves the call connected. **Standby** disconnects the voice session and microphone; resume starts a new connection with saved reference history.
5. Keep the page open during this trial. Screen lock, app switching, calls from other apps, or Bluetooth changes can interrupt audio. A screen wake lock is requested when available; it is not a background-audio guarantee.

Calls stop after 55 minutes; tap to continue. An absent browser heartbeat ends an abandoned call after approximately 90–105 seconds. A stuck startup is ended after approximately 45–60 seconds. Only one active call per user is allowed. Leaving the voice screen ends that call. An **End previous call** control recovers a connection left by another tab.

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
- [iPhone-oriented call screen](/Users/archerclawdington/veneer-os/web/src/screens/LiveVoice.tsx)
- [Browser API client](/Users/archerclawdington/veneer-os/web/src/lib/liveVoice.ts)
- [Lazy-loaded application route](/Users/archerclawdington/veneer-os/web/src/App.tsx)
- [Chat-list entry point](/Users/archerclawdington/veneer-os/web/src/screens/ChatList.tsx)
- [Tools entry point](/Users/archerclawdington/veneer-os/web/src/screens/Tools.tsx)
- [Workspace and HTTP tests](/Users/archerclawdington/veneer-os/server/test/liveVoice.test.ts)
- [Call lifecycle tests](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [Server dependencies](/Users/archerclawdington/veneer-os/server/package.json), [browser dependencies](/Users/archerclawdington/veneer-os/web/package.json), [lockfile](/Users/archerclawdington/veneer-os/package-lock.json)

The full test run also exposed an existing simultaneous-boot race in [migration initialization](/Users/archerclawdington/veneer-os/server/src/db/migrate.ts), fixed by rechecking under an immediate write transaction, and a millisecond-sensitive [snapshot test](/Users/archerclawdington/veneer-os/server/test/snapshot-merge.test.ts), fixed by pinning its clock.
