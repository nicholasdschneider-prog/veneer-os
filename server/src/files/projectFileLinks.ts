import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProjectFileLinkFailure = 'invalid' | 'missing' | 'outside' | 'not-file';

export type ProjectFileLinkKind = 'file' | 'directory';

export type ProjectFileLinkResult =
  | {
      ok: true;
      kind: ProjectFileLinkKind;
      path: string;
      absolutePath: string;
      line: number | null;
      column: number | null;
    }
  | { ok: false; reason: ProjectFileLinkFailure };

interface ParsedTarget {
  path: string;
  line: number | null;
  column: number | null;
}

const HASH_LOCATION_RE = /#L(\d+)(?:C(\d+))?$/i;
const COLON_LOCATION_RE = /:(\d+)(?::(\d+))?$/;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Parse the file-link forms agents commonly emit, including editor locations. */
export function parseProjectFileLinkTarget(rawTarget: string): ParsedTarget | null {
  let target = rawTarget.trim();
  if (!target || target.includes('\0') || target.length > 8_192) return null;

  let line: number | null = null;
  let column: number | null = null;
  const hashLocation = HASH_LOCATION_RE.exec(target);
  if (hashLocation) {
    line = positiveInteger(hashLocation[1]);
    column = positiveInteger(hashLocation[2]);
    if (!line) return null;
    target = target.slice(0, hashLocation.index);
  } else {
    const colonLocation = COLON_LOCATION_RE.exec(target);
    if (colonLocation) {
      line = positiveInteger(colonLocation[1]);
      column = positiveInteger(colonLocation[2]);
      if (!line) return null;
      target = target.slice(0, colonLocation.index);
    }
  }

  if (!target || target.includes('#') || target.includes('?')) return null;
  try {
    if (target.startsWith('file:')) {
      const url = new URL(target);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
      target = fileURLToPath(url);
    } else {
      if (SCHEME_RE.test(target)) return null;
      target = decodeURIComponent(target);
    }
  } catch {
    return null;
  }
  if (!target || target.includes('\0')) return null;
  return { path: target, line, column };
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** Resolve a link against one project and refuse files reached outside it. */
export function resolveProjectFileLink(rootPath: string, rawTarget: string): ProjectFileLinkResult {
  const parsed = parseProjectFileLinkTarget(rawTarget);
  if (!parsed) return { ok: false, reason: 'invalid' };

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  const candidate = path.isAbsolute(parsed.path)
    ? path.resolve(parsed.path)
    : path.resolve(rootPath, parsed.path);

  // Relative traversal is rejected before touching the target. Absolute paths
  // are checked after realpath so a custom project root may itself be a symlink.
  if (!path.isAbsolute(parsed.path) && !isInside(path.resolve(rootPath), candidate)) {
    return { ok: false, reason: 'outside' };
  }

  let targetReal: string;
  let stat: fs.Stats;
  try {
    targetReal = fs.realpathSync(candidate);
    stat = fs.statSync(targetReal);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isInside(rootReal, targetReal)) return { ok: false, reason: 'outside' };
  const kind: ProjectFileLinkKind | null = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
  if (!kind) return { ok: false, reason: 'not-file' };

  return {
    ok: true,
    kind,
    path: path.relative(rootReal, targetReal).split(path.sep).join('/'),
    absolutePath: targetReal,
    line: parsed.line,
    column: parsed.column,
  };
}
