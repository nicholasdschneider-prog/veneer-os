# Provider maintenance — October 6, 2026

Owner-authorized recurring maintenance in active build slot #591, standalone Veneer OS.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.287 | 2.1.291 |
| Codex CLI | 0.160.0 | 0.160.1 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Verified configured `VP_SERVICE_HOME`: `/Users/archerclawdington/veneer-pro-home`. Provisioned only Claude and Codex through `installer/provider-runtimes.mjs`, separately with explicit `--service-home` and `--provider`. Used working Node 24.21.0; the shell-default Node 22 has a previously documented missing libsimdjson library. No repair to unrelated Node installations was attempted.

## Release evidence and compatibility

- Official [Claude release](https://github.com/anthropics/claude-code/releases/tag/v2.1.291) and [package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) agree on stable 2.1.291, published October 6 at 03:55:19 UTC. Reviewed the [2.1.288–291 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), including permission enforcement, session/resume persistence, interrupted streaming completion, headless shutdown and duplicate MCP-call fixes. No adapter changes were needed.
- Official [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.160.1), [OpenAI changelog](https://learn.chatgpt.com/docs/changelog), and [package metadata](https://registry.npmjs.org/@openai/codex/latest) agree on stable 0.160.1, published October 5 at 18:29:37 UTC. The patch preserves Windows executor environment variables in remote stdio MCP startup. No new integration dependency was required.
- [Anthropic model release notes](https://platform.claude.com/docs/en/release-notes/overview) and OpenAI's changelog announce no newer eligible model than the already-integrated Sonnet 5.5 and GPT-6.1 Sol.
- Fresh authenticated Anthropic Models API: HTTP 200, 13 models, `has_more: false`. Current eligible Claude choices remain available; no additions.
- Fresh updated Codex app-server `account/read` reports ChatGPT authentication. `model/list` returns seven models and no next cursor: GPT-6.1 Sol, GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna. GPT-5.5, previously returned October 2, is no longer advertised. Preserved the owner's existing GPT-6 Sol picker exclusion and all explicit chat/bot choices. No new models were added.
- Live no-tool Sonnet 5.5 stream-json check returned `OK`, exit 0, successful result and `message_stop`. Live ephemeral read-only GPT-6.1 Sol app-server turn returned `OK` and completed status.
- Changes are limited to exact runtime pins and corresponding existing test expectations. No credentials, provider adapters, catalog rules, dependency manifests, capability guide entries, chat/bot selections or unrelated providers were changed.

## Validation and deployment

- Root typecheck passed.
- Focused provider adapter/model tests passed (83 tests). Six runtime tests passed after correcting the version assertion missed in the initial edit; the initial stale assertion failure was a test expectation, not an installed runtime failure.
- Full `npm test` passed: 3,442 server tests (15 skipped), 1,008 web tests, 51 browser-manager tests, and 29 installer tests.
- Root `npm run build` passed; only the existing nonfatal large-chunk warning remains.
- Deployment pending: run the supported root restart command with app-runner, terminal, browser-manager, web, then runner last. Before restart, PIDs were web 97212, runner 46125, app-runner 47345, terminal 47361. If runner shutdown interrupts this chat, reconcile fresh PIDs/health/model discovery before reporting completion; do not repeat installation or the restart without evidence.

## Rollback

Credential-free [offline runtime copies](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-10-06) retain Claude 2.1.287, the complete previous `@openai` package tree including native dependencies, and the prior runtime policy. For rollback under a build slot, revert only this maintenance change, provision prior exact versions through the supported installer with explicit service home and provider, and pass checks/build before restart. Offline copies are available if vendor downloads fail. Do not replace credentials or unrelated settings.

## Recurrence and files

Automation `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` is still enabled, freshly verified as `0 8 * * 2,5`, America/Indiana/Indianapolis. Next run: October 9 at 08:00 local.

- [Runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json)
- [Existing runtime tests](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-10-06/README.md)
