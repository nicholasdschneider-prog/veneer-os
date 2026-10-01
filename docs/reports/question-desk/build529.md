# Question desk and voice hotline launch — build 529

Launched October 1, 2026 with the owner's explicit approval. Verification completed at 2026-10-01T19:56:25.103Z. Application release commit: `a2cab9b`, pushed to `origin main`; implementation commit: `0be6651`. Intervening browser-capacity work was preserved.

## Checks before restart

- Root `npm run typecheck`: passed.
- Root full `npm test`: **4,342 passed, 15 skipped** (installer 29, server 3,294, web 968, browser manager 51).
- Root `npm run build`: passed. The existing large-bundle warning remains.
- Updated feature-guide tests, including employee access and resumed-agent instructions, passed in the full suite.

## Deployment and live verification

The preceding browser-capacity deployment had already loaded the question-desk code and applied `0145_question_line.sql` at 19:50:06 UTC. This launch pass rebuilt the combined checkout and shipped the updated announcement.

The approved root `npm run restart` restarted web and runner. Restarting the runner interrupted its calling tool process after the runner's drain began. Read-only reconciliation confirmed the replacement runner and healthy web/runner. No second web/runner restart was attempted. The remaining app-runner, terminal and browser-manager services were restarted through `npm run restart -- veneer-pro-app-runner veneer-pro-term veneer-browser-manager`; it exited successfully.

- Web, runner, app-runner, terminal and browser manager healthy. Replacement web/runner PIDs: 84912/85000.
- Four active Cloudflare tunnel edge connections; public front door reachable.
- Production migration record present; its content hash matches the source migration.
- Using the assigned saved browser profile, the authenticated public site displayed the current guide announcement.
- The global waiting count opened the dock and waiting list; the Hotline entry was present. Collapse restored the quiet cue.
- Authenticated `/api/question-line` returned its native decision list.
- Authenticated `/api/live-voice?hotline=1` returned `ok: true`, configuration `ready: true`, no missing settings and no invalid URL.
- No real decisions were answered, no new call was placed against real questions, and no customer effect was performed. Temporary browser copy removed after verification.

## Coverage and limits

The implementation's five-width browser workflow and repeated actual LiveKit/OpenAI synthetic-audio tests remain recorded in [build 527 verification](./build527/README.md). This launch pass used bounded authenticated desktop checks; it did not repeat physical-phone or full-call-duration testing. A configured voice endpoint is not proof of microphone permission on every user's device. Drafts are retained within the current tab, reminders rejoin the line without push notification, and ordinary chat prompts/tool permissions retain their existing interfaces.

## Changed documentation and announcement

- [Launch receipt](/Users/archerclawdington/veneer-os/docs/reports/question-desk/build529.md)
- [Feature-guide documentation](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Launch announcement](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
