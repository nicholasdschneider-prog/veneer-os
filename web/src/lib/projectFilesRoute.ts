export interface ProjectFileLocation {
  path: string;
  line?: number;
  column?: number;
  /** Folders are revealed in the tree only; files also open in the editor. */
  kind?: 'directory';
}

const positiveInteger = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export function projectFileLocationFromParams(params: URLSearchParams): ProjectFileLocation | null {
  const filePath = params.get('file');
  if (
    !filePath ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes('\0') ||
    filePath.split('/').some((part) => part === '..')
  ) return null;
  if (params.get('dir') === '1') return { path: filePath, kind: 'directory' };
  const line = positiveInteger(params.get('line'));
  const column = line ? positiveInteger(params.get('column')) : undefined;
  return { path: filePath, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function hashWithProjectFiles(
  hash: string,
  projectId: string | null,
  file: ProjectFileLocation | null = null,
): string {
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  if (projectId) {
    params.set('files', projectId);
    params.delete('artifact');
    params.delete('browser');
    if (file) {
      params.set('file', file.path);
      if (file.kind === 'directory') params.set('dir', '1');
      else params.delete('dir');
      if (file.line) params.set('line', String(file.line));
      else params.delete('line');
      if (file.column) params.set('column', String(file.column));
      else params.delete('column');
    } else {
      params.delete('file');
      params.delete('line');
      params.delete('column');
      params.delete('dir');
    }
  } else {
    params.delete('files');
    params.delete('file');
    params.delete('line');
    params.delete('column');
    params.delete('dir');
  }
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ''}`;
}
