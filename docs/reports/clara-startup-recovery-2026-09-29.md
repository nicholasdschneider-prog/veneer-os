# Codex startup recovery — September 29, 2026

Build #469, implementation commit `f969b4d`.

Clara's existing chat recovered after the shared Codex adapter repair. At
16:01:39 UTC (12:01 PM Eastern), turn `8dca811d-63de-47ff-b894-df5d693eb161`
replied, “Yes, I’m here and ready. What would you like to tackle first?” and
recorded `outcome: completed`. At 16:01:45 UTC, she began her already scheduled
accounting pass. This verifies reply recovery, not completion of that pass.

## Scope and evidence

- Existing conversation: `7f83ff8e-43a3-4c16-b2bd-c304dd946d11`.
- Last earlier successful reply: 13:12:07 UTC. Later human inputs appeared in
  the saved display history without a saved terminal error or completion.
- The runtime reported failed, and then working without reply activity after
  the human's 15:47:45 UTC greeting.
- The installed Codex schema supports `excludeTurns: true` for resume/fork.
  Full native history hydration is deprecated for paginated threads. Veneer
  requested that expensive response despite using only the returned id.
- The repaired adapter requests metadata only. Native history and Veneer's
  display history remain intact. The recovered session is
  `01a0ede6-58df-7a30-b15e-86a623575dcd`, linked to the earlier session through
  the existing instruction-refresh fork mechanism.
- Startup errors, disconnects, and timeout terminal events now persist.
  Timeouts identify the waiting startup stage. Late preparation responses
  cannot adopt a session or start a turn after cancellation.
- The repair is shared by all Codex conversations. It contains no Clara id,
  name, role exception, alternate prompt, model change, or business permission.

Recovery after removing full-history response hydration supports that path as
the stall diagnosis. Earlier exact provider errors were not retained, so this
report does not claim to reconstruct them or attribute an unrelated generic
compaction warning to Clara.

The original pickup-email training message and attachment reference remain in
the chat. Reply recovery does not itself prove that instruction was learned or
the email archived. No accounting action was replayed by this repair.

## Validation and deployment

- Node 24.21.0; root typecheck passed.
- Targeted Codex adapter tests: 58 passed.
- Full suite: 29 installer, 3,083 server, 919 web, and 49 browser-manager tests
  passed; 5 server tests skipped.
- Production build passed. All five managed services restarted through
  `npm run restart` and reported healthy.
- Public front door returned HTTP 302 and the tunnel had four active edge
  connections. This does not prove authenticated browser delivery.
- Actual recovered reply and completed turn verified through the original
  conversation and persisted transcript, independently of the Working label.
- Employee guide access and delivery of the updated guidance to restricted,
  full-access, and resumed agents are covered by the guide regression test.
- Implementation committed and pushed to `origin main`.

## Changed files

- [Shared Codex adapter](/Users/archerclawdington/veneer-os/server/src/providers/codexAppServer/adapter.ts)
- [Adapter regression tests](/Users/archerclawdington/veneer-os/server/test/codexAppServer.test.ts)
- [Provider test fixture](/Users/archerclawdington/veneer-os/server/test/fixtures/fake-app-server.mjs)
- [Employee and agent guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Guide delivery regression](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Protocol notes](/Users/archerclawdington/veneer-os/docs/protocol-notes.md)
- [This verification report](/Users/archerclawdington/veneer-os/docs/reports/clara-startup-recovery-2026-09-29.md)
