# Provider maintenance — September 23, 2026

Completed in durable build slot #231 for the standalone Veneer OS checkout. Automation `7a7ea69b-12f1-46ee-9912-7c5cd79710ae` remains enabled Tuesday/Friday at 08:00 America/Indiana/Indianapolis; next run September 25.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.259 | 2.1.280 |
| Codex CLI | 0.153.4 | 0.156.1 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

Only Claude and Codex were provisioned, through `installer/provider-runtimes.mjs` with explicit provider and service-home arguments. Service home is `/Users/archerclawdington/veneer-pro-home`. The shell's default Node 22 has a missing simdjson library; all maintenance used the working required Node 24.21.0 at `/opt/homebrew/opt/node@24/bin`. No Homebrew or unrelated dependency upgrade was needed.

## Release and availability evidence

- [Anthropic official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [Claude package metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest), and [Claude model documentation](https://platform.claude.com/docs/en/models/overview): stable 2.1.280 and Opus 5.5. Reviewed intervening headless/SDK, prompt-cache and MCP changes; no additional adapter protocol change was required by the checks below.
- [Codex 0.156.1 release](https://github.com/openai/codex/releases/tag/rust-v0.156.1), [official package metadata](https://registry.npmjs.org/@openai%2Fcodex/latest), and [OpenAI changelog](https://learn.chatgpt.com/docs/changelog): stable release published September 23. Also reviewed 0.154.0, 0.155.0 and 0.156.0 release notes. Veneer uses app-server, not the removed legacy mcp-server entry point.
- Authenticated Anthropic `/v1/models` returned HTTP 200 with `claude-opus-5-5`, no additional page. Added it to the existing discovery allowlist while retaining previous entries.
- Service-home Codex app-server `account/read` confirmed a connected ChatGPT account. `model/list` returned visible `gpt-6-sol` and `gpt-6-luna`, their supported effort levels, and the older models. Existing dynamic discovery handles them without a Codex adapter change.
- After restart, live Veneer `list_agent_options` exposed all three new models. Defaults remained Claude Fable 5.1 and GPT-6 Astra. No conversation or bot selections were migrated, and no credential files were copied into the report or rollback directory.

Previous queue work #230 only documented isolated cache comparisons and made no live runtime change. Its results are in [the cache report](../claude-cache-2026-09-23/README.md).

## Validation and deployment

- Root typecheck passed.
- Scoped runtime, approval adapter, Codex protocol/model, guide and instruction checks passed. Initial runtime fixture assertions still expected old pins; updated those fixtures, then reran successfully.
- Full `npm test` passed: 2,244 server tests (5 skipped), 860 web tests, 40 browser-manager tests, 21 installer tests.
- Root production build passed, with Vite's nonfatal existing large-chunk warning.
- Live minimal no-tool smoke turns succeeded: Claude Opus 5.5 returned `OK`; GPT-6 Sol and GPT-6 Luna completed ephemeral read-only app-server turns.
- Guide browser checks passed for full/restricted employees, desktop/mobile, announcements, search, clipboard, permalinks, overflow, aging, refresh and failure recovery. Expanded coverage for the new model entry and narrowed an older broad search that matched multiple entries. Current bot instructions contain the new guide entry for all roles; the resumed-chat snapshot regression passed.
- `npm run restart` restarted web, runner, app-runner and terminal, interrupting the maintenance chat. On automatic continuation, verified new service PIDs and completed the remaining browser-manager restart with `npm run restart -- veneer-browser-manager` (exit 0).
- All five health endpoints returned HTTP 200. Installer `--verify-only` confirmed all three exact runtime pins. Live model discovery passed after restart. No owner blocker remains.

Employee instructions: [new model guide](/#/bot-guide?feature=provider-model-updates).

## Rollback

Runtime-only backups were retained in [rollback-2026-09-23](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-09-23): Claude 2.1.259 binary, complete Codex 0.153.4 package including its Darwin arm64 dependency, and prior policy JSON. No authentication or account configuration is included.

If rollback is needed, acquire a build slot; revert this maintenance commit without reverting unrelated changes; provision the restored exact pins with the supported installer, selecting Claude and Codex separately and the same explicit service home. The retained binaries/package provide an offline fallback if vendor downloads fail. Revalidate typecheck, tests and build before restarting; verify versions and health afterward. Do not overwrite provider credentials or model selections.

## Changed files

- [Runtime pins](/Users/archerclawdington/veneer-os/provider-runtimes.json)
- [Claude discovery allowlist](/Users/archerclawdington/veneer-os/server/src/providers/claude/adapter.ts)
- [Claude model regression](/Users/archerclawdington/veneer-os/server/test/approvalAdapter.test.ts)
- [Runtime policy regressions](/Users/archerclawdington/veneer-os/server/test/providerRuntimesProvisioner.test.ts)
- [Employee and bot guide catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Guide browser checks](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
- [This maintenance report](/Users/archerclawdington/veneer-os/docs/reports/provider-maintenance-2026-09-23/README.md)
