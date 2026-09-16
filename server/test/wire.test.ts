import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { controlResponseLine, parseWireLine } from '../src/providers/claude/wire.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('claude stream-json wire parsing', () => {
  const lines = fs
    .readFileSync(path.join(FIXTURES, 'stream.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());

  it('parses every line of a real captured stream without crashing', () => {
    for (const line of lines) {
      expect(parseWireLine(line)).not.toBeNull();
    }
  });

  it('classifies the init, deltas, assistant and result messages', () => {
    const parsed = lines.map((l) => parseWireLine(l)!);
    const kinds = parsed.map((p) => p.kind);
    expect(kinds).toContain('init');
    expect(kinds).toContain('stream_event');
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('result');

    const init = parsed.find((p) => p.kind === 'init');
    expect(init?.kind === 'init' && init.msg.session_id).toMatch(/^[0-9a-f-]{36}$/);

    const deltas = parsed.filter(
      (p) => p.kind === 'stream_event' && p.msg.event.type === 'content_block_delta' && p.msg.event.delta?.type === 'text_delta',
    );
    expect(deltas.length).toBeGreaterThan(0);

    const result = parsed.find((p) => p.kind === 'result');
    expect(result?.kind === 'result' && result.msg.usage?.output_tokens).toBeGreaterThan(0);
  });

  it('parses per-call usage off assistant messages (context readout source)', () => {
    // The composer's context readout needs the LAST call's occupancy — the
    // result message's usage aggregates every call in the turn and can exceed
    // the window several times over on tool-heavy turns (seen live: 4.1M/1M).
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":2537,"cache_read_input_tokens":231616,"output_tokens":223,"server_tool_use":{"web_search_requests":0}}},"parent_tool_use_id":null}';
    const parsed = parseWireLine(line);
    expect(parsed?.kind).toBe('assistant');
    if (parsed?.kind !== 'assistant') return;
    const u = parsed.msg.message.usage!;
    expect((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)).toBe(
      234_155,
    );
    // Usage is optional — assistant messages without it still parse.
    expect(parseWireLine('{"type":"assistant","message":{"role":"assistant","content":[]}}')?.kind).toBe('assistant');
  });

  it('preserves Claude API-error metadata on synthetic assistant messages', () => {
    const parsed = parseWireLine(JSON.stringify({
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your session limit · resets 2:30am (UTC)" }],
      },
    }));
    expect(parsed?.kind).toBe('assistant');
    if (parsed?.kind !== 'assistant') return;
    expect(parsed.msg).toMatchObject({ error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429 });
  });

  it('preserves Claude async Agent launch metadata on tool-result messages', () => {
    const parsed = parseWireLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'private-id', content: 'Async agent launched successfully' }],
      },
      toolUseResult: {
        status: 'async_launched',
        description: 'Review the UI',
        resolvedModel: 'claude-sonnet-5',
      },
      parent_tool_use_id: null,
    }));
    expect(parsed?.kind).toBe('user');
    if (parsed?.kind !== 'user') return;
    expect(parsed.msg.toolUseResult).toEqual({
      status: 'async_launched',
      description: 'Review the UI',
      resolvedModel: 'claude-sonnet-5',
    });
  });

  it('parses a real can_use_tool control_request (2.1.200 capture)', () => {
    // Verbatim shape observed live — request_id is top-level, field is `input`.
    const line =
      '{"type":"control_request","request_id":"1093cc4f-53f7-407a-82d5-531401ae056a","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/probe-approval.txt","content":"allow-path-works"},"description":"probe-approval.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01BJXbNr6H2zhEz9fJu5vjUd"}}';
    const parsed = parseWireLine(line);
    expect(parsed?.kind).toBe('control_request');
    if (parsed?.kind !== 'control_request') return;
    expect(parsed.msg.request_id).toBe('1093cc4f-53f7-407a-82d5-531401ae056a');
    expect(parsed.msg.request.tool_name).toBe('Write');
    expect(parsed.msg.request.input).toMatchObject({ file_path: '/tmp/probe-approval.txt' });

    // Unknown control subtypes are skipped, never surfaced as approvals.
    expect(parseWireLine('{"type":"control_request","request_id":"x","request":{"subtype":"mystery"}}')).toEqual({
      kind: 'skip',
      type: 'control_request:mystery',
    });
  });

  it('serializes control responses in the verified double-wrapped envelope', () => {
    expect(JSON.parse(controlResponseLine('r1', { behavior: 'allow', updatedInput: { a: 1 } }))).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { a: 1 } } },
    });
    expect(JSON.parse(controlResponseLine('r2', { behavior: 'deny', message: 'no' }))).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: 'no' } },
    });
  });

  it('skips hook noise and unknown types instead of crashing', () => {
    expect(parseWireLine('{"type":"system","subtype":"hook_started","hook_id":"x"}')).toEqual({
      kind: 'skip',
      type: 'system:hook_started',
    });
    expect(parseWireLine('{"type":"rate_limit_event","rate_limit_info":{}}')).toEqual({
      kind: 'skip',
      type: 'rate_limit_event',
    });
    expect(parseWireLine('{"type":"some_future_thing"}')).toEqual({ kind: 'skip', type: 'some_future_thing' });
    expect(parseWireLine('not json at all')).toBeNull();
  });
});
