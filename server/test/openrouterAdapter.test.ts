import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenRouterAdapter, buildOpenRouterSpawnEnv } from '../src/providers/openrouter/adapter.js';
import { loadOpenRouterModels } from '../src/providers/openrouter/models.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const dirs: string[] = [];

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_EXPECT_OPENROUTER_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OpenRouter Claude Code adapter', () => {
  it('scrubs Claude auth and pins every Claude Code role to the exact model', () => {
    const prepared = buildOpenRouterSpawnEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret', ANTHROPIC_API_KEY: 'anthropic-secret' },
      '/data/claude-openrouter',
      'openrouter-secret',
      'z-ai/glm-5.2',
    );
    expect(prepared.hasCredential).toBe(true);
    expect(prepared.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/data/claude-openrouter',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'openrouter-secret',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'z-ai/glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'z-ai/glm-5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.2',
      CLAUDE_CODE_SUBAGENT_MODEL: 'z-ai/glm-5.2',
    });
    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('runs the shared harness with an isolated profile and exact fallback model', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-openrouter-profile-'));
    dirs.push(configDir);
    process.env.FAKE_CLAUDE_MODE = 'openrouter-env';
    process.env.FAKE_EXPECT_OPENROUTER_KEY = 'or-test-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'must-not-leak';
    const adapter = createOpenRouterAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      configDir,
      buildEnv: () => ({ ...process.env, NM_SEARCH_API_TOKEN: 'test-only' }),
      getApiKey: () => 'or-test-key',
      getModelIds: () => ['z-ai/glm-5.2'],
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      {
        cwd: FIXTURES,
        nativeSessionId: 'or-session',
        firstTurn: true,
        prompt: 'hello',
        turnId: 'turn-1',
        effort: 'max',
      },
      (event) => events.push(event),
    );
    await handle.done;
    const text = events.find((event) => event.type === 'text_final');
    expect(text && text.type === 'text_final' ? JSON.parse(text.markdown) : null).toEqual({
      model: 'z-ai/glm-5.2',
      effort: null,
      configDir,
      baseUrl: 'https://openrouter.ai/api',
      authMatchesExpected: true,
      apiKeyBlank: true,
      oauthAbsent: true,
      roleModelsPinned: true,
      nmSearchTokenPresent: true,
      disallowedTools: ['ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete', 'Monitor'],
    });
    expect(events.at(-1)?.type).toBe('turn_done');
  });

  it('commits streamed text when OpenRouter omits the assistant envelope', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-openrouter-profile-'));
    dirs.push(configDir);
    process.env.FAKE_CLAUDE_MODE = 'stream-only';
    const adapter = createOpenRouterAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      configDir,
      getApiKey: () => 'or-test-key',
      getModelIds: () => ['moonshotai/kimi-k3'],
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      {
        cwd: FIXTURES,
        nativeSessionId: 'or-stream-session',
        firstTurn: true,
        prompt: 'hello',
        turnId: 'turn-stream',
      },
      (event) => events.push(event),
    );

    await handle.done;

    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(2);
    expect(events.find((event) => event.type === 'text_final')).toMatchObject({
      type: 'text_final',
      markdown: 'streamed reply',
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
  });

  it('returns only configured catalog models in configured order', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'moonshotai/kimi-k3', name: 'MoonshotAI: Kimi K3' },
            { id: 'z-ai/glm-5.2', name: 'Z.AI: GLM 5.2' },
            { id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek V4 Flash Latest' },
            { id: 'thinkingmachines/inkling', name: 'Thinking Machines: Inkling' },
            { id: 'unconfigured/model', name: 'Must not appear' },
          ],
        }),
        { status: 200 },
      );
    const models = await loadOpenRouterModels(
      ['z-ai/glm-5.2', 'moonshotai/kimi-k3', '~deepseek/deepseek-v4-flash-latest', 'thinkingmachines/inkling'],
      'key',
      fetcher as typeof fetch,
    );
    expect(models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'z-ai/glm-5.2', label: 'Z.AI: GLM 5.2' },
      { id: 'moonshotai/kimi-k3', label: 'MoonshotAI: Kimi K3' },
      { id: '~deepseek/deepseek-v4-flash-latest', label: 'Deepseek V4 Flash' },
      { id: 'thinkingmachines/inkling', label: 'Thinking Machines: Inkling' },
    ]);
  });
});
