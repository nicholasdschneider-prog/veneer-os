# Provider maintenance — October 9, 2026

Owner-authorized recurring maintenance, active build #668, standalone Veneer OS.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.291 | 2.1.295 |
| Codex CLI | 0.160.1 | 0.162.0 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Verified configured service home `/Users/archerclawdington/veneer-pro-home` and absolute provider binaries. Provisioned Claude and Codex separately using `installer/provider-runtimes.mjs --service-home ... --provider claude|codex`. Used Node 24.21.0; the shell-default Node 22 still has the previously documented missing libsimdjson dependency and was not changed.

## Evidence and compatibility

- Official [Claude 2.1.295 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.295), published October 8 at 19:48:38 UTC, agrees with [official package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest). Reviewed intermediate 2.1.292–294 notes and 2.1.295, including Haiku support, permission/hook enforcement, headless MCP reconnection and output fixes.
- Official [Codex 0.162.0 release](https://github.com/openai/codex/releases/tag/rust-v0.162.0), published October 8 at 18:55:59 UTC, agrees with [official package metadata](https://registry.npmjs.org/@openai/codex/latest). Reviewed 0.161.0 and 0.162.0, including preserved explicit model overrides, permission handling, app-server changes and retry guidance. Consulted [OpenAI documentation](https://learn.chatgpt.com/docs/changelog); GitHub release metadata supplied the exact CLI version evidence.
- [Anthropic release notes](https://platform.claude.com/docs/en/release-notes/overview) announce generally available Claude Haiku 5.5 on October 7. Fresh authenticated Models API returned HTTP 200, 14 models, no further pages, including `claude-haiku-5-5`.
- Live updated Claude Code Haiku 5.5 check used low effort, no tools, no MCP servers and no persisted session. It returned `OK`, `message_stop`, successful result and exit 0. Added Haiku 5.5 to the existing account-backed model allowlist; retained Haiku 4.5 and all existing selections. Adaptive thinking remains delegated to the native CLI; no manual thinking-budget API integration is used here.
- Fresh updated Codex app-server reported ChatGPT authentication. Its complete seven-model catalog remains GPT-6.1 Sol, GPT-6 Astra/Sol/Luna and GPT-5.6 Sol/Terra/Luna. No newly available Codex model. The owner's existing GPT-6 Sol picker exclusion remains. An ephemeral read-only GPT-6.1 Sol turn returned `OK` and completed status.
- No dependency upgrades, protocol changes, credential changes, automatic model migrations or unrelated provider changes were needed. The guide announces Haiku availability and preserves account-access and selection limits.

## Validation and deployment

Root typecheck passed. Focused runtime, Claude approval/model, Codex model/app-server and guide checks passed (127 tests). The first guide run failed against the old September announcement date; its expectation was updated for the October release, and the independent guide rerun passed all 38 tests. Full `npm test` passed: 3,827 server tests (15 skipped), 1,013 web tests, 51 browser-manager tests and 30 installer tests. Root `npm run build` passed with only the existing nonfatal large-chunk warning. Supported restart preflight passed with Node 24 and native modules loading. Deployment verification is pending the supported restart. Pre-restart PIDs: web 29938, runner 55473, app-runner 56372, terminal 56391.

Guide contract tests verify employee route access and delivery into normal and elevated current/resumed bot instructions. Existing guide layout is unchanged.

## Rollback

Credential-free copies are retained at [rollback-2026-10-09](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-10-09): Claude 2.1.291, the complete previous `@openai` package tree including native dependencies, and prior runtime pins. Under a build slot, revert only this maintenance commit, provision the prior exact versions through the supported installer with explicit service home/provider, and pass checks/build before restart. The offline copies are available if vendor downloads fail. Never replace credentials or unrelated settings.

## Recurrence and changed files

Task `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` was freshly verified enabled: `0 8 * * 2,5`, America/Indiana/Indianapolis. Next run October 13 at 08:00 local.

- [Runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json)
- [Claude model allowlist](/Users/archerclawdington/veneer-os/server/src/providers/claude/adapter.ts)
- [Employee and agent guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Runtime tests](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts)
- [Claude model and approval tests](/Users/archerclawdington/veneer-os/server/test/approvalAdapter.test.ts)
- [Guide contract tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-10-09/README.md)
