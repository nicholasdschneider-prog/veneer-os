import { describe, expect, it } from 'vitest';
import {
  changedLineCounts,
  diffLineCounts,
  safeCommandKind,
  safeToolAction,
} from '../src/runtime/subagentProgress.js';

describe('safe sub-agent progress normalization', () => {
  it('classifies commands without returning their text', () => {
    expect(safeCommandKind('npm test -- secret-suite')).toBe('test');
    expect(safeCommandKind('pnpm run build --private-flag')).toBe('build');
    expect(safeToolAction('Bash', { command: 'curl https://private.example' })).toEqual({
      action: 'Running a command',
      commandKind: 'command',
    });
    expect(JSON.stringify(safeToolAction('Bash', { command: 'npm test -- secret-suite' })))
      .not.toContain('secret-suite');
  });

  it('counts changed lines while retaining no source text', () => {
    expect(changedLineCounts('shared\nold\ntail', 'shared\nnew\nextra\ntail')).toEqual({ added: 2, removed: 1 });
    expect(diffLineCounts('--- a/private\n+++ b/private\n-old\n+new\n+extra')).toEqual({ added: 2, removed: 1 });
  });
});
