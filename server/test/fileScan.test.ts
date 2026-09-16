import { describe, expect, it } from 'vitest';
import { linkedFilePaths } from '../src/providers/fileScan.js';

const HOME = '/Users/tester';

describe('linkedFilePaths', () => {
  it('registers the file behind editor locations and local file URLs', () => {
    expect(linkedFilePaths('[a](/tmp/report.md:12:3) [b](/tmp/report.md#L9C2) [c](file://localhost/tmp/a%20b.md:4)', HOME))
      .toEqual(['/tmp/report.md', '/tmp/a b.md']);
  });

  it('does not turn remote file URLs or NUL bytes into local file candidates', () => {
    expect(linkedFilePaths('[a](file://remote/tmp/report.md) [b](/tmp/a%00.md)', HOME)).toEqual([]);
  });

  it('extracts absolute paths from markdown link targets', () => {
    const md = 'Done. Files:\n- [Summary](/work/reports/SUMMARY.md)\n- [Data CSV](/work/reports/data.csv)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/reports/SUMMARY.md', '/work/reports/data.csv']);
  });

  it('extracts an absolute deliverable path presented as inline code', () => {
    const md = 'Download it from `/Users/tester/Downloads/AuthBox.otf`.';
    expect(linkedFilePaths(md, HOME)).toEqual(['/Users/tester/Downloads/AuthBox.otf']);
  });

  it('decodes percent-encoding (agents URL-encode spaces in hrefs)', () => {
    const md = '[CSV](/Users/tester/Developer/Crew%20Seating/repo/_files/comparison-details.csv)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/Users/tester/Developer/Crew Seating/repo/_files/comparison-details.csv']);
  });

  it('accepts file:// targets and ~/ targets', () => {
    const md = '[a](file:///tmp/out.pdf) and [b](~/exports/report.xlsx)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/tmp/out.pdf', '/Users/tester/exports/report.xlsx']);
  });

  it('ignores web URLs and relative paths', () => {
    const md = '[site](https://example.com/report.csv) and [rel](reports/data.csv) and [anchor](#section)';
    expect(linkedFilePaths(md, HOME)).toEqual([]);
  });

  it('accepts extensionless targets (existence and isFile checks are the caller\'s job)', () => {
    const md = '[folder](/work/reports/2026-07-28) [readme](/work/README)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/reports/2026-07-28', '/work/README']);
  });

  it('dedupes repeated targets and normalizes the path', () => {
    const md = '[a](/work/./data.csv) then again [b](/work/data.csv)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/data.csv']);
  });

  it('keeps a malformed percent-encoding as the raw string instead of throwing', () => {
    const md = '[bad](/work/100%file.csv)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/100%file.csv']);
  });

  it('accepts absolute targets containing raw spaces', () => {
    const md = '[dmg](/Users/tester/Developer/Crew Seating/cut-station/dist/Crew Cut Station-1.0.0-arm64.dmg)';
    expect(linkedFilePaths(md, HOME)).toEqual([
      '/Users/tester/Developer/Crew Seating/cut-station/dist/Crew Cut Station-1.0.0-arm64.dmg',
    ]);
  });

  it('accepts angle-bracket targets, with or without a title', () => {
    const md = '[a](</work/my report.pdf>) and [b](</work/other file.csv> "the data")';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/my report.pdf', '/work/other file.csv']);
  });

  it('drops a trailing title from a plain target and trims padding', () => {
    const md = '[a](/work/data.csv "quarterly") and [b]( /work/padded.csv )';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/data.csv', '/work/padded.csv']);
  });

  it('still ignores relative targets even when they contain spaces', () => {
    const md = '[rel](my reports/data.csv) and prose with ](stray parens) in it';
    expect(linkedFilePaths(md, HOME)).toEqual([]);
  });

  it('extracts each of several space-containing links on one line', () => {
    const md = '[a](/work/a b.csv), [b](/work/c d.csv)';
    expect(linkedFilePaths(md, HOME)).toEqual(['/work/a b.csv', '/work/c d.csv']);
  });
});
