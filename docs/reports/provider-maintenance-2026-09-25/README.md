# Provider maintenance — September 25, 2026

Authorized recurring maintenance in durable build slot #324 for the standalone Veneer OS install.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.280 | 2.1.282 |
| Codex CLI | 0.156.1 | 0.157.0 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Used the supported runtime installer separately for Claude and Codex, with explicit service home `/Users/archerclawdington/veneer-pro-home` and working Node 24.21.0 from `/opt/homebrew/opt/node@24/bin`. The known shell-default Node/simdjson issue did not require a Homebrew change.

## Evidence and scope

- [Claude 2.1.282 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.282) and [2.1.281 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.281): reviewed resumed-history, stream/SDK, permission, OAuth refresh, and MCP fixes. GitHub marks 2.1.282 neither draft nor prerelease; [official package metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest) agrees. Anthropic's slower `stable` dist-tag remains 2.1.274; this run follows the existing production `latest` policy, pinned to an exact version.
- [Codex 0.157.0 release](https://github.com/openai/codex/releases/tag/rust-v0.157.0), [official package metadata](https://registry.npmjs.org/@openai%2Fcodex/latest), and [OpenAI Docs changelog](https://learn.chatgpt.com/docs/changelog) agree on the production release. Excluded 0.158 alpha. Reviewed app-server, proxy, network-policy, upload, and model changes.
- [Anthropic platform notes](https://platform.claude.com/docs/en/release-notes/overview) and [OpenAI API notes](https://developers.openai.com/api/docs/changelog) show no later generally available coding model beyond those handled September 23.
- Fresh authenticated Anthropic `/v1/models` returned HTTP 200, 12 model IDs, and no further page. Opus 5.5, Fable 5.1, Opus 5, Sonnet 5, Opus 4.8, and Haiku 4.5 remain exposed by Veneer's existing allowlist; the other returned IDs are older generations.
- Service-home Codex app-server `account/read` confirmed ChatGPT authentication. `model/list` returned Astra, Sol, Luna, the GPT-5.6 family, and GPT-5.5, with supported effort levels and no next page. No newly available models since September 23.
- Only runtime pins and their existing test fixtures changed. No adapter, integration dependency, model-selection, or Veneer capability change was needed; no new feature-guide announcement was warranted.

## Validation

- Root typecheck passed.
- All 80 focused runtime/protocol/model/approval adapter tests passed. One initial mismatch-message assertion retained the old escaped version; corrected it and reran successfully.
- Live Claude Opus 5.5 no-tool request returned `OK`; Codex Astra completed an ephemeral read-only app-server turn without error.
- Installer `--verify-only` confirmed all three exact runtime pins.
- Full `npm test` passed: 2,478 server tests (5 skipped), 893 web tests, 40 browser-manager tests, and 21 installer tests.
- Root production build passed with the existing nonfatal Vite large-chunk warning.
- `npm run restart` restarted web and runner, interrupting this maintenance chat. On the queue's automatic continuation, confirmed their new PIDs, then completed the remaining services with `npm run restart -- veneer-pro-app-runner veneer-pro-term veneer-browser-manager` (exit 0).
- After restart, all five service health endpoints returned HTTP 200. Installer verification again confirmed Claude 2.1.282, Codex 0.157.0, and unchanged Grok 1.0.5. Live Veneer model discovery retained all existing choices and defaults (Claude Opus 5.5 and GPT-6 Astra).
- Runtime/test changes committed and pushed to `origin main` as `36f2c0e` (`Update Claude and Codex production runtimes`). This report's final deployment evidence is recorded in a follow-up documentation commit. No owner blocker remains.

## Rollback and follow-through

Retained [runtime-only rollback files](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-09-25): Claude 2.1.280 binary, the complete prior `@openai` package directory including native Codex dependency, and prior runtime policy. No credentials were copied. To roll back, obtain a build slot, revert only this change, provision the previous exact pins with the supported installer and explicit provider/service home, then pass the validation/build gates before restarting. These local runtime copies provide an offline fallback.

Automation `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` remains enabled Tuesday and Friday at 08:00 America/Indiana/Indianapolis; next scheduled run September 29. Existing explicit bot/chat model selections and unrelated untracked files were preserved.

Changed files: [runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json), [runtime tests](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts), and [this report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-09-25/README.md).
