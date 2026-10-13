# Provider maintenance — October 13, 2026

Owner-authorized recurring maintenance, active build #765, standalone Veneer OS.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.295 | 2.1.296 |
| Codex CLI | 0.162.0 | 0.162.1 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Confirmed configured VP_SERVICE_HOME and absolute binaries under `/Users/archerclawdington/veneer-pro-home`. Provisioned only Claude and Codex with `installer/provider-runtimes.mjs --service-home ... --provider claude|codex`, using Node 24.21.0. Codex npm fetch timed out twice, then the installer completed successfully. The existing shell-default Node 22 library issue remains outside this maintenance scope.

## Official evidence and live compatibility

- [Claude 2.1.296](https://github.com/anthropics/claude-code/releases/tag/v2.1.296), published October 9 at 19:28:59 UTC, matches [official npm metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/latest). Reviewed fixes for headless sessions, hooks, adaptive-thinking token counts, interrupted resumes and permission enforcement.
- [Codex 0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1), published October 9 at 19:44:51 UTC, matches [official npm metadata](https://registry.npmjs.org/@openai/codex/latest). Fixes background-server feature-setting compatibility and multiline asynchronous question rendering. Also consulted [official OpenAI documentation](https://learn.chatgpt.com/docs/changelog).
- [Anthropic release notes](https://platform.claude.com/docs/en/release-notes/overview) contain no newer generally available model since the prior run. Fresh authenticated Models API returned HTTP 200, 14 models and no additional page, including Haiku 5.5, Sonnet 5.5 and Opus 5.5. Updated Claude returned `OK`, successful result, `end_turn`, exit 0 using Haiku 5.5 at low effort with no tools, MCP servers or persisted session.
- Updated Codex app-server confirmed ChatGPT authentication. Its fresh complete seven-model catalog remains GPT-6.1 Sol, GPT-6 Astra/Sol/Luna and GPT-5.6 Sol/Terra/Luna. An ephemeral read-only GPT-6.1 Sol turn returned `OK` and completed successfully.
- Live Veneer discovery returned the existing eight eligible Claude choices and six Codex choices, retaining the owner's GPT-6 Sol picker exclusion. No newly available models, adapter changes, integration dependency upgrades, capability changes or feature-guide changes were necessary. Existing explicit conversations/bot selections, credentials, Grok and unrelated work were preserved.

## Validation and deployment

Root typecheck passed. Focused runtime, model, approval and app-server tests passed all 93 tests after correcting a stale escaped version expectation in the existing mismatch test. Supported restart preflight passed with Node 24.21.0 and native modules loading. Full root `npm test` passed: 30 installer tests, 3,925 server tests (15 skipped), 1,014 web tests and 52 browser-manager tests. Root `npm run build` passed with only the existing nonfatal large-chunk warning. Deployment receipt pending. Pre-restart PIDs: web 2228, runner 52798, app-runner 73106, terminal 73121.

## Rollback

Credential-free rollback copies: [rollback-2026-10-13](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-10-13), containing Claude 2.1.295, the complete prior @openai package tree including native dependencies, and prior runtime pins. Under an active build slot, revert only this maintenance change, provision those prior exact versions with the supported installer and explicit service home/provider, and pass checks/build before restart. Offline copies remain available if vendor downloads fail. Never replace credentials or unrelated settings.

## Recurrence and changed files

Freshly verified task `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` remains enabled at `0 8 * * 2,5`, America/Indiana/Indianapolis; next run October 16 at 08:00 local.

- [Runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json)
- [Existing runtime assertions](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-10-13/README.md)
