import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs operator script, no types
import {
  DEVELOPER_ASSISTANT,
  claudeProjectKeyForCwd,
  planChats,
  projectSlugFrom,
  selectAgents,
} from '../../scripts/migrate-core-project.mjs';
import { claudeProjectKeyForCwd as serverKey } from '../src/providers/claude/transcript.js';

const CORE_PROJECT = { id: 'crew-seating', name: 'Crew Seating', path: '/Users/you/Developer/Crew Seating/crew_monorepo' };
const KEY = '-Users-you-Developer-Crew-Seating-crew-monorepo';

const AGENTS = [
  { id: 'p__claude-full-1', agentId: 'claude-full-1', name: 'Prioritized Codebase Issue Audit', autoNaming: false, type: 'claude' },
  { id: 'p__claude-full-2', agentId: 'claude-full-2', name: 'Nesting Optimization Deep Dive', autoNaming: false, type: 'claude' },
  { id: 'p__claude-full-3', agentId: 'claude-full-3', name: 'Claude 4', autoNaming: true, type: 'claude' },
  { id: 'p__codex-1', agentId: 'codex-1', name: 'Codex Sweep', autoNaming: false, type: 'codex' },
  { id: 'p__claude-full-4', agentId: 'claude-full-4', name: 'Already Migrated', autoNaming: false, type: 'claude' },
  { id: 'p__claude-full-5', agentId: 'claude-full-5', name: 'Ghost Session', autoNaming: false, type: 'claude' },
];

const DETAILS = new Map<string, unknown>([
  ['p__claude-full-1', { sessionId: 'sess-1', model: 'claude-fable-5', modelSelection: { reasoningEffort: 'high' } }],
  ['p__claude-full-2', { sessionId: 'sess-2', model: 'claude-fable-5[1m]', modelSelection: { reasoningEffort: 'xhigh' } }],
  ['p__claude-full-3', { sessionId: 'sess-3', model: 'claude-fable-5', modelSelection: { reasoningEffort: 'high' } }],
  ['p__codex-1', { sessionId: 'sess-4', model: 'gpt-5.6-sol', modelSelection: { reasoningEffort: 'high' } }],
  ['p__claude-full-4', { sessionId: 'sess-taken', model: 'claude-opus-4-8', modelSelection: { reasoningEffort: 'high' } }],
  ['p__claude-full-5', { sessionId: 'sess-missing', model: 'claude-opus-4-8', modelSelection: { reasoningEffort: 'high' } }],
]);

const ON_DISK = new Set(['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-taken']);
const sessionStat = (key: string, sessionId: string) =>
  key === KEY && ON_DISK.has(sessionId)
    ? { bytes: 2048, createdAt: '2026-07-03 11:13:24', lastActiveAt: '2026-07-04 18:02:11' }
    : null;

function plan(selector = 'all-named') {
  return planChats({
    coreProject: CORE_PROJECT,
    agents: selectAgents(AGENTS, selector),
    details: DETAILS,
    existingSessionIds: new Set(['sess-taken']),
    sessionStat,
  }) as { title: string; status: string; model: string | null; effort: string | null; sessionId: string | null }[];
}

describe('migrate-core-project', () => {
  it('derives the same project key as the server does', () => {
    // The adoption is worthless if this ever drifts from transcript.ts: the key
    // is the only thing tying a Pro conversation to Core's session file.
    for (const cwd of [CORE_PROJECT.path, '/Users/you/Developer/acme/veneer-pro', '/tmp/a b/c.d']) {
      expect(claudeProjectKeyForCwd(cwd)).toBe(serverKey(cwd));
    }
    expect(claudeProjectKeyForCwd(CORE_PROJECT.path)).toBe(KEY);
  });

  it('adopts only the named agents by default', () => {
    const titles = plan().map((chat) => chat.title);
    expect(titles).not.toContain('Claude 4'); // autoNaming: a throwaway session
    expect(titles).toContain('Prioritized Codebase Issue Audit');
    expect(titles).toHaveLength(5);
  });

  it('selects explicit agents by either id form and rejects unknown ones', () => {
    expect(selectAgents(AGENTS, 'claude-full-1,p__claude-full-2').map((a: { id: string }) => a.id)).toEqual([
      'p__claude-full-1',
      'p__claude-full-2',
    ]);
    expect(() => selectAgents(AGENTS, 'claude-full-9')).toThrow(/claude-full-9/);
  });

  it('classifies every chat and only plans the adoptable ones', () => {
    const byTitle = Object.fromEntries(plan().map((chat) => [chat.title, chat]));

    expect(byTitle['Prioritized Codebase Issue Audit'].status).toBe('adopt');
    // Already pointed at by a Pro conversation — a re-run must not duplicate it.
    expect(byTitle['Already Migrated'].status).toBe('already-in-pro');
    // Core names a session that isn't under this project's transcript key.
    expect(byTitle['Ghost Session'].status).toBe('no-transcript');
    // Codex history lives in Pro's own shadow transcripts, not ~/.claude.
    expect(byTitle['Codex Sweep'].status).toBe('unsupported');
  });

  it('carries the model verbatim, including the 1M-context suffix', () => {
    // Stripping "[1m]" would resume a 1M-window session inside a 200k window.
    const chat = plan().find((c) => c.title === 'Nesting Optimization Deep Dive')!;
    expect(chat.model).toBe('claude-fable-5[1m]');
    expect(chat.effort).toBe('xhigh');
  });

  it('slugifies a project name and avoids collisions', () => {
    expect(projectSlugFrom('Crew Seating')).toBe('crew-seating');
    expect(projectSlugFrom('Crew Seating', new Set(['crew-seating']))).toBe('crew-seating-2');
    expect(projectSlugFrom('!!!')).toBe('project');
  });

  it('gives the developer persona a real shell', () => {
    // Core's "full" agents ran with a shell; an adopted chat that cannot run
    // Bash is a silent downgrade of every session it inherits.
    expect(DEVELOPER_ASSISTANT.full_access).toBe(1);
    expect(DEVELOPER_ASSISTANT.slug).not.toBe('platform-dev');
  });
});
