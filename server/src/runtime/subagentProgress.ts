/** Provider payloads are inspected only long enough to derive these generic
 * labels and counts. Raw commands, paths, diffs, and results are never returned. */

const TEST_COMMAND_RE = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[\s;&|])(?:vitest|jest|pytest|cargo\s+test|go\s+test|node\s+--test)\b/i;
const BUILD_COMMAND_RE = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|(?:^|[\s;&|])(?:tsc|vite\s+build|next\s+build|cargo\s+build)\b/i;

export type SafeCommandKind = 'test' | 'build' | 'command';

export function safeCommandKind(command: unknown): SafeCommandKind {
  const text = typeof command === 'string' ? command : '';
  if (TEST_COMMAND_RE.test(text)) return 'test';
  if (BUILD_COMMAND_RE.test(text)) return 'build';
  return 'command';
}

export function safeCommandAction(kind: SafeCommandKind): string {
  if (kind === 'test') return 'Running tests';
  if (kind === 'build') return 'Building';
  return 'Running a command';
}

export function safeToolAction(toolName: unknown, input?: unknown): { action: string; commandKind?: SafeCommandKind } {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (name === 'bash' || name === 'shell' || name === 'commandexecution') {
    const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : input;
    const commandKind = safeCommandKind(command);
    return { action: safeCommandAction(commandKind), commandKind };
  }
  if (name === 'read') return { action: 'Reading a file' };
  if (name === 'edit' || name === 'write' || name === 'multiedit' || name === 'notebookedit' || name === 'filechange') {
    return { action: 'Editing files' };
  }
  if (name === 'grep' || name === 'glob' || name === 'search' || name === 'codesearch') return { action: 'Searching code' };
  if (name === 'websearch' || name === 'web_search') return { action: 'Searching the web' };
  if (name === 'webfetch' || name === 'web_fetch') return { action: 'Reading a webpage' };
  if (name === 'imageview' || name === 'view_image') return { action: 'Viewing an image' };
  if (name === 'agent' || name === 'task') return { action: 'Delegating work' };
  if (name === 'reasoning' || name === 'plan') return { action: 'Planning' };
  if (name === 'mcptoolcall' || name.startsWith('mcp__')) return { action: 'Using a connection' };
  return { action: 'Working' };
}

function lines(value: string): string[] {
  return value ? value.replace(/\r\n/g, '\n').split('\n') : [];
}

/** Approximate the changed region in an Edit payload while excluding shared
 * context at the start and end. Final provider totals replace these live counts. */
export function changedLineCounts(before: unknown, after: unknown): { added: number; removed: number } {
  if (typeof before !== 'string' || typeof after !== 'string') return { added: 0, removed: 0 };
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { added: newEnd - start, removed: oldEnd - start };
}

export function diffLineCounts(diff: unknown): { added: number; removed: number } {
  if (typeof diff !== 'string') return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export function safeTerminalAction(status: 'completed' | 'stopped' | 'failed'): string {
  if (status === 'completed') return 'Finished';
  if (status === 'stopped') return 'Stopped';
  return 'Failed';
}
