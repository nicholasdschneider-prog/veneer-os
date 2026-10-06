# Archer's call voice — October 6, 2026

Archer's exact registered conversation uses Cedar for new live calls, including incoming question phone calls and direct browser calls. Other bots, coordinator calls and the question hotline continue to use Marin. The assignment is persisted in this install's source and survives service restarts. Display-name changes do not change it. No voice picker, customer effects or live test phone call was added. Listen playback and saved briefings retain their separate voice handling.

The server selects an allowlisted voice after resolving the caller's authorized bot context, sends it over private worker IPC, and the worker validates it before constructing the Realtime model. [OpenAI's official Realtime documentation](https://developers.openai.com/api/docs/guides/realtime-conversations) lists Cedar among supported voices. The installed LiveKit Realtime SDK accepts the voice option. A voice is selected at session startup, not midway through a call.

Hear Archer by starting a live voice call in his chat or answering his next question call. Existing personal calling hours and call eligibility still apply. The employee guide and fresh/resumed-agent instructions explain the assignment and its limits.

## Changed files

- [voices.ts](/Users/archerclawdington/veneer-os/server/src/voice/voices.ts)
- [service.ts](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [worker.ts](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [liveVoiceService.test.ts](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/archer-call-voice.md)

## Verification

Typecheck and 62 focused tests passed. Tests cover actual service initialization for browser and incoming phone calls, rename continuity, other identities, coordinator/hotline defaults, unsupported IPC voice rejection, employee guide access and resumed-agent delivery. The full suite passed: 29 installer tests, 3,680 server tests (15 skipped), 1,008 web tests and 51 browser-manager tests. Production build passed with the existing large-chunk advisory.

Deployment completed through the root restart script. The first restart replaced the web service and drained the runner before interrupting this agent turn; the resumed turn verified the runner's replacement pid and health, then restarted the remaining app-runner, terminal and browser-manager services through the same script. Local web/runner health passed; the public front door returned the expected authentication redirect and the tunnel reported four edge connections. These checks do not prove authenticated end-to-end chat delivery. Compiled voice selection returned Cedar for Archer and Marin for other/coordinator calls, rejecting an unknown voice. End-to-end listening on a real phone was not performed.
