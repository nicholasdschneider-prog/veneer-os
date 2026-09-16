import os from 'node:os';
import path from 'node:path';
import { MAX_BASH_RESULT_FILES, WRITE_EXTS, boundedResultText, fileCandidates, hasWatchedFileSignal } from '../fileScan.js';
import type { CreatedFileRef } from '../types.js';
import { readClaudeSessionTail } from './transcript.js';

/**
 * Detect deliverable data files (CSV etc.) the agent created during a session
 * by scanning the native session JSONL for Write tool calls (exact file_path),
 * Bash commands that mention a watched file type, and successful results from
 * those Bash calls. The result scan matters when a command constructs the real
 * name dynamically (`"$out.pdf"`) or changes directory before writing it.
 * Sidechain (subagent) rows are scanned on purpose — a file a subagent writes
 * is still a session deliverable. This module only reports candidate paths
 * named by the transcript; the caller verifies they exist before exposing them.
 * The extraction primitives (watched extensions, candidate regexes) live in
 * ../fileScan.ts, shared with the Codex adapter's live capture.
 */

const MAX_SCAN_BYTES = 16 * 1024 * 1024;

interface ToolUseBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: { file_path?: unknown; command?: unknown };
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SessionRow {
  type?: string;
  cwd?: unknown;
  message?: { content?: unknown };
  toolUseResult?: {
    stdout?: unknown;
    interrupted?: unknown;
    status?: unknown;
    exitCode?: unknown;
    exit_code?: unknown;
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function successfulBashResult(row: SessionRow, block: ToolResultBlock): boolean {
  if (block.is_error === true || row.toolUseResult?.interrupted === true) return false;
  const exitCode = row.toolUseResult?.exitCode ?? row.toolUseResult?.exit_code;
  if (typeof exitCode === 'number' && exitCode !== 0) return false;
  if (
    typeof row.toolUseResult?.status === 'string' &&
    /^(?:fail|error|interrupt|timed?[_ -]?out|cancel)/i.test(row.toolUseResult.status)
  ) {
    return false;
  }
  // Real Claude Bash result rows normally omit an explicit success status and
  // use `is_error: false`, so absence of a status/exit code is success.
  return true;
}

export function collectSessionFileRefs(content: string, cwd: string, home = os.homedir()): CreatedFileRef[] {
  // path → detection source; 'write' (exact) always wins over 'bash' (heuristic).
  const bySource = new Map<string, 'write' | 'bash'>();
  const absolute = (p: string, base = cwd): string => (p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(base, p));
  const rows: SessionRow[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: SessionRow;
    try {
      row = JSON.parse(line) as SessionRow;
    } catch {
      continue;
    }
    if (row && typeof row === 'object') rows.push(row);
  }

  // tool id → whether this is an unambiguous Bash call with a watched file
  // signal. Strict linkage prevents output from `ls`/`find`/unrelated tools
  // from being treated as provenance merely because it names a PDF.
  const toolKinds = new Map<string, 'bash-producer' | 'other' | 'ambiguous'>();
  const rememberTool = (id: string, kind: 'bash-producer' | 'other'): void => {
    const prior = toolKinds.get(id);
    if (!prior) toolKinds.set(id, kind);
    else if (prior !== kind) toolKinds.set(id, 'ambiguous');
  };

  for (const row of rows) {
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
    const rowCwd = typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : cwd;
    for (const block of row.message.content as ToolUseBlock[]) {
      if (block?.type !== 'tool_use') continue;
      if (block.name === 'Write' && typeof block.input?.file_path === 'string') {
        const file = block.input.file_path;
        if (WRITE_EXTS.has(path.extname(file).toLowerCase())) bySource.set(absolute(file, rowCwd), 'write');
      } else if (block.name === 'Bash' && typeof block.input?.command === 'string') {
        const candidates = fileCandidates(block.input.command);
        if (block.id) rememberTool(block.id, hasWatchedFileSignal(block.input.command) ? 'bash-producer' : 'other');
        for (const candidate of candidates) {
          const abs = absolute(candidate, rowCwd);
          if (!bySource.has(abs)) bySource.set(abs, 'bash');
        }
      } else if (block.id) {
        rememberTool(block.id, 'other');
      }
    }
  }

  // Tool use and result rows can be interleaved by sidechains. Because the
  // first pass collected every id, this remains correct even if a persisted
  // result happens to precede its assistant row.
  for (const row of rows) {
    if (row.type !== 'user' || !Array.isArray(row.message?.content)) continue;
    const rowCwd = typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : cwd;
    for (const block of row.message.content as ToolResultBlock[]) {
      if (
        block?.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string' ||
        toolKinds.get(block.tool_use_id) !== 'bash-producer' ||
        !successfulBashResult(row, block)
      ) {
        continue;
      }
      const stdout = row.toolUseResult?.stdout;
      const raw = typeof stdout === 'string' && stdout ? stdout : toolResultText(block.content);
      if (!raw) continue;
      for (const candidate of fileCandidates(boundedResultText(raw), MAX_BASH_RESULT_FILES)) {
        const abs = absolute(candidate, rowCwd);
        if (!bySource.has(abs)) bySource.set(abs, 'bash');
      }
    }
  }
  return [...bySource].map(([p, source]) => ({ path: p, source }));
}

export async function collectClaudeSessionFiles(cwd: string, sessionId: string, configDir?: string): Promise<CreatedFileRef[]> {
  if (!cwd || !sessionId) return [];
  const content = await readClaudeSessionTail(cwd, sessionId, MAX_SCAN_BYTES, configDir);
  if (!content) return [];
  return collectSessionFileRefs(content, cwd);
}
