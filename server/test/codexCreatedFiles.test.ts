import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendShadowFiles, readShadowFiles, shadowFilesPath } from '../src/providers/codex/transcript.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-files-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('codex created-files sidecar', () => {
  it('round-trips refs across turns, deduping by path with write winning', async () => {
    appendShadowFiles(dir, 'thread-1', [
      { path: '/work/data.csv', source: 'bash' },
      { path: '/work/report.html', source: 'write' },
    ]);
    appendShadowFiles(dir, 'thread-1', [
      { path: '/work/data.csv', source: 'write' }, // later exact detection upgrades the earlier heuristic
      { path: '/work/report.html', source: 'bash' }, // never downgrades
    ]);
    expect(await readShadowFiles(dir, 'thread-1')).toEqual([
      { path: '/work/data.csv', source: 'write' },
      { path: '/work/report.html', source: 'write' },
    ]);
  });

  it('writes nothing for an empty turn and reads empty for unknown threads', async () => {
    appendShadowFiles(dir, 'thread-2', []);
    expect(fs.existsSync(shadowFilesPath(dir, 'thread-2'))).toBe(false);
    expect(await readShadowFiles(dir, 'thread-2')).toEqual([]);
    expect(await readShadowFiles(dir, '')).toEqual([]);
  });

  it('skips corrupt lines and non-absolute paths instead of failing the listing', async () => {
    fs.writeFileSync(
      shadowFilesPath(dir, 'thread-3'),
      '{"path":"/work/ok.csv","source":"bash"}\nnot json\n{"path":"relative.csv","source":"bash"}\n{"source":"bash"}\n',
    );
    expect(await readShadowFiles(dir, 'thread-3')).toEqual([{ path: '/work/ok.csv', source: 'bash' }]);
  });
});
