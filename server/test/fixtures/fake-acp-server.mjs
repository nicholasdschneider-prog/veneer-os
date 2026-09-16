#!/usr/bin/env node
// Minimal stand-in for `grok agent --always-approve --no-leader stdio`, used by
// grokAcp.test.ts. Speaks the ACP subset the adapter depends on: initialize
// (with _meta.modelState), session/new (success or the real pre-login auth
// error), session/load (history replay before the response), session/prompt
// (streamed session/update notifications, then a stopReason), session/cancel,
// and session/set_model.
//
// Behaviour is driven entirely by env vars so each test can script one path.
import fs from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

// Lets a test assert on the environment the adapter actually handed the child.
if (process.env.CHILD_ENV_LOG) {
  fs.appendFileSync(process.env.CHILD_ENV_LOG, `${JSON.stringify(process.env)}\n`);
}

const SESSION_ID = process.env.FAKE_SESSION_ID ?? 's1';
let activePromptId = null;

function log(file, entry) {
  if (file) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function update(sessionId, body) {
  send({ method: 'session/update', params: { sessionId, update: body } });
}

/** Emit the scripted turn stream, then answer the pending session/prompt. */
function runTurn(sessionId) {
  // DIE_ONCE_MARKER makes only the FIRST spawn die, so a test can watch the
  // client respawn without mutating an env the client captured at construction.
  if (process.env.DIE_MID_TURN === '1' && !(process.env.DIE_ONCE_MARKER && fs.existsSync(process.env.DIE_ONCE_MARKER))) {
    if (process.env.DIE_ONCE_MARKER) fs.writeFileSync(process.env.DIE_ONCE_MARKER, 'died');
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (process.env.HANG_TURN === '1') return; // never answers — test cancels or times out

  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' some more' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
  const genericTools = process.env.GENERIC_TOOL_KINDS === '1';
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'echo hi > report.csv',
    kind: genericTools ? 'other' : 'execute',
    status: 'pending',
    rawInput: genericTools ? { command: 'echo hi > report.csv' } : 'echo hi > report.csv',
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'wrote report.csv' } }],
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-2',
    title: 'veneer_browser__navigate',
    kind: 'other',
    status: 'in_progress',
    rawInput: { url: 'https://example.com' },
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-2',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'navigation blocked' } }],
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-3',
    title: 'Edit notes.html',
    kind: genericTools ? 'other' : 'edit',
    status: 'completed',
    locations: [{ path: 'notes.html' }, { path: 'ignored.bin' }],
  });
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'ignored', status: 'pending' }] });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });

  if (process.env.EMIT_PERMISSION_REQUEST === '1') {
    send({
      id: 'perm-1',
      method: 'session/request_permission',
      params: { sessionId, toolCall: { toolCallId: 'call-9' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
    });
  }
  if (process.env.EMIT_UNKNOWN_REQUEST === '1') {
    send({ id: 'future-1', method: 'fs/read_text_file', params: { sessionId, path: '/etc/passwd', sensitivePayload: 'must not be logged' } });
  }

  const finish = () => {
    if (activePromptId === null) return;
    const id = activePromptId;
    activePromptId = null;
    send({ id, result: { stopReason: process.env.STOP_REASON ?? 'end_turn' } });
  };
  if (process.env.AWAIT_CANCEL === '1') return; // only the cancel notification ends this turn
  finish();
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === undefined) {
    log(process.env.CLIENT_RESPONSE_LOG, m);
    return;
  }
  log(process.env.REQUEST_LOG, { method: m.method, params: m.params });

  switch (m.method) {
    case 'initialize':
      if (process.env.HANG_INITIALIZE === '1') break;
      send({
        id: m.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          authMethods: [{ id: 'grok.com', name: 'Grok' }],
          _meta: {
            modelState: {
              currentModelId: 'grok-4.5',
              availableModels: [
                {
                  modelId: 'grok-4.5',
                  name: 'Grok 4.5',
                  _meta: {
                    totalContextTokens: 500000,
                    reasoningEffort: 'high',
                    reasoningEfforts: [
                      { id: 'high', value: 'high' },
                      { id: 'medium', value: 'medium' },
                      { id: 'low', value: 'low' },
                    ],
                  },
                },
                { modelId: 'grok-4-fast', name: 'Grok 4 Fast', _meta: { totalContextTokens: 256000 } },
                { modelId: 'grok-imagine-image', name: 'Grok Imagine (image)', _meta: { totalContextTokens: 0 } },
                { modelId: 'grok-imagine-video', name: 'Grok Imagine (video)' },
              ],
            },
          },
        },
      });
      send({ method: '_x.ai/mcp/servers_updated', params: { mcpServers: [] } });
      break;

    case 'session/new':
      if (process.env.REQUIRE_AUTH === '1') {
        send({ id: m.id, error: { code: -32000, message: 'Authentication required', data: 'no auth method id provided' } });
        break;
      }
      if (process.env.HANG_SESSION_NEW === '1') break; // test stops before any session id exists
      send({ id: m.id, result: { sessionId: SESSION_ID } });
      if (process.env.EARLY_UPDATE === '1') {
        // Arrives on the same tick as the response — the client must buffer it
        // until the adapter has had a chance to subscribe.
        update(SESSION_ID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early-chunk ' } });
      }
      break;

    case 'session/load': {
      const sessionId = m.params?.sessionId ?? SESSION_ID;
      // A real session/load replays the whole history BEFORE resolving.
      update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed user turn' } });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-HISTORY' } });
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'replayed-call',
        title: 'replayed tool',
        kind: 'execute',
        status: 'completed',
      });
      send({ id: m.id, result: {} });
      break;
    }

    case 'session/set_model':
      if (process.env.REJECT_SET_MODEL === '1') {
        send({ id: m.id, error: { code: -32602, message: 'Invalid params', data: 'unknown model id' } });
        break;
      }
      send({ id: m.id, result: {} });
      break;

    case 'session/prompt': {
      const sessionId = m.params?.sessionId ?? SESSION_ID;
      activePromptId = m.id;
      runTurn(sessionId);
      break;
    }

    case 'session/cancel': {
      if (process.env.OMIT_CANCEL_RESPONSE === '1') break;
      const delayMs = Number(process.env.CANCEL_RESPONSE_DELAY_MS ?? 0);
      const id = activePromptId;
      activePromptId = null;
      if (id === null) break;
      setTimeout(() => send({ id, result: { stopReason: 'cancelled' } }), delayMs);
      break;
    }

    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
      break;
  }
});
