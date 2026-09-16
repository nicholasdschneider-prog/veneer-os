import { describe, expect, it } from 'vitest';
import { hashWithProjectFiles, projectFileLocationFromParams } from './projectFilesRoute';

describe('hashWithProjectFiles', () => {
  it('preserves the chat route and replaces the artifact pane', () => {
    expect(hashWithProjectFiles('#/chat/chat-1?project=project-1&artifact=file%3Areadme', 'project-1')).toBe(
      '#/chat/chat-1?project=project-1&files=project-1',
    );
  });

  it('closes files without dropping the chat project', () => {
    expect(hashWithProjectFiles('#/chat/chat-1?project=project-1&files=project-1&file=src%2Fa.ts&line=4', null)).toBe(
      '#/chat/chat-1?project=project-1',
    );
  });

  it('opens a specific file and replaces stale panel locations', () => {
    expect(hashWithProjectFiles(
      '#/chat/chat-1?project=project-1&files=project-1&file=old.ts&line=8',
      'project-1',
      { path: 'src/server.mjs', line: 12, column: 4 },
    )).toBe('#/chat/chat-1?project=project-1&files=project-1&file=src%2Fserver.mjs&line=12&column=4');
  });

  it('round-trips a folder location through the route', () => {
    const hash = hashWithProjectFiles(
      '#/chat/chat-1?project=project-1&files=project-1&file=old.ts&line=8&column=2',
      'project-1',
      { path: 'src/nested', kind: 'directory' },
    );
    expect(hash).toBe('#/chat/chat-1?project=project-1&files=project-1&file=src%2Fnested&dir=1');
    expect(projectFileLocationFromParams(new URLSearchParams(hash.split('?')[1]))).toEqual({
      path: 'src/nested', kind: 'directory',
    });
    expect(hashWithProjectFiles(hash, 'project-1', { path: 'src/a.ts', line: 3 })).toBe(
      '#/chat/chat-1?project=project-1&files=project-1&file=src%2Fa.ts&line=3',
    );
    expect(hashWithProjectFiles(hash, 'project-1')).toBe('#/chat/chat-1?project=project-1&files=project-1');
    expect(hashWithProjectFiles(hash, null)).toBe('#/chat/chat-1?project=project-1');
  });

  it('reads only safe relative file locations from the route', () => {
    expect(projectFileLocationFromParams(new URLSearchParams('file=src%2Fserver.mjs&line=12&column=4'))).toEqual({
      path: 'src/server.mjs', line: 12, column: 4,
    });
    expect(projectFileLocationFromParams(new URLSearchParams('file=..%2Fsecret&line=2'))).toBeNull();
    expect(projectFileLocationFromParams(new URLSearchParams('file=%2Fetc%2Fpasswd'))).toBeNull();
    expect(projectFileLocationFromParams(new URLSearchParams('file=src%2Fa.ts&line=0&column=3'))).toEqual({
      path: 'src/a.ts',
    });
  });
});
