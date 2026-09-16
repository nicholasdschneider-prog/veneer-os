import { describe, expect, it } from 'vitest';
import { artifactKind } from '../src/files/artifactKind.js';

describe('artifactKind', () => {
  it.each(['Contract.sol', 'TOKEN.SOL', 'component.tsx', 'script.js', 'Dockerfile'])(
    'treats source file %s as code',
    (fileName) => {
      expect(artifactKind(fileName)).toBe('code');
    },
  );

  it.each(['notes.txt', 'README.md', 'server.log'])('keeps prose file %s as text', (fileName) => {
    expect(artifactKind(fileName)).toBe('text');
  });

  it('preserves existing file classifications', () => {
    expect(artifactKind('data.csv')).toBe('csv');
    expect(artifactKind('diagram.svg')).toBe('image');
    expect(artifactKind('page.html')).toBe('html');
    expect(artifactKind('archive.zip')).toBe('other');
  });
});
