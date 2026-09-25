# Simpler customer-service hand raises and voice follow-through

September 25, 2026 · Veneer build 346 / ERVP build 347

One connected case owner raises the ready question directly to Ali and stays
accountable through the exact authorized action and verified delivery. Grant
reviews authorized activity, recorded human direction and outcomes to maintain
shared skills automatically. There is no training button or new approval layer.
Existing approval owners/executors are preserved for already-approved work.

## Voice

Open the raised hand’s blue waveform, select **Start voice**, discuss the issue,
request wording changes, and explicitly approve the revised reply aloud. Wait for
the recorded-approval confirmation, then **Hang up**. Accepted work remains queued
for the owning bot. Unconfirmed discussion and ending a call do not authorize work.

The compact call displays its selected action and customer request. Voice reads
paged structured proposal details, including the exact reply and constraints.
Native reply edits use the existing human editor and create an unapproved version;
spoken approval binds to that version. Recipients and action bindings stay intact.
The saved caller-private transcript includes accepted instruction receipts.
A failed subsequent status lookup no longer makes an accepted dispatch uncertain.

## Grant’s review

Grant completed and validated six shared CS skills and updated only the prompt of
existing sweep `06585743-7428-407a-8484-a2a981d39df5`. Independent readback confirmed
it remains enabled with cron `*/30 8-17 * * 1-5`, America/New_York, Codex gpt-6-sol,
medium. Changed evidence is reviewed using source IDs/versions and coverage
checkpoints. Unchanged reviewed evidence is a no-op. Corrections are queued,
validated and adopted through existing skill maintenance; case-specific exceptions
do not become blanket permission. This is bounded scheduled review, not continuous
observation or proof that every past case has already been reviewed.

[Grant’s completion report and six changed skill links](/Users/archerclawdington/Projects/ERVP/out/grant/cs-owner-routing-build347-20260925.md)

ERVP’s project root has no Git repository; those skills are saved locally. Platform
source is committed and pushed separately in Veneer. No customer action was
performed by this build. Existing source-side sending/setup blockers remain owned
repairs, not evidence that a customer was answered.

## Verification

- Typecheck passed; full suites passed: 29 installer, 2,512 server (5 skipped),
  898 web and 40 browser-manager tests. Production build passed.
- Service regressions: exact structured-reply pagination, versioned edits,
  idempotent retry, access revocation, stale approval rejection, retained approval
  wake after hangup, unapproved discussion staying unapproved, and accepted
  instruction completion after hangup.
- Isolated browser checks at 320, 375, 414, 768 and 1440 pixels: call controls,
  transcript, selected ticket context, truthful approval status and no overflow.
- Full and restricted employee guide discovery, release filtering and navigation;
  current catalog delivery through fresh/resumed agent instruction tests.
- Live LiveKit/OpenAI synthetic speech passed: exact reply edit, separate spoken
  approval of version 2, exactly one durable case-owner wake after hangup, zero
  customer sends. Initial smoke exposed an unsupported wire schema constraint;
  the compatible tool definition retains strict server-side validation.

Physical iPhone/AirPods testing and actual customer delivery are not established
by these fixtures. The new review schedule is configured; this build does not
claim its first production sweep has completed.

## Deployment

Production build completed before restart. Web and runner restarted at 14:57 EDT;
that runner restart interrupted the build turn, which the existing build queue
resumed. Process start times and health were checked before completing only the
remaining app-runner, terminal and browser-manager restarts through the supported
root restart command. All services passed their health checks. The tunnel had four
active edge connections and the public front door responded HTTP 302; authenticated
end-to-end customer delivery was not tested.

## Changed platform files

- [docs/bot-voice-calls.md](/Users/archerclawdington/veneer-os/docs/bot-voice-calls.md)
- [scripts/bot-guide-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
- [scripts/decision-voice-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/decision-voice-browser-check.mjs)
- [scripts/smoke-live-voice.mjs](/Users/archerclawdington/veneer-os/scripts/smoke-live-voice.mjs)
- [scripts/voice-reply-fixture.mjs](/Users/archerclawdington/veneer-os/scripts/voice-reply-fixture.mjs)
- [server/src/bots/service.ts](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/voice/failure.ts](/Users/archerclawdington/veneer-os/server/src/voice/failure.ts)
- [server/src/voice/service.ts](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [server/src/voice/worker.ts](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [server/src/voice/workspace.ts](/Users/archerclawdington/veneer-os/server/src/voice/workspace.ts)
- [server/test/liveVoice.test.ts](/Users/archerclawdington/veneer-os/server/test/liveVoice.test.ts)
- [server/test/liveVoiceService.test.ts](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [server/test/voiceFailure.test.ts](/Users/archerclawdington/veneer-os/server/test/voiceFailure.test.ts)
- [web/src/components/VoiceCallPanel.tsx](/Users/archerclawdington/veneer-os/web/src/components/VoiceCallPanel.tsx)
- [web/src/lib/botGuide.test.ts](/Users/archerclawdington/veneer-os/web/src/lib/botGuide.test.ts)
- [web/src/lib/liveVoice.ts](/Users/archerclawdington/veneer-os/web/src/lib/liveVoice.ts)
- [web/src/screens/LiveVoice.tsx](/Users/archerclawdington/veneer-os/web/src/screens/LiveVoice.tsx)
