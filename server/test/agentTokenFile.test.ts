import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentTokenFilePath,
  readCurrentAgentToken,
  resolveCurrentAgentToken,
  writeCurrentAgentToken,
} from '../src/runtime/agentTokenFile.js';

describe('current agent token indirection', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a persisted MCP process use the newest token for its conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-agent-token-'));
    dirs.push(dir);
    const conversationId = 'conversation-123';
    const file = writeCurrentAgentToken(conversationId, 'fresh-token', dir);

    expect(file).toBe(agentTokenFilePath(conversationId, dir));
    expect(readCurrentAgentToken(conversationId, file!)).toBe('fresh-token');
    expect(resolveCurrentAgentToken('expired-cached-token', conversationId, file!)).toBe('fresh-token');
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });

  it('falls back to the environment token when no refresh file exists', () => {
    const missing = path.join(os.tmpdir(), `vp-agent-token-missing-${process.pid}`);
    expect(resolveCurrentAgentToken('environment-token', 'conversation-456', missing)).toBe('environment-token');
  });

  it('rejects conversation ids that could escape the token directory', () => {
    expect(agentTokenFilePath('../outside', '/tmp/tokens')).toBeNull();
  });
});
