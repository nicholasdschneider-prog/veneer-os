#!/usr/bin/env node
// Fake claude CLI for adapter tests: speaks just enough of the verified
// stream-json wire protocol (docs/protocol-notes.md) to exercise the approval
// round trip. Modes via FAKE_CLAUDE_MODE: 'approval' (default) emits a
// control_request and waits for the control_response; 'plain' answers text;
// 'steer' echoes an injected user line at once, 'steer-delayed-echo' after 300ms;
// 'poll-loop' polls a wait tool forever; 'slow-tool' blocks on one real tool.
import readline from 'node:readline';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'approval';
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const TOOL_INPUT = { file_path: '/outside/probe.txt', content: 'hello' };

if (mode === 'interrupt-error-result') {
  process.on('SIGTERM', () => {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Turn failed (error_during_execution)',
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    setTimeout(() => process.exit(0), 10);
  });
}

// Models the worst case for a steered line: the CLI echoes it while the process
// is already being torn down, so the echo must not count as delivery.
if (mode === 'steer-echo-after-kill') {
  process.on('SIGTERM', () => undefined);
}

if (process.argv.includes('/compact')) {
  if (process.env.FAKE_CLAUDE_ARG_LOG) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.FAKE_CLAUDE_ARG_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
  }
  if (mode === 'compact-hang') {
    setInterval(() => undefined, 1_000);
  } else if (mode === 'compact-empty') {
    const message = 'Error: No messages to compact';
    out({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: message }] },
      parent_tool_use_id: null,
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: message, usage: { input_tokens: 0, output_tokens: 0 } });
    setTimeout(() => process.exit(0), 5);
  } else if (mode === 'compact-insufficient-history') {
    const message = process.env.FAKE_CLAUDE_COMPACT_MESSAGE ?? 'Not enough messages to compact.';
    // Exact stream observed from Claude Code during live provider verification:
    // a native boundary plus synthetic warning and a nominal success result.
    out({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'fake-session',
      compact_metadata: { trigger: 'manual', pre_tokens: 33190 },
    });
    out({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: message }],
      },
      parent_tool_use_id: null,
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 0, output_tokens: 0 } });
    setTimeout(() => process.exit(0), 5);
  } else if (mode === 'compact-stale') {
    const message = 'No conversation found with session ID: stale-session';
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: null,
      errors: [message],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    setTimeout(() => process.exit(1), 5);
  } else if (mode === 'compact-ordinary') {
    out({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Ordinary model reply' }] },
      parent_tool_use_id: null,
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Ordinary model reply' });
    setTimeout(() => process.exit(0), 5);
  } else {
    out({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'fake-session',
      compact_metadata: { trigger: 'manual', pre_tokens: 100000 },
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Compacted', usage: { input_tokens: 0, output_tokens: 0 } });
    setTimeout(() => process.exit(0), 5);
  }
} else if (mode === 'spawn-env') {
  // Reports the environment and permission flags the adapter actually spawned
  // with, so the machine-access tests can prove them end to end.
  const summary = {
    home: process.env.HOME,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
    serviceHome: process.env.VP_SERVICE_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
    ghConfigDir: process.env.GH_CONFIG_DIR ?? null,
    nmSearchTokenPresent: Boolean(process.env.NM_SEARCH_API_TOKEN),
    disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
    args: process.argv.slice(2),
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', () => {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(summary) }] },
      parent_tool_use_id: null,
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'openrouter-env') {
  const modelAt = process.argv.indexOf('--model');
  const model = modelAt >= 0 ? process.argv[modelAt + 1] : null;
  const effortAt = process.argv.indexOf('--effort');
  const effort = effortAt >= 0 ? process.argv[effortAt + 1] : null;
  const disallowedAt = process.argv.indexOf('--disallowedTools');
  const summary = {
    model,
    effort,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    authMatchesExpected: process.env.ANTHROPIC_AUTH_TOKEN === process.env.FAKE_EXPECT_OPENROUTER_KEY,
    apiKeyBlank: process.env.ANTHROPIC_API_KEY === '',
    oauthAbsent: !process.env.CLAUDE_CODE_OAUTH_TOKEN,
    roleModelsPinned:
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL === model &&
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL === model &&
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === model &&
      process.env.CLAUDE_CODE_SUBAGENT_MODEL === model,
    nmSearchTokenPresent: Boolean(process.env.NM_SEARCH_API_TOKEN),
    disallowedTools: disallowedAt >= 0 ? process.argv[disallowedAt + 1]?.split(',') : [],
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', () => {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(summary) }] },
      parent_tool_use_id: null,
    });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'session-limit' || mode === 'plain-failure') {
  // Subscription limit as Claude Code actually reports it: a synthetic
  // assistant message carrying the 429, then a failed result. 'plain-failure'
  // is the same failed turn WITHOUT the limit metadata (no failover).
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', () => {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    if (mode === 'session-limit') {
      out({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 1, status: 'rejected' } });
    }
    out({
      type: 'assistant',
      // Real stream shape (CLI 2.1.257): only isApiErrorMessage on stdout; the
      // 429 status / error code exist solely in the on-disk session file.
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{
          type: 'text',
          text: mode === 'session-limit'
            ? "You've hit your session limit \u00b7 resets 6:50pm (America/Indianapolis)"
            : 'Something else went wrong',
        }],
      },
      parent_tool_use_id: null,
    });
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Turn failed',
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  });
  process.stdin.on('end', () => process.exit(0));
} else {

const rl = readline.createInterface({ input: process.stdin });
let userMessages = 0;
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
    if (mode === 'interrupt-error-result') return;
    // The real CLI only replays an injected user line after its current tool
    // call finishes; this mode models that lag.
    if (mode === 'steer-delayed-echo') {
      userMessages += 1;
      if (userMessages < 2) return;
      setTimeout(() => {
        out({ type: 'user', message: msg.message, parent_tool_use_id: null });
        out({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'followed the delayed steering message' }] },
          parent_tool_use_id: null,
        });
        out({ type: 'result', subtype: 'success', is_error: false, result: 'steered', usage: { input_tokens: 1, output_tokens: 1 } });
      }, 300);
      return;
    }
    if (mode === 'steer-echo-after-kill') {
      userMessages += 1;
      if (userMessages < 2) return;
      setTimeout(() => {
        out({ type: 'user', message: msg.message, parent_tool_use_id: null });
        out({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'stopped',
          usage: { input_tokens: 1, output_tokens: 0 },
        });
        setTimeout(() => process.exit(0), 10);
      }, 100);
      return;
    }
    if (mode === 'steer') {
      userMessages += 1;
      out({ type: 'user', message: msg.message, parent_tool_use_id: null });
      if (userMessages < 2) return;
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'followed the steering message' }] },
        parent_tool_use_id: null,
      });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'steered', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    if (mode === 'plain') {
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] },
        parent_tool_use_id: null,
      });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'plain reply', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    if (mode === 'token-usage') {
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'usage reply' }],
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 10,
            output_tokens: 3,
          },
        },
        parent_tool_use_id: null,
      });
      out({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'usage reply',
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 30,
          output_tokens: 12,
        },
      });
      return;
    }
    if (mode === 'stream-only') {
      out({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed ' } },
        parent_tool_use_id: null,
      });
      out({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
        parent_tool_use_id: null,
      });
      // OpenRouter sometimes omits the normal assistant envelope here.
      out({ type: 'result', subtype: 'success', is_error: false, result: 'streamed reply', usage: { input_tokens: 1, output_tokens: 2 } });
      return;
    }
    if (mode === 'rate-limit') {
      const message = "You've hit your session limit · resets 2:30am (UTC)";
      out({
        type: 'assistant',
        error: 'rate_limit',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: message }] },
        parent_tool_use_id: null,
      });
      out({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: message,
        usage: { input_tokens: 1, output_tokens: 0 },
      });
      return;
    }
    if (mode === 'argv') {
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] },
        parent_tool_use_id: null,
      });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'argv', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    if (mode === 'poll-loop') {
      // A wedged turn that keeps polling: tool traffic forever, progress never.
      let n = 0;
      setInterval(() => {
        const id = `toolu_poll_${n++}`;
        out({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__agents__wait', input: {} }] },
          parent_tool_use_id: null,
        });
        out({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'still running' }] },
          parent_tool_use_id: null,
        });
      }, 25);
      return;
    }
    if (mode === 'slow-tool') {
      // One genuine tool call that takes far longer than the idle budget and
      // never reports back: legitimately blocked, not wedged.
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: { command: 'npm run build' } }],
        },
        parent_tool_use_id: null,
      });
      setInterval(() => undefined, 1_000);
      return;
    }
    if (mode === 'subagent' || mode === 'subagent-running') {
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_agent_private',
            name: 'Agent',
            input: {
              description: 'Review the transcript UI',
              subagent_type: 'Explore',
              model: 'claude-sonnet-5',
              prompt: 'raw delegated prompt must stay private',
            },
          }],
        },
        parent_tool_use_id: null,
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_private', content: 'Async agent launched successfully' }],
        },
        toolUseResult: { status: 'async_launched', description: 'Review the transcript UI', resolvedModel: 'claude-sonnet-5' },
        parent_tool_use_id: null,
      });
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'child-edit-private',
            name: 'Edit',
            input: {
              file_path: '/private/client/transcript.tsx',
              old_string: 'const state = oldState;\n',
              new_string: 'const state = newState;\nconst live = true;\n',
            },
          }],
        },
        parent_tool_use_id: 'toolu_agent_private',
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'child-edit-private', content: 'raw edit result' }],
        },
        parent_tool_use_id: 'toolu_agent_private',
      });
      out({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'child-test-private',
            name: 'Bash',
            input: { command: 'npm test -- private-suite-name' },
          }],
        },
        parent_tool_use_id: 'toolu_agent_private',
      });
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'child-test-private', content: 'raw test log: private' }],
        },
        toolUseResult: { exitCode: 0 },
        parent_tool_use_id: 'toolu_agent_private',
      });
      if (mode === 'subagent-running') return;
      out({
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification><tool-use-id>toolu_agent_private</tool-use-id><status>completed</status><summary>raw child output</summary></task-notification>',
        },
        parent_tool_use_id: null,
      });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } });
      return;
    }
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: TOOL_INPUT }] },
      parent_tool_use_id: null,
    });
    out({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input: TOOL_INPUT, tool_use_id: 'toolu_1' },
    });
    return;
  }

  if (msg.type === 'control_response') {
    const decision = msg.response?.response;
    if (decision?.behavior === 'allow') {
      out({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'File created' }] },
        parent_tool_use_id: null,
      });
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done (allowed)' }] },
        parent_tool_use_id: null,
      });
    } else {
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: decision?.message ?? 'denied', is_error: true }],
        },
        parent_tool_use_id: null,
      });
      out({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok, skipped (denied)' }] },
        parent_tool_use_id: null,
      });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});

process.stdin.on('end', () => process.exit(0));
}
