import type { ProjectFileLocation } from './projectFilesRoute';

export interface ProjectFileLinkIntent {
  target: string;
  explicit: boolean;
}

const LOCATION_RE = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/i;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const SPECIAL_PATH_RE = /^\/(?:api|desktop|p|tools)(?:\/|$)/;
const EXPLICIT_ABSOLUTE_RE = /^\/(?:Users|home|root|tmp|private|var|opt|srv|mnt|data|workspaces?)(?:\/|$)/;

/** Decide which ordinary markdown links are worth resolving as project files. */
export function projectFileLinkIntent(rawHref: string): ProjectFileLinkIntent | null {
  const target = rawHref.trim();
  if (!target || target.startsWith('#') || SPECIAL_PATH_RE.test(target)) return null;
  const withoutLocation = target.replace(LOCATION_RE, '');
  if (SCHEME_RE.test(withoutLocation) && !withoutLocation.startsWith('file:')) return null;
  const lastPart = withoutLocation.split('/').pop() ?? '';
  const explicit =
    withoutLocation.startsWith('file:') ||
    EXPLICIT_ABSOLUTE_RE.test(withoutLocation) ||
    withoutLocation.startsWith('./') ||
    withoutLocation.startsWith('../') ||
    withoutLocation.startsWith('~/') ||
    LOCATION_RE.test(target) ||
    /\.[a-z\d][a-z\d._-]*$/i.test(lastPart);
  return { target, explicit };
}

export function parentTreePaths(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < parts.length; i += 1) parents.push(`${parts.slice(0, i).join('/')}/`);
  return parents;
}

export function textSelectionForLocation(
  content: string,
  location: Pick<ProjectFileLocation, 'line' | 'column'>,
): { start: number; end: number; lineIndex: number } | null {
  if (!location.line) return null;
  const lines = content.split('\n');
  const lineIndex = Math.min(location.line - 1, Math.max(lines.length - 1, 0));
  let lineStart = 0;
  for (let i = 0; i < lineIndex; i += 1) lineStart += lines[i]!.length + 1;
  const lineLength = lines[lineIndex]?.replace(/\r$/, '').length ?? 0;
  if (location.column) {
    const caret = lineStart + Math.min(location.column - 1, lineLength);
    return { start: caret, end: caret, lineIndex };
  }
  return { start: lineStart, end: lineStart + lineLength, lineIndex };
}
