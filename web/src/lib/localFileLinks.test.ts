import { describe, expect, it } from 'vitest';
import { codePathLink, encodeLocalFileLinkTargets } from './localFileLinks';

describe('encodeLocalFileLinkTargets', () => {
  it('encodes raw spaces in absolute-path targets', () => {
    const md = '[dmg](/Users/x/Crew Seating/dist/Crew Cut Station-1.0.0-arm64.dmg)';
    expect(encodeLocalFileLinkTargets(md)).toBe(
      '[dmg](/Users/x/Crew%20Seating/dist/Crew%20Cut%20Station-1.0.0-arm64.dmg)',
    );
  });

  it('encodes file:// and ~/ targets too', () => {
    expect(encodeLocalFileLinkTargets('[a](file:///tmp/a b.pdf) [b](~/my docs/c.csv)')).toBe(
      '[a](file:///tmp/a%20b.pdf) [b](~/my%20docs/c.csv)',
    );
  });

  it('leaves targets without whitespace, web URLs and relative paths alone', () => {
    const md = '[ok](/tmp/a.csv) [web](https://example.com/a b) [rel](my docs/a.csv)';
    expect(encodeLocalFileLinkTargets(md)).toBe(md);
  });

  it('keeps a trailing title outside the encoded target', () => {
    expect(encodeLocalFileLinkTargets('[a](/tmp/a b.csv "the data")')).toBe(
      '[a](/tmp/a%20b.csv "the data")',
    );
  });

  it('leaves a padded space-free target alone (CommonMark accepts padded destinations)', () => {
    expect(encodeLocalFileLinkTargets('[a]( /tmp/a.csv )')).toBe('[a]( /tmp/a.csv )');
  });

  it('encodes each of several links on one line independently', () => {
    expect(encodeLocalFileLinkTargets('[a](/w/a b.csv), [b](/w/c d.csv)')).toBe(
      '[a](/w/a%20b.csv), [b](/w/c%20d.csv)',
    );
  });
});

describe('codePathLink', () => {
  it('links a bare absolute path, decoding %20 for display', () => {
    expect(codePathLink('/Users/you/Developer/Crew%20Seating/out/stale-files-report.md')).toEqual({
      label: '/Users/you/Developer/Crew Seating/out/stale-files-report.md',
      href: '/Users/you/Developer/Crew%20Seating/out/stale-files-report.md',
    });
    expect(codePathLink('/tmp/a b.csv')).toEqual({ label: '/tmp/a b.csv', href: '/tmp/a%20b.csv' });
  });

  it('accepts ~/ and file:// targets', () => {
    expect(codePathLink('~/docs/notes.md')?.href).toBe('~/docs/notes.md');
    expect(codePathLink('file:///tmp/out.pdf')?.href).toBe('file:///tmp/out.pdf');
  });

  it('ignores ordinary code, commands, globs, directories and app routes', () => {
    for (const text of [
      'npm run build',
      '/Users/x/run.py --flag',
      '/tmp/*.log',
      '/Users/x/a.md /Users/x/b.md',
      '/Users/x/out/',
      '/api/files',
      '/etc/hosts',
      'foo | bar',
      '/Users/x/bad%E0%A4%A',
    ]) {
      expect(codePathLink(text), text).toBeNull();
    }
  });
});
