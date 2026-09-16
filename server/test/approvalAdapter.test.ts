import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_BACKGROUND_TASK_RULE, createClaudeAdapter } from '../src/providers/claude/adapter.js';
import { parseClaudeTranscript } from '../src/providers/claude/transcript.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { SteerDelivery, TurnHandle } from '../src/providers/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const TEST_DEVELOPER_INSTRUCTIONS = '# Core Veneer rules\n\n# Fixed chat context';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll for a real signal instead of guessing how long the fake CLI takes to boot. */
async function waitFor(predicate: () => boolean, message: string, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error(message);
}

function turnSpec() {
  return {
    cwd: FIXTURES,
    nativeSessionId: 'fake-session',
    firstTurn: true,
    prompt: 'write the file',
    turnId: 'turn-1',
    developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
  };
}

function runFakeTurn(opts?: { turnTimeoutMs?: number; turnInactivityMs?: number }): {
  handle: TurnHandle;
  events: ConversationEvent[];
  approvalRequested: Promise<Extract<ConversationEvent, { type: 'approval_requested' }>>;
} {
  const adapter = createClaudeAdapter({
    claudeBin: FAKE_CLAUDE,
    turnTimeoutMs: opts?.turnTimeoutMs ?? 60_000,
    ...(opts?.turnInactivityMs === undefined ? {} : { turnInactivityMs: opts.turnInactivityMs }),
    log: { warn: () => undefined, error: () => undefined },
  });
  const events: ConversationEvent[] = [];
  let onApproval: (e: Extract<ConversationEvent, { type: 'approval_requested' }>) => void;
  const approvalRequested = new Promise<Extract<ConversationEvent, { type: 'approval_requested' }>>((resolve) => {
    onApproval = resolve;
  });
  const handle = adapter.runTurn(turnSpec(), (event) => {
    events.push(event);
    if (event.type === 'approval_requested') onApproval(event);
  });
  return { handle, events, approvalRequested };
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  vi.unstubAllGlobals();
});

