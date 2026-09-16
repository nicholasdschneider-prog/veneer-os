import { describe, expect, it } from 'vitest';
import { parentTreePaths, projectFileLinkIntent, textSelectionForLocation } from './projectFileLinks';

describe('projectFileLinkIntent', () => {
  it('recognizes relative, absolute, file URL, and line-target file links', () => {
    expect(projectFileLinkIntent('server.mjs')).toEqual({ target: 'server.mjs', explicit: true });
    expect(projectFileLinkIntent('src/server.mjs:12:4')).toEqual({ target: 'src/server.mjs:12:4', explicit: true });
    expect(projectFileLinkIntent('/Users/sam/project/server.mjs#L8')).toEqual({
      target: '/Users/sam/project/server.mjs#L8', explicit: true,
    });
    expect(projectFileLinkIntent('file:///tmp/report.csv')).toEqual({ target: 'file:///tmp/report.csv', explicit: true });
    expect(projectFileLinkIntent('README')).toEqual({ target: 'README', explicit: false });
  });

  it('leaves external URLs and Veneer routes alone', () => {
    expect(projectFileLinkIntent('https://example.com/server.mjs')).toBeNull();
    expect(projectFileLinkIntent('mailto:owner@example.com')).toBeNull();
    expect(projectFileLinkIntent('/api/generated-files/id/preview')).toBeNull();
    expect(projectFileLinkIntent('/tools/app/')).toBeNull();
    expect(projectFileLinkIntent('#section')).toBeNull();
  });
});

it('builds the parent tree path sequence', () => {
  expect(parentTreePaths('src/routes/server.mjs')).toEqual(['src/', 'src/routes/']);
  expect(parentTreePaths('server.mjs')).toEqual([]);
});

describe('textSelectionForLocation', () => {
  const content = 'one\ntwo\r\nthree';

  it('selects a requested line', () => {
    expect(textSelectionForLocation(content, { line: 2 })).toEqual({ start: 4, end: 7, lineIndex: 1 });
  });

  it('places a caret at a requested column and clamps out-of-range locations', () => {
    expect(textSelectionForLocation(content, { line: 3, column: 3 })).toEqual({ start: 11, end: 11, lineIndex: 2 });
    expect(textSelectionForLocation(content, { line: 99, column: 99 })).toEqual({ start: 14, end: 14, lineIndex: 2 });
  });
});
