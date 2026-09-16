import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeFilePreview, isCodeFileName } from './CodeFilePreview';

describe('CodeFilePreview', () => {
  it.each([
    'Component.tsx',
    'worker.JS',
    'src/config.json',
    'script.py',
    'Dockerfile',
  ])('recognizes source file %s', (fileName) => {
    expect(isCodeFileName(fileName)).toBe(true);
  });

  it.each(['README.md', 'notes.txt', 'server.log', 'page.html', 'report.csv'])(
    'leaves non-code file %s with its existing preview',
    (fileName) => {
      expect(isCodeFileName(fileName)).toBe(false);
    },
  );

  it('keeps the heavy renderer behind a suspense boundary', () => {
    const html = renderToStaticMarkup(
      <CodeFilePreview fileName="Component.tsx" content="export const answer = 42;" />,
    );

    expect(html).toContain('Preparing code viewer…');
  });
});
