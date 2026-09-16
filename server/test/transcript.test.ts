import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeProjectKeyForCwd,
  claudeSessionFilePath,
  parseClaudeTranscript,
  pickLatestAiTitle,
  readClaudeTranscript,
} from '../src/providers/claude/transcript.js';
import { parseClaudeTaskNotification } from '../src/providers/claude/subagents.js';
import { _setMediaDirForTest, mediaFilePath } from '../src/runtime/media.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('claude session JSONL transcript parsing', () => {
  it('encodes cwd to a project key the way Claude Code does', () => {
    expect(claudeProjectKeyForCwd('/Users/x y/dev.app')).toBe('-Users-x-y-dev-app');
    expect(claudeSessionFilePath('/tmp/w', 'abc', '/home/u')).toBe(
      '/home/u/.claude/projects/-tmp-w/abc.jsonl',
    );
  });

  it('rehydrates the golden session file into the expected events', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'session.jsonl'), 'utf8');
    const events = parseClaudeTranscript(content);
    const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'session.golden.json'), 'utf8'));
    expect(events).toEqual(golden);
  });

  it('rehydrates reliable per-response usage from Claude native history', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-08-28T19:44:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'response-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
          usage: {
            input_tokens: 100,
            output_tokens: 1,
          },
        },
        timestamp: '2026-08-28T19:45:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'response-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'there.' }],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
            output_tokens: 4,
          },
        },
        timestamp: '2026-08-28T19:45:01.000Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started' }),
      expect.objectContaining({
        type: 'text_final',
        markdown: 'Hi\n\nthere.',
        at: '2026-08-28T19:45:01.000Z',
        usage: {
          inputTokens: 350,
          outputTokens: 4,
          totalInputTokens: 350,
          totalOutputTokens: 4,
          totalTokens: 354,
          cachedInputTokens: 200,
          cacheWriteInputTokens: 50,
        },
      }),
    ]);
  });

  it('aggregates unique Claude calls onto only the final response in a turn', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'research this' },
        timestamp: '2026-08-28T19:44:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'call-1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'safe.txt' } },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 },
        },
        timestamp: '2026-08-28T19:44:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'call-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Finished.' }],
          usage: { input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 5 },
        },
        timestamp: '2026-08-28T19:44:02.000Z',
      }),
    ].join('\n');

    const textEvents = parseClaudeTranscript(content).filter((event) => event.type === 'text_final');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]).toMatchObject({ markdown: 'Checking.' });
    expect(textEvents[0]).not.toHaveProperty('usage');
    expect(textEvents[1]).toMatchObject({
      markdown: 'Finished.',
      usage: {
        inputTokens: 375,
        outputTokens: 15,
        totalInputTokens: 375,
        totalOutputTokens: 15,
        totalTokens: 390,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 25,
      },
    });
  });

  it('reloads a session that Claude saved under a symlink target', async () => {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-claude-symlink-')));
    try {
      const realCwd = path.join(tempDir, 'real-project');
      const linkedCwd = path.join(tempDir, 'linked-project');
      const configDir = path.join(tempDir, 'claude-config');
      const sessionId = 'symlink-session';
      fs.mkdirSync(realCwd);
      fs.symlinkSync(realCwd, linkedCwd, 'dir');
      const sessionPath = claudeSessionFilePath(realCwd, sessionId, tempDir, configDir);
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(
        sessionPath,
        [
          '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-01-01T00:00:00Z"}',
          '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"saved reply"}]},"timestamp":"2026-01-01T00:00:01Z"}',
        ].join('\n'),
      );

      expect(fs.existsSync(claudeSessionFilePath(linkedCwd, sessionId, tempDir, configDir))).toBe(false);
      await expect(readClaudeTranscript(linkedCwd, sessionId, configDir)).resolves.toMatchObject([
        { type: 'turn_started', text: 'hello' },
        { type: 'text_final', markdown: 'saved reply' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips sidechain rows, noise rows, and unparseable lines', () => {
    const content = [
      '{"type":"assistant","isSidechain":true,"message":{"id":"m1","content":[{"type":"text","text":"sidechain"}]}}',
      '{"type":"queue-operation","operation":"enqueue"}',
      '{"type":"last-prompt"}',
      'garbage line',
      '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-01-01T00:00:00Z"}',
    ].join('\n');
    const events = parseClaudeTranscript(content);
    expect(events).toEqual([
      { type: 'turn_started', turnId: 't1', role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z', via: 'web' },
    ]);
  });

  it('keeps visible turns across a native compaction boundary without rendering its hidden summary', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Before compaction' },
        timestamp: '2026-08-19T12:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'before', content: [{ type: 'text', text: 'Visible earlier reply' }] },
        timestamp: '2026-08-19T12:00:01Z',
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 100000 },
        timestamp: '2026-08-19T12:00:02Z',
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: 'user', content: 'Hidden native summary' },
        timestamp: '2026-08-19T12:00:03Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'After compaction' },
        timestamp: '2026-08-19T12:00:04Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: 'Before compaction' }),
      expect.objectContaining({ type: 'text_final', turnId: 't1', markdown: 'Visible earlier reply' }),
      expect.objectContaining({ type: 'turn_started', turnId: 't2', text: 'After compaction' }),
    ]);
  });

  it('hides Claude native compaction command bookkeeping from the visible transcript', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'claude-native-compact-session.jsonl'), 'utf8');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: 'Before compaction' }),
      expect.objectContaining({ type: 'text_final', turnId: 't1', markdown: 'Visible earlier reply' }),
      { type: 'notice', message: 'Context compacted.' },
      expect.objectContaining({ type: 'turn_started', turnId: 't2', text: 'After compaction' }),
      expect.objectContaining({ type: 'text_final', turnId: 't2', markdown: 'Visible later reply' }),
    ]);
  });

  it.each([
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ])('hides Claude native stop/resume bookkeeping for %s', (marker) => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'real-before',
        message: { role: 'user', content: [{ type: 'text', text: 'Before stopping' }] },
        timestamp: '2026-08-23T04:30:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'reply-before',
        parentUuid: 'real-before',
        message: { id: 'reply-before', role: 'assistant', content: [{ type: 'text', text: 'Visible earlier reply' }] },
        timestamp: '2026-08-23T04:30:01Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'native-interruption',
        parentUuid: 'reply-before',
        interruptedByShutdown: true,
        message: { role: 'user', content: [{ type: 'text', text: marker }] },
        timestamp: '2026-08-23T04:30:02Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'native-continuation',
        parentUuid: 'native-interruption',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
        timestamp: '2026-08-23T04:30:03Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'native-no-response',
        parentUuid: 'native-continuation',
        message: {
          id: 'native-no-response',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
        timestamp: '2026-08-23T04:30:03Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'real-after',
        parentUuid: 'native-no-response',
        message: { role: 'user', content: [{ type: 'text', text: 'After stopping' }] },
        timestamp: '2026-08-23T04:30:04Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'reply-after',
        parentUuid: 'real-after',
        message: { id: 'reply-after', role: 'assistant', content: [{ type: 'text', text: 'Visible later reply' }] },
        timestamp: '2026-08-23T04:30:05Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: 'Before stopping' }),
      expect.objectContaining({ type: 'text_final', turnId: 't1', markdown: 'Visible earlier reply' }),
      expect.objectContaining({ type: 'turn_started', turnId: 't2', text: 'After stopping' }),
      expect.objectContaining({ type: 'text_final', turnId: 't2', markdown: 'Visible later reply' }),
    ]);
  });

  it('hides the marker-less runner-kill continuation pair and explains the restart', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'real-before',
        message: { role: 'user', content: [{ type: 'text', text: 'Before the restart' }] },
        timestamp: '2026-09-01T13:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'reply-before',
        parentUuid: 'real-before',
        message: { id: 'reply-before', role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] },
        timestamp: '2026-09-01T13:00:01Z',
      }),
      // A runner kill writes no interruption marker: the continuation's parent
      // is an ordinary row (observed: an attachment row).
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-row',
        parentUuid: 'reply-before',
        timestamp: '2026-09-01T13:08:19Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'native-continuation',
        parentUuid: 'attachment-row',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
        timestamp: '2026-09-01T13:08:19Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'native-no-response',
        parentUuid: 'native-continuation',
        message: {
          id: 'native-no-response',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
        timestamp: '2026-09-01T13:08:19Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'real-after',
        parentUuid: 'native-no-response',
        message: { role: 'user', content: [{ type: 'text', text: 'After the restart' }] },
        timestamp: '2026-09-01T13:08:21Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: 'Before the restart' }),
      expect.objectContaining({ type: 'text_final', turnId: 't1', markdown: 'Working on it' }),
      {
        type: 'notice',
        message: 'Veneer restarted while this turn was running; the agent picked up where it left off.',
        at: '2026-09-01T13:08:19Z',
      },
      expect.objectContaining({ type: 'turn_started', turnId: 't2', text: 'After the restart' }),
    ]);
  });

  it('adds no restart notice when the user stopped the turn', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'native-interruption',
        interruptedByShutdown: true,
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        timestamp: '2026-08-23T04:30:02Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'native-continuation',
        parentUuid: 'native-interruption',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
        timestamp: '2026-08-23T04:30:03Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'native-no-response',
        parentUuid: 'native-continuation',
        message: {
          id: 'native-no-response',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
        timestamp: '2026-08-23T04:30:03Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([]);
  });

  it('keeps look-alike human messages that lack the linked native metadata', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'human-marker',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        timestamp: '2026-08-23T04:31:00Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'human-continuation',
        parentUuid: 'human-marker',
        message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
        timestamp: '2026-08-23T04:31:01Z',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'human-reply',
        parentUuid: 'human-continuation',
        message: {
          id: 'human-reply',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
        },
        timestamp: '2026-08-23T04:31:02Z',
      }),
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: '[Request interrupted by user]' }),
      expect.objectContaining({ type: 'turn_started', turnId: 't2', text: 'Continue from where you left off.' }),
      expect.objectContaining({ type: 'text_final', turnId: 't2', markdown: 'No response requested.' }),
    ]);
  });

  it('does not reuse stale compaction state for a later native stdout envelope', () => {
    const content = [
      '{"type":"user","uuid":"command","message":{"role":"user","content":"<command-name>/compact</command-name>"}}',
      '{"type":"user","uuid":"real","message":{"role":"user","content":"Keep this real turn"}}',
      '{"type":"user","uuid":"late-output","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}',
    ].join('\n');

    expect(parseClaudeTranscript(content)).toEqual([
      expect.objectContaining({ type: 'turn_started', turnId: 't1', text: 'Keep this real turn' }),
    ]);
  });

  it('merges multi-row assistant messages sharing one message id', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"go"},"timestamp":"2026-01-01T00:00:00Z"}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"part one"}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"part two"}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n');
    const events = parseClaudeTranscript(content);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'text_final', turnId: 't1', markdown: 'part one\n\npart two' });
  });

  it('localizes only restored Claude synthetic rate-limit messages', () => {
    const message = "You've hit your session limit · resets 2:30am (UTC)";
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-08-06T00:26:00Z' }),
      JSON.stringify({
        type: 'assistant',
        error: 'rate_limit',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: { id: 'm-limit', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: message }] },
        timestamp: '2026-08-06T00:27:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm-ordinary', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: message }] },
        timestamp: '2026-08-06T00:28:00Z',
      }),
    ].join('\n');
    const replies = parseClaudeTranscript(content).filter((event) => event.type === 'text_final');
    expect(replies.map((event) => event.markdown)).toEqual([
      "You've hit your session limit · resets 10:30 PM EDT",
      message,
    ]);
  });

  it('emits tool_started / tool_finished summaries', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"search something"},"timestamp":"2026-01-01T00:00:00Z"}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"WebSearch","input":{"query":"veneer"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"10 results"}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n');
    const events = parseClaudeTranscript(content);
    expect(events[1]).toMatchObject({
      type: 'tool_started',
      toolId: 'tu1',
      toolName: 'WebSearch',
      displayName: 'Searching the web',
    });
    expect(events[2]).toMatchObject({ type: 'tool_finished', toolId: 'tu1', ok: true, resultPreview: '10 results' });
  });

  it('rehydrates Agent launch through completion without duplicate notifications or private payloads', () => {
    const notification = '<task-notification><tool-use-id>toolu_agent_private</tool-use-id><status>completed</status><summary>raw child result</summary></task-notification>';
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'delegate this' }, timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm-agent',
          content: [{
            type: 'tool_use',
            id: 'toolu_agent_private',
            name: 'Agent',
            input: {
              description: 'Check the mobile layout',
              subagent_type: 'Explore',
              model: 'claude-sonnet-5',
              prompt: 'raw delegated prompt',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_private', content: 'Async agent launched successfully' }] },
        toolUseResult: { status: 'async_launched', description: 'Check the mobile layout', resolvedModel: 'claude-sonnet-5' },
      }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: notification } }),
    ].join('\n');
    const events = parseClaudeTranscript(content);
    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');

    expect(activity.map((event) => event.status)).toEqual(['running', 'running', 'completed']);
    expect(activity.at(-1)).toMatchObject({ currentAction: 'Finished', durationMs: 0 });
    expect(activity[0]).toMatchObject({
      type: 'subagent_started',
      turnId: 't1',
      label: 'Check the mobile layout',
      role: 'Explore',
      model: 'claude-sonnet-5',
    });
    expect(events.some((event) => event.type === 'tool_started' && event.toolName === 'Agent')).toBe(false);
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('toolu_agent_private');
    expect(serialized).not.toContain('raw delegated prompt');
    expect(serialized).not.toContain('raw child result');
  });

  it('maps killed Agent notifications to stopped and suppresses sidechain Agent chatter', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'delegate this' } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_main', name: 'Agent', input: { description: 'Main task' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { description: 'Child chatter' } }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<task-notification><tool-use-id>toolu_main</tool-use-id><status>killed</status></task-notification>' },
      }),
    ].join('\n');
    const events = parseClaudeTranscript(content);
    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ type: 'subagent_started', label: 'Main task', status: 'running' });
    expect(activity[1]).toMatchObject({ type: 'subagent_updated', status: 'stopped' });
    expect(JSON.stringify(events)).not.toContain('Child chatter');
  });

  it('settles Agent launches from a stopped turn when the next prompt arrives', () => {
    const content = [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'first' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_orphan', name: 'Agent', input: { description: 'Orphaned task' } }] },
      }),
      // Stop: no tool_result, no task-notification. Next typed prompt is the boundary.
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:00Z', message: { content: 'second' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:01:01Z',
        message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_done', name: 'Agent', input: { description: 'Finished task' } }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-01T00:02:00Z',
        toolUseResult: { status: 'completed' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_done', content: 'ok' }] },
      }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:03:00Z', message: { content: 'third' } }),
    ].join('\n');
    const events = parseClaudeTranscript(content);
    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity.map((event) => [event.type, event.turnId, event.status])).toEqual([
      ['subagent_started', 't1', 'running'],
      ['subagent_updated', 't1', 'stopped'],
      ['subagent_started', 't2', 'running'],
      ['subagent_updated', 't2', 'completed'],
    ]);
    const orphanStop = activity[1] as Extract<ConversationEvent, { type: 'subagent_updated' }>;
    expect(orphanStop.durationMs).toBe(59_000);
    // The settle lands before the next turn opens so it groups under t1.
    const orphanIdx = events.indexOf(orphanStop);
    const secondTurnIdx = events.findIndex((event) => event.type === 'turn_started' && event.text === 'second');
    expect(orphanIdx).toBeLessThan(secondTurnIdx);
  });

  it('rehydrates final Agent timing and aggregate tool statistics without private output', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'delegate this' },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'm-agent-progress',
          content: [{
            type: 'tool_use',
            id: 'toolu_agent_metrics_private',
            name: 'Agent',
            input: { description: 'Fix tests', prompt: 'raw private child prompt' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_agent_metrics_private',
            content: 'raw private child result',
          }],
        },
        toolUseResult: {
          status: 'completed',
          totalDurationMs: 104_301,
          totalToolUseCount: 14,
          toolStats: { editFileCount: 3, linesAdded: 165, linesRemoved: 32 },
        },
      }),
    ].join('\n');
    const activity = parseClaudeTranscript(content)
      .filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity[0]).toMatchObject({ startedAt: '2026-01-01T00:00:01.000Z', currentAction: 'Starting' });
    expect(activity.at(-1)).toMatchObject({
      status: 'completed',
      currentAction: 'Finished',
      durationMs: 104_301,
      actionCount: 14,
      filesChanged: 3,
      linesAdded: 165,
      linesRemoved: 32,
    });
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain('toolu_agent_metrics_private');
    expect(serialized).not.toContain('raw private');
  });

  it('accepts only exact task-notification lifecycle envelopes', () => {
    expect(parseClaudeTaskNotification('<task-notification><tool-use-id>x</tool-use-id><status>stopped</status></task-notification>')).toEqual({
      toolUseId: 'x',
      status: 'stopped',
    });
    expect(parseClaudeTaskNotification('prefix <task-notification><tool-use-id>x</tool-use-id><status>completed</status></task-notification>')).toBeNull();
    expect(parseClaudeTaskNotification('<task-notification><tool-use-id>x</tool-use-id><status>unknown</status></task-notification>')).toBeNull();
  });

  describe('tool-result images', () => {
    afterEach(() => _setMediaDirForTest(null));

    // 1×1 transparent PNG.
    const PNG_B64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    function toolResultLine(content: unknown): string {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] },
        timestamp: '2026-01-01T00:00:02Z',
      });
    }

    it('saves image blocks to the media store and carries their ids on tool_finished', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-media-'));
      _setMediaDirForTest(dir);
      const content = [
        '{"type":"user","message":{"role":"user","content":"screenshot please"},"timestamp":"2026-01-01T00:00:00Z"}',
        toolResultLine([
          { type: 'text', text: 'took a screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        ]),
      ].join('\n');
      const events = parseClaudeTranscript(content);
      const finished = events.find((e) => e.type === 'tool_finished') as { images?: string[]; resultPreview?: string };
      expect(finished.images).toHaveLength(1);
      const id = finished.images![0]!;
      expect(id).toMatch(/^[a-f0-9]{32}\.png$/);
      expect(fs.readFileSync(mediaFilePath(id)!)).toEqual(Buffer.from(PNG_B64, 'base64'));
      expect(finished.resultPreview).toBe('took a screenshot [image]');
      // Content-addressed: re-parsing the same transcript reuses the same file.
      const again = parseClaudeTranscript(content).find((e) => e.type === 'tool_finished') as { images?: string[] };
      expect(again.images).toEqual([id]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('omits images when the store is uninitialized or the result has none', () => {
      const events = parseClaudeTranscript(
        toolResultLine([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }]),
      );
      expect((events[0] as { images?: string[] }).images).toBeUndefined();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-media-'));
      _setMediaDirForTest(dir);
      const plain = parseClaudeTranscript(toolResultLine('just text'));
      expect((plain[0] as { images?: string[] }).images).toBeUndefined();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects malformed media ids', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-media-'));
      _setMediaDirForTest(dir);
      expect(mediaFilePath('../../etc/passwd')).toBeNull();
      expect(mediaFilePath('abc.png')).toBeNull();
      expect(mediaFilePath('a'.repeat(32) + '.png')).toMatch(/\.png$/);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

describe('ai-title extraction', () => {
  it('returns the latest ai-title row, ignoring everything else', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"go"}}',
      '{"type":"ai-title","aiTitle":"First guess"}',
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"ok"}]}}',
      '{"type":"ai-title","aiTitle":"Better title"}',
    ].join('\n');
    expect(pickLatestAiTitle(content)).toBe('Better title');
  });

  it('returns null when there is no ai-title row, and skips blank/malformed ones', () => {
    expect(pickLatestAiTitle('{"type":"user"}\n\ngarbage\n{"type":"ai-title","aiTitle":"   "}')).toBeNull();
  });
});
