# Personal live voice preferences — September 23, 2026

Say “Remember that I prefer concise answers. Give me the main point and expand when I ask.” Voice saves supported style preferences for the authenticated human and refreshes current-call instructions. Future calls across bots on this install load the same settings. Ask to review saved preferences or reset them. Explicit temporary requests do not save settings.

Supported preferences: concise/balanced/detailed length, direct/warm/neutral tone, and answer-first/step-by-step/conversational structure. Updates merge; reset clears all saved voice style settings for that user. This changes response style, not the audio voice. Shared logins share preferences. Separate installs, including ERVP, do not automatically receive or synchronize this change.

Persistence uses a user-keyed table and server-side identity from the active call. Tool input cannot select a different user. Only enumerated style values are stored and translated into fixed instructions; arbitrary text cannot become system instructions. Saved preferences do not modify bot instructions, business rules, approvals, or permissions. If storage succeeds but refreshing the current call fails, voice receives an explicit partial-success result.

## Voice and typed chat parity

Ordinary spoken work instructions already enter the same bot message-dispatch path as typed messages, using the authenticated caller. Voice can also read context, answer structured questions, and record explicit business decisions under existing permissions.

Full interface parity is not implemented: credential entry and tool-permission prompts remain on screen; the voice relay sends text without attachments. The coordinator voice has narrower controls than a call pinned to a bot. Personal voice style previously had no dedicated persistent save/read/reset control; this change adds it. It does not claim to implement all remaining parity gaps.

## Verification

Typecheck and the full test suite passed: 2,248 server tests (5 skipped), 860 web tests, 40 browser-manager tests, and the installer suite. Focused coverage verifies persistence across database reopen, human isolation, merge/reset behavior, rejection of foreign identity and arbitrary instructions, live-agent instruction refresh, failure reporting, and service dispatch without creating bot work.

Guide browser checks passed on desktop and restricted-employee mobile: search/copy for the new feature, navigation, announcements, aging, refresh, and failure recovery. Fresh and resumed agent instruction tests passed without changing frozen chat settings. These are automated and isolated checks; no live microphone/provider conversation was conducted.

Production build passed and services restarted. The web/runner health endpoint returned healthy; app-runner, terminal, and browser-manager restart checks also passed.

Employee instructions: [Teach voice your speaking preferences](/#/bot-guide?feature=voice-preferences).

## Changed files

- [server/src/db/migrations/0110_voice_preferences.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0110_voice_preferences.sql)
- [server/src/voice/preferences.ts](/Users/archerclawdington/veneer-os/server/src/voice/preferences.ts)
- [server/src/voice/service.ts](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [server/src/voice/worker.ts](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/test/voicePreferences.test.ts](/Users/archerclawdington/veneer-os/server/test/voicePreferences.test.ts)
- [server/test/liveVoiceService.test.ts](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [server/test/instructionContext.test.ts](/Users/archerclawdington/veneer-os/server/test/instructionContext.test.ts)
- [scripts/bot-guide-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
