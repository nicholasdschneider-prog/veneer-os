# Claude cache investigation — September 23, 2026

John Webber's proposed `CLAUDE_CODE_MODEL_CAPABILITIES=-mid_conv_system` setting did not improve cache reuse in these isolated tests. Claude Code 2.1.280 itself substantially improved the first resumed turn compared with Veneer's pinned 2.1.259. No live runtime, environment setting, provider policy, or service was changed.

## Measured results

These are the first resumed turns after a successful reply without tool calls. Cache reuse is `cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)`. Raw per-turn measurements, including unsuccessful turns, are in [measurements.json](./measurements.json).

| Scenario | Runtime | John’s override | Cache read tokens | Cache write tokens | Cache reuse |
|---|---|---|---:|---:|---:|
| Short replies, long system context | 2.1.259 | Off | 1,256 | 11,939 | 9.52% |
| Short replies, long system context | 2.1.259 | On | 1,256 | 11,939 | 9.52% |
| Short replies, long system context | 2.1.280 | Off | 13,348 | 39 | 99.69% |
| Short replies, long system context | 2.1.280 | On | 13,299 | 54 | 99.58% |
| Inventory questions, long user context | 2.1.259 | Off | 1,256 | 17,464 | 6.71% |
| Inventory questions, long user context | 2.1.259 | On | 1,256 | 17,502 | 6.70% |
| Inventory questions, long user context | 2.1.280 | Off | 18,720 | 202 | 98.92% |
| Inventory questions, long user context | 2.1.280 | On | 18,671 | 205 | 98.90% |
| Inventory, system-prompt snapshot off | 2.1.280 | Off | 18,729 | 205 | 98.91% |
| Inventory, system-prompt snapshot off | 2.1.280 | On | 18,680 | 225 | 98.80% |

The old runtime recovered to above 99% reuse on the following inventory turn with either setting. We did **not** reproduce a cache loss after every tool-free response. Small differences between override arms are not evidence of a benefit or regression: generated replies and context lengths vary.

## Method and validation

- Used the installed 2.1.259 binary and an isolated official darwin-arm64 2.1.280 download. Its SHA-256 matched the [official version manifest](https://downloads.claude.ai/claude-code-releases/2.1.280/manifest.json): `387a5c5dcdbb815085edf0baf79591f9d8894efe922bceaf3d75b1b08055229d`.
- Binary string checks found the override's full name in 2.1.280 but not 2.1.259, checking UTF-8 and UTF-16LE. Both contain `mid_conv_system`. Combined with identical old-version results, this supports treating the override as ineffective on our pinned version; string presence alone does not prove behavior.
- Used `claude-opus-5`, low effort, the current connected Claude subscription, isolated profiles and working directories, synthetic data, and a fresh session per arm. Credentials were passed directly to the approved Claude process at launch; none are in this report or evidence.
- Matched Veneer's process-per-turn approach: `-p`, streaming JSON input/output, a fixed `--append-system-prompt`, `--session-id` initially, and `--resume` for subsequent turns. Held stdin open until the result, then closed it. Disabled background tasks and auto-updates. Some processes required termination after a post-result shutdown grace period; the next process resumed the persisted session successfully.
- Loaded only the built-in Read tool with its permission and an empty strict MCP configuration; omitted user/project settings. No business connectors, real customer data, or production conversations were involved. No claim is made about the complete Veneer toolbox.
- Initial synthetic context: 220 inventory-style system lines and short replies. Follow-up: 350 fictional inventory rows in the first user message, followed by normal inventory questions. Per-arm item codes/profile paths differ to avoid assuming a cold cache shared between experiments; a small built-in prefix was shared and sometimes cached on initial turns.
- All 20 inventory turns and all six snapshot-off turns succeeded. Each of the four inventory arms successfully read a local fixture on turn four, verified from the tool-result record, then answered another question on turn five.
- Four of 16 initial short-reply turns were rejected by Opus 5's safeguards (`reasoning_extraction`). Those turns are marked unsuccessful and excluded from success comparisons. No safeguards were disabled. The inventory follow-up used ordinary questions, with no request for hidden reasoning.
- Used per-result `usage` counters, not accumulated `modelUsage` or `total_cost_usd`. The latter accumulated across resumes in 2.1.280 during this test, unlike 2.1.259. They would make a direct per-turn cost comparison misleading.
- Evidence validation checked 42 total records, 26 successful inventory/snapshot-off records, and four successful inventory Read calls. This is a documentation-only investigation: application typecheck/build/restart were not needed or run.

## Recommendation and upgrade caveats

Do not add the proposed environment variable to the current installation: the evidence shows no benefit. A controlled upgrade to 2.1.280 is a promising next step, with cache behavior rechecked against Veneer's full tool configuration and actual selected models before deployment. This experiment did not approve or perform that upgrade.

An upgrade also needs to preserve updated instructions in existing chats. The 2.1.280 CLI help says system-prompt snapshots now default to on, including appended instructions, and later changes are ignored until compaction. Veneer's adapter currently passes updated provider instructions on each resume. Explicit `--system-prompt-snapshot off` is a candidate compatibility measure; the six-turn follow-up retained high cache reuse with it, but instruction-update behavior still needs its own integration check.

Anthropic's [official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) describes several cache-stability improvements between these versions, including changes to system-prompt/tool recording in 2.1.267. We cannot attribute the measured version improvement to one specific fix; high reuse persisted with snapshots off.

These are small synthetic experiments on one account/model, within a warm-cache interval, not a measured subscription-quota or invoice saving. They do not establish a universal 25× improvement, cache retention after long idle periods, behavior with dynamic MCP tools, or complete runtime-upgrade compatibility. Anthropic documents the usage counters and cache requirements in its [prompt-caching reference](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
