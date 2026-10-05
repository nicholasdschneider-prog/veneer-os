import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../src/providers/codexAppServer/adapter.js';
import { AppServerClient } from '../src/providers/codexAppServer/protocol.js';
import type { TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import { descendantCounts } from '../src/runner/resourceMonitor.js';

const fake = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const silent = { warn() {}, error() {} };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); await delay(50); });
async function until(predicate: () => boolean) {
  const end = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition not reached'); await delay(10); }
}
function setup(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-lifecycle-test-'));
  const requestLog = path.join(dir, 'requests.jsonl');
  const buildEnv = () => ({ ...process.env, ...env, REQUEST_LOG: requestLog });
  const adapter = createCodexAdapter({ codexBin: fake, transcriptsDir: dir, turnTimeoutMs: 10_000,
    interruptCompletionTimeoutMs: 30, buildEnv, log: silent });
  const requests = (): Array<{ method: string; params?: Record<string, unknown> }> =>
    fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  cleanups.push(() => {
    for (const { pid } of adapter.runtimeResources!()) { if (pid) try { process.kill(pid, 'SIGTERM'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, adapter, requests, buildEnv };
}
const spec = (extra: Partial<TurnSpec> = {}): TurnSpec => ({ cwd: os.tmpdir(), nativeSessionId: 't1', firstTurn: true,
  prompt: 'hello', turnId: 'v1', dangerous: true, ...extra });
const releases = (requests: ReturnType<ReturnType<typeof setup>['requests']>) => requests.filter((r) => r.method === 'thread/unsubscribe');

describe('persistent Codex bots release idle runtime subscriptions', () => {
  it('releases after confirmed completion, preserves history, and resumes the same thread', async () => {
    const { adapter, dir, requests } = setup({ COMPLETE_TURNS: '1' });
    await adapter.runTurn(spec(), () => undefined).done;
    await until(() => releases(requests()).length === 1);
    expect(fs.readFileSync(path.join(dir, 't1.jsonl'), 'utf8')).toContain('turn_done');
    await adapter.runTurn(spec({ firstTurn: false, turnId: 'v2' }), () => undefined).done;
    await until(() => releases(requests()).length === 2);
    expect(requests().find((r) => r.method === 'thread/resume')?.params?.threadId).toBe('t1');
    expect(requests().map((r) => r.method)).not.toContain('thread/fork');
    expect(requests().map((r) => r.method)).not.toContain('thread/archive');
    expect(requests().map((r) => r.method)).not.toContain('thread/delete');
  });

  it('keeps an active turn and pending approval subscribed until confirmed interrupted', async () => {
    const { adapter, requests } = setup();
    const events: ConversationEvent[] = [];
    const turn = adapter.runTurn(spec(), (e) => events.push(e));
    await until(() => requests().some((r) => r.method === 'turn/start'));
    await delay(50);
    expect(releases(requests())).toHaveLength(0);
    turn.kill(); await turn.done;
    await until(() => releases(requests()).length === 1);
  });

  it('does not release a parent with a still-running delegated child', async () => {
    const { adapter, requests } = setup({ EMIT_COLLAB_RUNNING: '1' });
    const events: ConversationEvent[] = [];
    const turn = adapter.runTurn(spec(), (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'subagent_started' && e.status === 'running'));
    turn.kill(); await turn.done; await delay(50);
    expect(releases(requests())).toHaveLength(0);
    expect(adapter.runtimeResources!()[0].pinnedThreads).toBe(1);
  });

  it('does not treat a local interrupt timeout as a native completion', async () => {
    const { adapter, requests } = setup({ OMIT_INTERRUPT_COMPLETION: '1' });
    const turn = adapter.runTurn(spec(), () => undefined);
    await until(() => requests().some((r) => r.method === 'turn/start'));
    turn.kill(); await turn.done; await delay(50);
    expect(releases(requests())).toHaveLength(0);
    expect(adapter.runtimeResources!()[0].pinnedThreads).toBe(1);
  });

  it('waits for an in-flight unsubscribe before resuming, so a late release cannot detach the new turn', async () => {
    const releaseFile = path.join(os.tmpdir(), `veneer-release-${crypto.randomUUID()}`);
    cleanups.push(() => fs.rmSync(releaseFile, { force: true }));
    const { adapter, requests } = setup({ COMPLETE_TURNS: '1', UNSUBSCRIBE_RELEASE_FILE: releaseFile });
    await adapter.runTurn(spec(), () => undefined).done;
    await until(() => releases(requests()).length === 1);
    const next = adapter.runTurn(spec({ firstTurn: false, turnId: 'v2' }), () => undefined);
    await delay(5_100); // exceeds the warning deadline; the real response must remain recoverable
    expect(requests().filter((r) => r.method === 'thread/resume')).toHaveLength(0);
    fs.writeFileSync(releaseFile, 'ready');
    await next.done;
    expect(requests().filter((r) => r.method === 'thread/resume')).toHaveLength(1);
  });

  it('does not fail future wakes when native unsubscribe explicitly rejects', async () => {
    const { adapter, requests } = setup({ COMPLETE_TURNS: '1', UNSUBSCRIBE_ERROR: '1' });
    await adapter.runTurn(spec(), () => undefined).done;
    const events: ConversationEvent[] = [];
    await adapter.runTurn(spec({ firstTurn: false, turnId: 'v2' }), (e) => events.push(e)).done;
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
    expect(requests().filter((r) => r.method === 'thread/resume')).toHaveLength(1);
  });

  it('releases a child and its idle parent when the child finishes after the parent turn', async () => {
    const releaseFile = path.join(os.tmpdir(), `veneer-child-${crypto.randomUUID()}`);
    cleanups.push(() => fs.rmSync(releaseFile, { force: true }));
    const { adapter, requests } = setup({ EMIT_COLLAB_RUNNING: '1', LATE_CHILD_RELEASE_FILE: releaseFile });
    const events: ConversationEvent[] = [];
    const turn = adapter.runTurn(spec(), (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'subagent_started' && e.status === 'running'));
    turn.kill(); await turn.done;
    expect(adapter.runtimeResources!()[0].pinnedThreads).toBe(1);
    fs.writeFileSync(releaseFile, 'done');
    await until(() => releases(requests()).length === 2);
    expect(releases(requests()).map((r) => r.params?.threadId).sort()).toEqual(['running-child-secret', 't1']);
    expect(adapter.runtimeResources!()[0].pinnedThreads).toBe(0);
  });

  it('does not pin a thread when resume fails before any native turn was requested', async () => {
    const errorFile = path.join(os.tmpdir(), `veneer-resume-error-${crypto.randomUUID()}`);
    fs.writeFileSync(errorFile, 'temporary resume rejection');
    cleanups.push(() => fs.rmSync(errorFile, { force: true }));
    const { adapter } = setup({ RESUME_ERROR_FILE: errorFile });
    await adapter.runTurn(spec({ firstTurn: false }), () => undefined).done;
    expect(adapter.runtimeResources!()[0].pinnedThreads).toBe(0);
  });

  it('releases after native compaction completes', async () => {
    const { adapter, requests } = setup({ COMPACT_MODE: 'success' });
    await adapter.compactSession!({ cwd: os.tmpdir(), nativeSessionId: 't1' }).done;
    await until(() => releases(requests()).length === 1);
  });

  it('does not let a late child completion clear an unrelated unknown compaction', async () => {
    const { requests, buildEnv } = setup();
    const client = new AppServerClient({ codexBin: fake, env: buildEnv(), log: silent });
    cleanups.push(() => client.shutdown());
    await client.request('thread/start', {});
    client.holdThread('t1')('children-running');
    client.holdThread('t1')('unknown');
    client.childrenFinished('t1');
    await delay(30);
    expect(releases(requests())).toHaveLength(0);
    expect(client.resourceUsage().pinnedThreads).toBe(1);
    client.holdThread('t1')('finished');
    await until(() => releases(requests()).length === 1);
  });

  it('protects other active users of the same thread', async () => {
    const { requests, buildEnv } = setup();
    const client = new AppServerClient({ codexBin: fake, env: buildEnv(), log: silent });
    cleanups.push(() => client.shutdown());
    await client.request('thread/start', {});
    const a = client.holdThread('t1'); const b = client.holdThread('t1');
    a('finished'); await delay(30);
    expect(releases(requests())).toHaveLength(0);
    b('finished'); await until(() => releases(requests()).length === 1);
  });
});

it('counts resource parents using only numeric process metadata', () => {
  expect([...descendantCounts(' 1 0\n 22 1\n 23 1\n 44 22\ninvalid\n', [1, 22, 99])]).toEqual([[1, 3], [22, 1], [99, 0]]);
});
