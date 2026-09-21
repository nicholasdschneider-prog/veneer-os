#!/usr/bin/env node
// Minimal stand-in for `codex app-server --stdio` used by codexAppServer.test.ts.
// Answers initialize + thread/start|resume, then keeps the turn active until an
// approval response, a scripted completion, or turn/interrupt.
// When env HANG_START=1 it also hangs thread/start, to exercise a Stop that
// lands before any thread id is resolved.
import fs from 'node:fs';
import readline from 'node:readline';

// The client probes the binary version before spawning the server; answer and
// exit so the probe never waits on the stdin server loop below.
if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.CODEX_FAKE_VERSION ?? 'codex-cli 0.147.0'}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let pendingServerRequestId = null;
let pendingServerTurnId = null;
let nextTurnNumber = 1;
let activeTurnId = null;
let interruptCount = 0;

function completeTurn(threadId, turnId, status = 'completed') {
  send({
    method: 'turn/completed',
    params: { threadId, turnId, turn: { id: turnId, status, error: null } },
  });
}

function sendInterruptCompletion(threadId, turnId) {
  if (process.env.INTERRUPT_RELEASE_FILE) {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.INTERRUPT_RELEASE_FILE)) return;
      clearInterval(timer);
      completeTurn(threadId, turnId, 'interrupted');
    }, 5);
    return;
  }
  const delayMs = Number(process.env.INTERRUPT_COMPLETION_DELAY_MS ?? 0);
  setTimeout(() => completeTurn(threadId, turnId, 'interrupted'), delayMs);
}

