import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkedFilePaths } from '../src/providers/fileScan.js';
import { sessionFileView, sessionFileViews } from '../src/files/sessionFileViews.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sessionFileView', () => {
  it('previews a linked file outside the project with a line suffix, retaining heuristic guards', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-linked-preview-'));
    roots.push(root);
    const file = path.join(root, 'report.md');
    fs.writeFileSync(file, '# Report');
    const [linked] = linkedFilePaths(`[Report](${file}:12)`, root);
    expect(sessionFileView({ path: linked!, source: 'bash' }, 0)?.path).toBe(fs.realpathSync(file));
    expect(sessionFileView({ path: linked!, source: 'bash' }, Date.now() + 60_000)).toBeNull();
    expect(sessionFileView({ path: root, source: 'bash' }, 0)).toBeNull();
  });

  it('returns the canonical path for an aliased file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-session-view-'));
    roots.push(root);
    const realDir = path.join(root, 'real');
    const aliasDir = path.join(root, 'alias');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, aliasDir);
    const realFile = path.join(realDir, 'mention-chip.png');
    fs.writeFileSync(realFile, 'image');

    const view = sessionFileView({ path: path.join(aliasDir, 'mention-chip.png'), source: 'write' }, 0);

    expect(view?.path).toBe(fs.realpathSync(realFile));
    expect(view?.name).toBe('mention-chip.png');
    expect(view?.aliases).toEqual([path.join(aliasDir, 'mention-chip.png')]);
  });

  it('merges refs to one file through a moved folder into one view with aliases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-session-views-'));
    roots.push(root);
    const realDir = path.join(root, 'ssd', '35TNJ6');
    fs.mkdirSync(realDir, { recursive: true });
    const aliasDir = path.join(root, 'out-35TNJ6');
    fs.symlinkSync(realDir, aliasDir);
    fs.writeFileSync(path.join(realDir, 'photo.png'), 'image');
    const canonical = fs.realpathSync(path.join(realDir, 'photo.png'));

    const views = sessionFileViews([
      { path: canonical, source: 'bash' },
      { path: path.join(aliasDir, 'photo.png'), source: 'bash' },
      { path: path.join(aliasDir, 'photo.png'), source: 'write' },
    ], 0);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ path: canonical, source: 'write', aliases: [path.join(aliasDir, 'photo.png')] });
  });
});
