# Provider maintenance — November 10, 2026 (Claude Fable 5.2)

Build #1038, requested by Nick after Anthropic's November 9 launch of Claude Fable 5.2 and Claude Mythos 5.2.

| Runtime | Previous | Installed and pinned |
| --- | --- | --- |
| Claude Code | 2.1.296 | 2.1.322 |
| Codex CLI (unchanged) | 0.162.1 | 0.162.1 |
| Grok (unchanged) | 1.0.5 | 1.0.5 |

## Why the CLI moved

Claude Code 2.1.296 refused `claude-fable-5-2` (`unrecognized_model`). The [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) adds Fable 5.2 in 2.1.321 and makes it the target of the `fable` alias. Veneer stores full model ids (`claude-fable-5-1`), so no conversation, bot or scheduled task moves to the new model on its own.

## Evidence

- The [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) lists Claude Fable 5.2, `claude-fable-5-2`, with a 1M context window and 128K output. Fable 5.1 is now listed as legacy. Mythos 5.2 is Glasswing-gated and stays excluded.
- The authenticated Models API with the service's active Claude account returned 15 models, `claude-fable-5-2` first.
- Claude 2.1.322 with the service home and account answered `OK` on `claude-fable-5-2` (exit 0, no tools, no MCP, no saved session).

## Source changes

- `LATEST_CLAUDE_MODEL_IDS` adds `claude-fable-5-2` and keeps `claude-fable-5-1` as the previous Fable release.
- Tests cover the catalog filter, the label "Fable 5.2", tier 4 and the 1M context window.

## Validation and deployment

Typecheck passed. Full `npm test` passed: installer 96, server 3,360 (17 skipped), web 1,044, browser-manager 62. `npm run build` passed with only the existing large-chunk warning.

The runtime symlink switch takes effect on each newly spawned Claude turn. The picker change ships with the next web and runner restart, which needs an approved window and is still pending.

## Rollback

Credential-free copies in [rollback-2026-11-10](/Users/archerclawdington/veneer-pro-home/.local/lib/veneer-provider-runtimes/rollback-2026-11-10): Claude 2.1.296 and the prior runtime pins. Under a build slot, revert this change and provision 2.1.296 with `installer/provider-runtimes.mjs --service-home /Users/archerclawdington/veneer-pro-home --provider claude`.
