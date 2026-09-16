import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProjectFileLinkTarget, resolveProjectFileLink } from '../src/files/projectFileLinks.js';

let tmp = '';
let root = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-links-'));
  root = path.join(tmp, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'server.mjs'), 'one\ntwo\nthree\n');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('parseProjectFileLinkTarget', () => {
  it('parses relative and absolute editor locations', () => {
    expect(parseProjectFileLinkTarget('src/server.mjs:12:4')).toEqual({
      path: 'src/server.mjs',
      line: 12,
      column: 4,
    });
    expect(parseProjectFileLinkTarget('/tmp/server.mjs#L8C2')).toEqual({
      path: '/tmp/server.mjs',
      line: 8,
      column: 2,
    });
  });

  it('decodes URL paths and accepts file URLs', () => {
    expect(parseProjectFileLinkTarget('src/my%20file.ts#L3')).toEqual({
      path: 'src/my file.ts',
      line: 3,
      column: null,
    });
    expect(parseProjectFileLinkTarget('file:///tmp/my%20file.ts:9')).toEqual({
      path: '/tmp/my file.ts',
      line: 9,
      column: null,
    });
  });

  it('rejects web URLs, malformed locations, and query strings', () => {
    expect(parseProjectFileLinkTarget('https://example.com/server.mjs')).toBeNull();
    expect(parseProjectFileLinkTarget('server.mjs#L0')).toBeNull();
    expect(parseProjectFileLinkTarget('server.mjs?download=1')).toBeNull();
  });
});

describe('resolveProjectFileLink', () => {
  it('resolves relative, absolute, and normalized in-project targets', () => {
    expect(resolveProjectFileLink(root, 'src/server.mjs:2')).toMatchObject({
      ok: true,
      path: 'src/server.mjs',
      line: 2,
      column: null,
    });
    expect(resolveProjectFileLink(root, `${path.join(root, 'src', 'server.mjs')}:3:2`)).toMatchObject({
      ok: true,
      path: 'src/server.mjs',
      line: 3,
      column: 2,
    });
    expect(resolveProjectFileLink(root, 'src/../src/server.mjs')).toMatchObject({ ok: true, path: 'src/server.mjs' });
  });

  it('rejects traversal and missing files', () => {
    fs.writeFileSync(path.join(tmp, 'outside.mjs'), 'outside');
    expect(resolveProjectFileLink(root, '../outside.mjs')).toEqual({ ok: false, reason: 'outside' });
    expect(resolveProjectFileLink(root, path.join(tmp, 'outside.mjs'))).toEqual({ ok: false, reason: 'outside' });
    expect(resolveProjectFileLink(root, 'missing.mjs')).toEqual({ ok: false, reason: 'missing' });
  });

  it('resolves a folder as a directory link', () => {
    expect(resolveProjectFileLink(root, 'src')).toMatchObject({
      ok: true,
      kind: 'directory',
      path: 'src',
      absolutePath: fs.realpathSync(path.join(root, 'src')),
    });
    expect(resolveProjectFileLink(root, path.join(root, 'src'))).toMatchObject({ ok: true, kind: 'directory' });
    expect(resolveProjectFileLink(root, 'src/server.mjs')).toMatchObject({ ok: true, kind: 'file' });
  });

  it('rejects an entry that is neither a file nor a directory', () => {
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    expect(resolveProjectFileLink(root, 'pipe')).toEqual({ ok: false, reason: 'not-file' });
  });

  it('rejects a symlink that escapes the project and accepts one that stays inside', () => {
    const outside = path.join(tmp, 'outside.mjs');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(root, 'outside-link.mjs'));
    fs.symlinkSync(path.join(root, 'src', 'server.mjs'), path.join(root, 'inside-link.mjs'));
    expect(resolveProjectFileLink(root, 'outside-link.mjs')).toEqual({ ok: false, reason: 'outside' });
    expect(resolveProjectFileLink(root, 'inside-link.mjs')).toMatchObject({ ok: true, path: 'src/server.mjs' });
  });
});
