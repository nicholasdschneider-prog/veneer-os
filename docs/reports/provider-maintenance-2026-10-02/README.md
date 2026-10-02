# Provider maintenance — October 2, 2026

Owner-authorized recurring maintenance in active build slot #532, standalone Veneer OS.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.284 | 2.1.287 |
| Codex CLI | 0.159.0 | 0.160.0 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Configured `VP_SERVICE_HOME` was verified as `/Users/archerclawdington/veneer-pro-home`. Both affected providers were provisioned separately with the supported `installer/provider-runtimes.mjs --service-home /Users/archerclawdington/veneer-pro-home --provider <provider>`. Node 24 was used, avoiding the previously documented shell-default Node 22 issue. All installed versions match the exact repository pins.

## Evidence and compatibility

- [Anthropic official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) and [package metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) confirm production release 2.1.287. Reviewed 2.1.285–287 changes covering stream-json completion, resumed histories, MCP compatibility, permissions, fallback behavior, and secret redaction.
- [OpenAI official changelog](https://learn.chatgpt.com/docs/changelog) and [package metadata](https://registry.npmjs.org/@openai/codex/latest) confirm production release 0.160.0. Reviewed app-server provider settings, catalog authority, reconnect behavior and SQLite startup fixes. Prereleases were excluded.
- [Anthropic platform notes](https://platform.claude.com/docs/en/release-notes/overview) announce no newer model than already-supported Sonnet 5.5. Sonnet 4.5 API retirement is scheduled for November 30, 2026; it is not a current picker entry. Existing explicit settings were not rewritten.
- Fresh authenticated Anthropic `/v1/models` returned HTTP 200 with 13 IDs and `has_more: false`; no new eligible models. Sonnet 5.5, Opus 5.5 and Fable 5.1 remain available.
- Updated service-home Codex app-server `account/read` confirmed ChatGPT authentication. `model/list` returned eight models, supported efforts and no next cursor: GPT-6.1 Sol, GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna and GPT-5.5. GPT-6.1 Sol was already integrated independently after the prior maintenance run. The existing owner-directed GPT-6 Sol picker exclusion remains intact. No models were added by this run.
- Existing adapters passed compatibility checks without changes. Only exact runtime pins and their existing test expectations changed. No integration dependency upgrades, capability additions, feature-guide changes, credential changes or chat/bot setting changes were needed. Grok and unrelated work were preserved.
- Live no-tool Sonnet 5.5 stream-json request returned `OK`, successful result, and `message_stop`. Live GPT-6.1 Sol ephemeral read-only app-server turn returned `OK` with completed status.

## Validation and deployment

- Root `npm run typecheck` passed.
- Focused runtime provisioner, Claude approval adapter, Codex app-server and model tests: 89 passed.
- Full `npm test` passed: 3,294 server tests (15 skipped), 968 web tests, 51 browser-manager tests and 29 installer tests.
- Root `npm run build` passed with the existing nonfatal large-chunk warning.
- Restart and post-restart verification are pending at this checkpoint; the validated change is ready for deployment.

## Rollback

Credential-free [offline runtime copies](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-10-02) retain Claude 2.1.284, the complete previous `@openai` package tree including Codex native dependencies, and the prior runtime policy. Under an active build slot, revert only this maintenance commit, provision the prior exact pins through the supported installer with explicit service home/provider, then pass checks and build before restart. Offline copies are available if vendor downloads fail; do not replace credentials or unrelated settings.

## Recurrence and files

Automation `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` remains enabled, verified with cron `0 8 * * 2,5`, America/Indiana/Indianapolis. Next run October 6 at 08:00 local.

- [Runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json)
- [Existing runtime tests](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-10-02/README.md)