function logServerResponse(message) {
  if (process.env.SERVER_RESPONSE_LOG) {
    fs.appendFileSync(process.env.SERVER_RESPONSE_LOG, `${JSON.stringify(message)}\n`);
  }
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
    logServerResponse(m);
    if (m.id === pendingServerRequestId) {
      pendingServerRequestId = null;
      completeTurn('t1', pendingServerTurnId ?? activeTurnId, 'completed');
      pendingServerTurnId = null;
    }
    return;
  }
  if (process.env.REQUEST_LOG && m.method) {
    const entry = { method: m.method, params: m.params };
    fs.appendFileSync(process.env.REQUEST_LOG, `${JSON.stringify(entry)}\n`);
  }
  switch (m.method) {
    case 'initialize':
      send({ id: m.id, result: {} });
      break;
    case 'initialized':
      break;
    case 'thread/start':
      if (process.env.HANG_START === '1') break; // never resolves — test kills mid-start
      // WRITER_LOCK_FILE models Codex 0.153's per-thread writer lock: the process
      // that loads a thread holds it (the file exists) until it closes the thread.
      if (process.env.WRITER_LOCK_FILE) fs.writeFileSync(process.env.WRITER_LOCK_FILE, 't1');
      send({ id: m.id, result: { thread: { id: 't1' } } });
      break;
    case 'thread/resume': {
      const threadId = m.params?.threadId ?? 't1';
      if (process.env.RESUME_HANG === '1') break; // never resolves — test times out mid-start
      // RESUME_ERROR_FILE is read per request (the child's env is fixed at
      // spawn), so a test can clear the failure between activations.
      if (process.env.RESUME_ERROR_FILE && fs.existsSync(process.env.RESUME_ERROR_FILE)) {
        send({ id: m.id, error: { code: -32603, message: fs.readFileSync(process.env.RESUME_ERROR_FILE, 'utf8').trim() } });
        break;
      }
      if (process.env.COMPACT_MODE === 'stale') {
        send({ id: m.id, error: { code: -32602, message: 'thread not found' } });
      } else if (process.env.WRITER_LOCK_FILE && fs.existsSync(process.env.WRITER_LOCK_FILE)) {
        send({ id: m.id, error: { code: -32603, message: `thread ${threadId} already has an active writer` } });
      } else {
        if (process.env.WRITER_LOCK_FILE) fs.writeFileSync(process.env.WRITER_LOCK_FILE, threadId);
        send({ id: m.id, result: { thread: { id: threadId } } });
      }
      break;
    }
    case 'thread/close':
      if (process.env.WRITER_LOCK_FILE) fs.rmSync(process.env.WRITER_LOCK_FILE, { force: true });
      send({ id: m.id, result: {} });
      break;
    case 'thread/fork':
      // FORK_ERROR_MESSAGE models a fork the app-server cannot prepare (for
      // example a frozen paginated projection); the thread itself stays usable.
      if (process.env.FORK_ERROR_MESSAGE) {
        send({ id: m.id, error: { code: -32603, message: process.env.FORK_ERROR_MESSAGE } });
        break;
      }
      send({ id: m.id, result: { thread: { id: 't-forked' }, instructionSources: [] } });
      break;
    case 'thread/compact/start': {
      const threadId = m.params?.threadId ?? 't1';
      const turnId = 'native-compact-turn';
      activeTurnId = turnId;
      send({ id: m.id, result: {} });
      if (process.env.COMPACT_MODE === 'disconnect') {
        setTimeout(() => process.exit(2), 5);
        break;
      }
      send({
        method: 'turn/started',
        params: { threadId, turnId, turn: { id: turnId, status: 'inProgress', items: [], error: null } },
      });
      send({
        method: 'item/started',
        params: { threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' } },
      });
      if (process.env.COMPACT_MODE === 'hang') break;
      if (process.env.COMPACT_MODE === 'fail') {
        send({
          method: 'error',
          params: { threadId, turnId, error: { message: 'Native compaction failed safely' }, willRetry: false },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turnId,
            turn: { id: turnId, status: 'failed', error: { message: 'Native compaction failed safely' } },
          },
        });
        break;
      }
      send({
        method: 'item/completed',
        params: { threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' } },
      });
      completeTurn(threadId, turnId, 'completed');
      break;
    }
    case 'turn/start': {
      const threadId = m.params?.threadId ?? 't1';
      const previousTurnId = activeTurnId;
      const turnNumber = nextTurnNumber++;
      const turnId = `native-turn-${turnNumber}`;
      activeTurnId = turnId;
      const respondStarted = () => {
        send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
        if (turnNumber === 2 && process.env.EMIT_LATE_PRIOR_ON_SECOND_TURN === '1' && previousTurnId) {
          send({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId: previousTurnId, delta: 'stale-prior-turn' },
          });
          send({
            method: 'thread/tokenUsage/updated',
            params: { threadId, tokenUsage: { last: { inputTokens: 999_999, outputTokens: 999_999 } } },
          });
          completeTurn(threadId, previousTurnId, 'interrupted');
        }
      };
      if (process.env.COMPLETE_TURNS === '1') {
        // Plain turn that finishes on its own, for tests about thread lifecycle.
        respondStarted();
        completeTurn(threadId, turnId, 'completed');
        break;
      }
      if (process.env.EMIT_BROWSER_TOOL_CALL) {
        respondStarted();
        pendingServerRequestId = 'browser-request-1';
        pendingServerTurnId = turnId;
        send({
          id: pendingServerRequestId,
          method: 'item/tool/call',
          params: {
            threadId,
            turnId,
            callId: 'browser-call-1',
            tool: 'agent_browser',
            arguments: JSON.parse(process.env.EMIT_BROWSER_TOOL_CALL),
          },
        });
        break;
      }
      if (process.env.EMIT_USER_INPUT) {
        respondStarted();
        pendingServerRequestId = 'native-user-input-request';
        pendingServerTurnId = turnId;
        send({
          id: pendingServerRequestId,
          method: 'item/tool/requestUserInput',
          params: {
            threadId,
            turnId,
            itemId: 'native-user-input-item',
            isBlocking: true,
            autoResolutionMs: null,
            ...JSON.parse(process.env.EMIT_USER_INPUT),
          },
        });
        break;
      }
      if (process.env.EMIT_PERMISSION_APPROVAL === '1') {
        respondStarted();
        pendingServerRequestId = 'permission-1';
        pendingServerTurnId = turnId;
        send({
          id: pendingServerRequestId,
          method: 'item/permissions/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: 'mcp-call-1',
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: '/tmp',
            reason: 'NetSuite needs outbound network access.',
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ['/tmp/netsuite-input'],
                write: null,
                globScanMaxDepth: 2,
              },
            },
          },
        });
        break;
      }
      if (process.env.EMIT_UNKNOWN_REQUEST === '1') {
        respondStarted();
        pendingServerRequestId = 'future-1';
        pendingServerTurnId = turnId;
        send({
          id: pendingServerRequestId,
          method: 'item/future/requestApproval',
          params: {
            threadId,
            turnId,
            sensitivePayload: 'must not be logged',
          },
        });
        break;
      }
      if (process.env.EMIT_COLLAB_RUNNING === '1') {
        respondStarted();
        send({
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: {
              type: 'collabAgentToolCall',
              id: 'running-collab-secret',
              tool: 'spawnAgent',
              status: 'inProgress',
              receiverThreadIds: ['running-child-secret'],
              agentsStates: { 'running-child-secret': { status: 'running' } },
            },
          },
        });
        break;
      }
      if (process.env.EMIT_COLLAB_WAIT === '1') {
        respondStarted();
        const base = { threadId, turnId };
        if (process.env.EMIT_TOKEN_USAGE === '1') {
          send({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              tokenUsage: {
                total: {
                  inputTokens: 115_892,
                  cachedInputTokens: 30_464,
                  outputTokens: 1_122,
                  totalTokens: 117_014,
                },
                last: {
                  inputTokens: 31_892,
                  cachedInputTokens: 30_464,
                  outputTokens: 428,
                  totalTokens: 32_320,
                },
              },
            },
          });
          send({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              tokenUsage: {
                total: {
                  inputTokens: 153_960,
                  cachedInputTokens: 61_952,
                  outputTokens: 1_342,
                  totalTokens: 155_302,
                },
                last: {
                  inputTokens: 38_068,
                  cachedInputTokens: 31_488,
                  outputTokens: 220,
                  totalTokens: 38_288,
                },
              },
            },
          });
        }
        // A spawn only proves the child was launched…
        send({
          method: 'item/completed',
          params: {
            ...base,
            item: {
              type: 'collabAgentToolCall',
              id: 'wait-spawn-secret',
              tool: 'spawnAgent',
              status: 'completed',
              receiverThreadIds: ['waited-child-secret'],
              agentsStates: { 'waited-child-secret': { status: 'running' } },
            },
          },
        });
        // …a wait that learns nothing must stay silent…
        send({
          method: 'item/completed',
          params: {
            ...base,
            item: {
              type: 'collabAgentToolCall',
              id: 'wait-quiet-secret',
              tool: 'wait',
              status: 'completed',
              receiverThreadIds: ['waited-child-secret'],
              agentsStates: {},
            },
          },
        });
        // …and only the wait that carries a terminal status ends the child.
        send({
          method: 'item/completed',
          params: {
            ...base,
            item: {
              type: 'collabAgentToolCall',
              id: 'wait-done-secret',
              tool: 'wait',
              status: 'completed',
              receiverThreadIds: ['waited-child-secret'],
              agentsStates: { 'waited-child-secret': { status: 'completed', message: 'raw child result' } },
            },
          },
        });
        completeTurn(threadId, turnId, 'completed');
        break;
      }
      if (process.env.EMIT_COLLAB_EVENTS === '1') {
        respondStarted();
        const base = { threadId, turnId };
        send({
          method: 'item/started',
          params: {
            ...base,
            item: {
              type: 'collabAgentToolCall',
              id: 'collab-call-secret',
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: 'parent-thread-secret',
              receiverThreadIds: ['child-thread-secret', 'queued-thread-secret', 'stopped-thread-secret', 'failed-thread-secret'],
              prompt: 'raw child prompt must stay private',
              model: 'gpt-5.6-sol',
              reasoningEffort: 'medium',
              agentsStates: {
                'child-thread-secret': { status: 'running' },
                'queued-thread-secret': { status: 'pendingInit' },
                'stopped-thread-secret': { status: 'running' },
                'failed-thread-secret': { status: 'running' },
              },
            },
          },
        });
        send({
          method: 'item/started',
          params: {
            threadId: 'child-thread-secret',
            turnId: 'child-turn-secret',
            item: {
              id: 'child-command-secret',
              type: 'commandExecution',
              command: 'npm test -- raw-private-suite',
              status: 'inProgress',
            },
          },
        });
        send({
          method: 'item/completed',
          params: {
            threadId: 'child-thread-secret',
            turnId: 'child-turn-secret',
            item: {
              id: 'child-command-secret',
              type: 'commandExecution',
              command: 'npm test -- raw-private-suite',
              aggregatedOutput: 'raw private passing test log',
              exitCode: 0,
              status: 'completed',
            },
          },
        });
        send({
          method: 'item/completed',
          params: {
            threadId: 'child-thread-secret',
            turnId: 'child-turn-secret',
            item: {
              id: 'child-file-secret',
              type: 'fileChange',
              status: 'completed',
              changes: [{
                path: '/private/client/Chat.tsx',
                diff: '--- a/private\n+++ b/private\n-old private line\n+new private line\n+another private line',
              }],
            },
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: 'child-thread-secret',
            turnId: 'child-turn-secret',
            turn: { id: 'child-turn-secret', status: 'completed', error: null },
          },
        });
        send({
          method: 'item/started',
          params: {
            ...base,
            item: {
              type: 'subAgentActivity',
              id: 'activity-secret',
              kind: 'spawned',
              agentThreadId: 'child-thread-secret',
              agentPath: '/root/ui_review',
            },
          },
        });
        send({
          method: 'item/completed',
          params: {
            ...base,
            item: {
              type: 'subAgentActivity',
              id: 'activity-secret',
              kind: 'spawned',
              agentThreadId: 'child-thread-secret',
              agentPath: '/root/ui_review',
            },
          },
        });
        send({
          method: 'item/completed',
          params: {
            ...base,
            item: {
              type: 'collabAgentToolCall',
              id: 'collab-call-secret',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: 'parent-thread-secret',
              receiverThreadIds: ['child-thread-secret', 'queued-thread-secret', 'stopped-thread-secret', 'failed-thread-secret'],
              prompt: 'raw child prompt must stay private',
              model: 'gpt-5.6-sol',
              reasoningEffort: 'medium',
              agentsStates: {
                'child-thread-secret': { status: 'completed', message: 'raw child result' },
                'queued-thread-secret': { status: 'completed' },
                'stopped-thread-secret': { status: 'interrupted' },
                'failed-thread-secret': { status: 'errored' },
              },
            },
          },
        });
        completeTurn(threadId, turnId, 'completed');
        break;
      }
      respondStarted();
      break; // active turn: no completion until interrupt
    }
    case 'turn/steer':
      send({ id: m.id, result: { turnId: m.params?.expectedTurnId ?? 'native-turn-1' } });
      break;
    case 'turn/interrupt':
      send({ id: m.id, result: {} });
      interruptCount += 1;
      if (process.env.OMIT_INTERRUPT_COMPLETION === '1') break;
      if (process.env.OMIT_FIRST_INTERRUPT_COMPLETION === '1' && interruptCount === 1) break;
      sendInterruptCompletion(m.params?.threadId ?? 't1', m.params?.turnId ?? activeTurnId);
      break;
    default:
      if (m.id !== undefined) send({ id: m.id, result: {} });
      break;
  }
});