describe('claude adapter approval round trip (fake CLI)', () => {
  it('lists Opus 5 while preserving the existing current Claude models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
          { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
        ],
      }),
    })));
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      getOauthToken: () => 'test-token',
    });

    await expect(adapter.listModels?.()).resolves.toEqual([
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    ]);
  });

  it('emits approval_requested with the wire request fields', async () => {
    const { handle, approvalRequested } = runFakeTurn();
    const approval = await approvalRequested;
    expect(approval.requestId).toBe('req-1');
    expect(approval.toolName).toBe('Write');
    expect(approval.displayName).toBe('Writing a file');
    expect(approval.inputPreview).toContain('probe.txt');
    handle.kill();
    await handle.done;
  });

  it('allow: control_response is honored, tool finishes ok, turn completes', async () => {
    const { handle, events, approvalRequested } = runFakeTurn();
    const approval = await approvalRequested;
    expect(handle.respondToApproval(approval.requestId, { behavior: 'allow' })).toBe(true);
    await handle.done;

    const toolFinished = events.find((e) => e.type === 'tool_finished');
    expect(toolFinished && toolFinished.ok).toBe(true);
    expect(events.some((e) => e.type === 'text_final' && e.markdown.includes('done (allowed)'))).toBe(true);
    expect(events.at(-1)?.type).toBe('turn_done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('deny: the deny message flows back as a failed tool result and the turn continues', async () => {
    const { handle, events, approvalRequested } = runFakeTurn();
    const approval = await approvalRequested;
    expect(handle.respondToApproval(approval.requestId, { behavior: 'deny', message: 'User said no.' })).toBe(true);
    await handle.done;

    const toolFinished = events.find((e) => e.type === 'tool_finished');
    expect(toolFinished && !toolFinished.ok).toBe(true);
    expect(toolFinished && toolFinished.type === 'tool_finished' && toolFinished.resultPreview).toContain('User said no.');
    expect(events.some((e) => e.type === 'text_final' && e.markdown.includes('denied'))).toBe(true);
    expect(events.at(-1)?.type).toBe('turn_done');
  });

  it('pauses the inactivity watchdog while an approval is pending', async () => {
    // Idle budget far shorter than the human "thinking time" — must NOT fire.
    // It still has to outlast the fake CLI's own startup, because the window is
    // armed when the turn starts, not when the child is ready: under the full
    // suite a node process can take a second just to print its first line, and
    // a shorter budget reaps the turn before the approval is ever requested.
    const INACTIVITY_MS = 4_000;
    const { handle, events, approvalRequested } = runFakeTurn({ turnTimeoutMs: 120_000, turnInactivityMs: INACTIVITY_MS });
    const approval = await approvalRequested;
    await new Promise((r) => setTimeout(r, INACTIVITY_MS + 1_000));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(handle.respondToApproval(approval.requestId, { behavior: 'allow' })).toBe(true);
    await handle.done;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)?.type).toBe('turn_done');
  }, 60_000);

  it('respondToApproval returns false for unknown request ids and dead processes', async () => {
    const { handle, approvalRequested } = runFakeTurn();
    const approval = await approvalRequested;
    expect(handle.respondToApproval('nope', { behavior: 'allow' })).toBe(false);
    handle.kill();
    await handle.done;
    expect(handle.respondToApproval(approval.requestId, { behavior: 'allow' })).toBe(false);
  });

  it('plain turns (no approval) still work end to end', async () => {
    process.env.FAKE_CLAUDE_MODE = 'plain';
    const { handle, events } = runFakeTurn();
    await handle.done;
    expect(events.some((e) => e.type === 'text_final' && e.markdown === 'plain reply')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn_done');
  });

  it('keeps Claude context occupancy separate from whole-turn token usage', async () => {
    process.env.FAKE_CLAUDE_MODE = 'token-usage';
    const { handle, events } = runFakeTurn();
    await handle.done;

    expect(events.at(-1)).toMatchObject({
      type: 'turn_done',
      usage: {
        inputTokens: 112,
        outputTokens: 12,
        totalInputTokens: 450,
        totalOutputTokens: 12,
        totalTokens: 462,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 30,
      },
    });
  });

  it('shows the same Eastern rate-limit reset live and after transcript restore', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate-limit';
    const { handle, events } = runFakeTurn();
    await handle.done;

    const live = events.find((event) => event.type === 'text_final');
    expect(live?.type).toBe('text_final');
    if (live?.type !== 'text_final') return;
    expect(live.markdown).toMatch(/resets \d{1,2}:30 [AP]M E(?:S|D)T$/);
    expect(JSON.stringify(events)).not.toContain('(UTC)');

    const restored = parseClaudeTranscript(JSON.stringify({
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        id: 'm-limit',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your session limit · resets 2:30am (UTC)" }],
      },
      timestamp: live.at,
    }));
    expect(restored).toContainEqual(expect.objectContaining({ type: 'text_final', markdown: live.markdown }));
  });

  it('uses dangerously-skip-permissions only for Full Access turns', async () => {
    process.env.FAKE_CLAUDE_MODE = 'argv';
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      log: { warn: () => undefined, error: () => undefined },
    });
    async function argsFor(dangerous: boolean): Promise<string[]> {
      const events: ConversationEvent[] = [];
      const handle = adapter.runTurn(
        { ...turnSpec(), dangerous, settingsPath: '/tmp/claude-settings.json' },
        (event) => events.push(event),
      );
      await handle.done;
      const output = events.find((event) => event.type === 'text_final');
      return JSON.parse(output && output.type === 'text_final' ? output.markdown : '[]') as string[];
    }

    const normal = await argsFor(false);
    expect(normal).not.toContain('--dangerously-skip-permissions');
    expect(normal).toEqual(expect.arrayContaining(['--permission-prompt-tool', '--permission-mode']));
    const systemPromptAt = normal.indexOf('--append-system-prompt');
    expect(systemPromptAt).toBeGreaterThan(-1);
    expect(normal[systemPromptAt + 1]).toBe(`${TEST_DEVELOPER_INSTRUCTIONS}\n${CLAUDE_BACKGROUND_TASK_RULE}`);
    const disallowedAt = normal.indexOf('--disallowedTools');
    expect(disallowedAt).toBeGreaterThan(-1);
    expect(normal[disallowedAt + 1]?.split(',')).toEqual([
      'ScheduleWakeup',
      'CronCreate',
      'CronList',
      'CronDelete',
      'Monitor',
    ]);

    const fullAccess = await argsFor(true);
    expect(fullAccess).toContain('--dangerously-skip-permissions');
    expect(fullAccess).not.toContain('--permission-prompt-tool');
    expect(fullAccess).not.toContain('--permission-mode');
    expect(fullAccess).toContain('--disallowedTools');
    expect(fullAccess).toEqual(expect.arrayContaining(['--settings', '/tmp/claude-settings.json']));
  });

  it('appends the same developer context when it resumes a native session', async () => {
    process.env.FAKE_CLAUDE_MODE = 'argv';
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      log: { warn: () => undefined, error: () => undefined },
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn({ ...turnSpec(), firstTurn: false }, (event) => events.push(event));
    await handle.done;
    const output = events.find((event) => event.type === 'text_final');
    const args = JSON.parse(output && output.type === 'text_final' ? output.markdown : '[]') as string[];
    expect(args).toEqual(expect.arrayContaining(['--resume', 'fake-session']));
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(
      `${TEST_DEVELOPER_INSTRUCTIONS}\n${CLAUDE_BACKGROUND_TASK_RULE}`,
    );
  });

  it('passes Opus 5 and its maximum supported effort to Claude Code', async () => {
    process.env.FAKE_CLAUDE_MODE = 'argv';
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 5_000,
      log: { warn: () => undefined, error: () => undefined },
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { ...turnSpec(), model: 'claude-opus-5', effort: 'max' },
      (event) => events.push(event),
    );
    await handle.done;
    const output = events.find((event) => event.type === 'text_final');
    const args = JSON.parse(output && output.type === 'text_final' ? output.markdown : '[]') as string[];

    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5', '--effort', 'max']));
  });

  it('keeps an async Agent launch running until its task notification completes', async () => {
    process.env.FAKE_CLAUDE_MODE = 'subagent';
    const { handle, events } = runFakeTurn();
    await handle.done;

    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity[0]?.status).toBe('running');
    expect(activity.at(-1)).toMatchObject({
      status: 'completed',
      currentAction: 'Finished',
      actionCount: 2,
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 1,
      resultLabel: 'Tests passed',
    });
    expect(activity.some((event) => event.currentAction === 'Running tests')).toBe(true);
    expect(activity[0]).toMatchObject({
      type: 'subagent_started',
      label: 'Review the transcript UI',
      model: 'claude-sonnet-5',
      role: 'Explore',
    });
    expect(events.some((event) => event.type === 'tool_started' && event.toolName === 'Agent')).toBe(false);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('toolu_agent_private');
    expect(serialized).not.toContain('raw delegated prompt');
    expect(serialized).not.toContain('raw child output');
    expect(serialized).not.toContain('/private/client/transcript.tsx');
    expect(serialized).not.toContain('private-suite-name');
    expect(serialized).not.toContain('raw test log');
  });

  it('marks a still-running Agent stopped when its provider process is interrupted', async () => {
    process.env.FAKE_CLAUDE_MODE = 'subagent-running';
    const { handle, events } = runFakeTurn();
    // Wait for the child to actually report the running Agent. A fixed sleep
    // here races the fake CLI's startup, and killing first leaves nothing to
    // mark stopped.
    await waitFor(() => events.some((event) => event.type === 'subagent_started'), 'the Agent never started');
    handle.kill();
    await handle.done;
    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity.at(-1)).toMatchObject({ type: 'subagent_updated', status: 'stopped' });
  });

  it('classifies an error-shaped SIGTERM result as a user interruption, not a failure', async () => {
    process.env.FAKE_CLAUDE_MODE = 'interrupt-error-result';
    const { handle, events } = runFakeTurn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.kill();
    await handle.done;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'turn_done',
      outcome: 'interrupted_by_user',
    });
  });

  it('steers through stream-json stdin and acknowledges on the replay', async () => {
    process.env.FAKE_CLAUDE_MODE = 'steer';
    const { handle, events } = runFakeTurn();
    const delivery = await handle.steer?.('new coordination detail');
    expect(delivery).toMatchObject({ delivered: true });
    await expect((delivery as SteerDelivery).acknowledged).resolves.toBe(true);
    await handle.done;
    expect(events.some((event) => event.type === 'turn_started' && event.text === 'new coordination detail')).toBe(true);
    expect(events.some((event) => event.type === 'text_final' && event.markdown === 'followed the steering message')).toBe(true);
  });

  it('reports delivery immediately and acknowledges only once the delayed replay lands', async () => {
    process.env.FAKE_CLAUDE_MODE = 'steer-delayed-echo';
    const { handle, events } = runFakeTurn();
    const delivery = (await handle.steer?.('delayed coordination detail')) as SteerDelivery;
    expect(delivery.delivered).toBe(true);
    let acknowledged: boolean | 'pending' = 'pending';
    void delivery.acknowledged.then((value) => {
      acknowledged = value;
    });

    // Delivery is reported long before the CLI is willing to echo the line.
    await sleep(50);
    expect(acknowledged).toBe('pending');
    expect(events.some((event) => event.type === 'turn_started' && event.text === 'delayed coordination detail')).toBe(false);

    await expect(delivery.acknowledged).resolves.toBe(true);
    expect(events.some((event) => event.type === 'turn_started' && event.text === 'delayed coordination detail')).toBe(true);
    await handle.done;
  });

  it('refuses to acknowledge an echo that arrives while the turn is being killed', async () => {
    process.env.FAKE_CLAUDE_MODE = 'steer-echo-after-kill';
    const { handle, events } = runFakeTurn();
    await sleep(50);
    const delivery = (await handle.steer?.('stopped before it counted')) as SteerDelivery;
    expect(delivery.delivered).toBe(true);

    handle.kill();
    // The CLI still echoes the line, but this turn is being discarded.
    await expect(delivery.acknowledged).resolves.toBe(false);
    await handle.done;
    expect(events.some((event) => event.type === 'turn_started' && event.text === 'stopped before it counted')).toBe(false);
  });

  it('acknowledges false when the turn ends before the steered line is replayed', async () => {
    process.env.FAKE_CLAUDE_MODE = 'interrupt-error-result';
    const { handle } = runFakeTurn();
    await sleep(50);
    const delivery = (await handle.steer?.('never replayed')) as SteerDelivery;
    expect(delivery.delivered).toBe(true);
    handle.kill();
    await expect(delivery.acknowledged).resolves.toBe(false);
    await handle.done;
  });

  it('a missing CLI binary settles once: exactly one error and one turn_done', async () => {
    // The child's `error` and `close` handlers both fire (close with code -2);
    // the settled guard must keep the turn from emitting two error bubbles and
    // a stray second turn_done.
    const adapter = createClaudeAdapter({
      claudeBin: path.join(FIXTURES, 'does-not-exist.mjs'),
      turnTimeoutMs: 5_000,
      log: { warn: () => undefined, error: () => undefined },
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (event) => events.push(event));
    await handle.done;
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn_done')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('turn_done');
  });
});
