import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../src/envFile.js';

describe('service env file', () => {
  let dir: string;
  let file: string;
  const touched: string[] = [];

  const write = (contents: string): void => fs.writeFileSync(file, contents);
  const set = (key: string, value: string): void => {
    touched.push(key);
    process.env[key] = value;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-env-'));
    file = path.join(dir, 'env');
  });

  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('VP_TEST_')) delete process.env[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads plain KEY=value lines', () => {
    write('VP_TEST_A=one\nVP_TEST_B=two\n');
    expect(loadEnvFile(file).sort()).toEqual(['VP_TEST_A', 'VP_TEST_B']);
    expect(process.env.VP_TEST_A).toBe('one');
    expect(process.env.VP_TEST_B).toBe('two');
  });

  it('never overrides a variable the supervisor already set', () => {
    // This is what keeps systemd authoritative on Linux.
    set('VP_TEST_A', 'from-systemd');
    write('VP_TEST_A=from-file\n');

    expect(loadEnvFile(file)).toEqual([]);
    expect(process.env.VP_TEST_A).toBe('from-systemd');
  });

  it('ignores comments and blank lines', () => {
    write('# a comment\n\n   \nVP_TEST_A=one\n');
    expect(loadEnvFile(file)).toEqual(['VP_TEST_A']);
  });

  it('strips one pair of surrounding quotes, as systemd does', () => {
    write('VP_TEST_A="quoted value"\nVP_TEST_B=\'single\'\nVP_TEST_C="quote: \\"ok\\""\n');
    loadEnvFile(file);
    expect(process.env.VP_TEST_A).toBe('quoted value');
    expect(process.env.VP_TEST_B).toBe('single');
    expect(process.env.VP_TEST_C).toBe('quote: "ok"');
  });

  it('keeps values containing spaces, = and # intact', () => {
    // The reason services parse this file themselves instead of having launchd
    // source it through a shell.
    write('VP_TEST_A=a b c\nVP_TEST_B=key=value=more\nVP_TEST_C="trailing # hash"\n');
    loadEnvFile(file);
    expect(process.env.VP_TEST_A).toBe('a b c');
    expect(process.env.VP_TEST_B).toBe('key=value=more');
    expect(process.env.VP_TEST_C).toBe('trailing # hash');
  });

  it('accepts an export prefix', () => {
    write('export VP_TEST_A=one\n');
    expect(loadEnvFile(file)).toEqual(['VP_TEST_A']);
    expect(process.env.VP_TEST_A).toBe('one');
  });

  it('treats a missing file as normal', () => {
    expect(loadEnvFile(path.join(dir, 'nope'))).toEqual([]);
  });

  it('skips malformed lines rather than throwing', () => {
    write('not an assignment\n9INVALID=x\nVP_TEST_A=one\n');
    expect(loadEnvFile(file)).toEqual(['VP_TEST_A']);
  });
});
