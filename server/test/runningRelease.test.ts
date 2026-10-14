import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runningRelease } from '../src/release.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

it('names the release a process was started from, and null for the checkout build', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-release-'));
  const dist = path.join(dir, 'server', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  expect(runningRelease(dist)).toEqual({ id: null, git_sha: null, manifest_sha256: null });
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id: 'abc1234def56-0123456789ab', git_sha: 'abc', manifest_sha256: 'f'.repeat(64) }));
  expect(runningRelease(dist)).toEqual({ id: 'abc1234def56-0123456789ab', git_sha: 'abc', manifest_sha256: 'f'.repeat(64) });
});

it('every service logs its release at boot and web/runner report it on /healthz', () => {
  const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
  for (const [entry, service] of [['index.ts', 'veneer-pro'], ['runner/index.ts', 'veneer-pro-runner'], ['appRunner/index.ts', 'veneer-pro-app-runner'], ['terminalService/index.ts', 'veneer-pro-term']])
    expect(read(entry)).toContain(`loadEnvFile();\nlogRunningRelease('${service}');`);
  expect(read('index.ts')).toContain("runner: 'healthy', release: runningRelease().id");
  expect(read('runner/ipcServer.ts')).toContain('{ ok: true, release: runningRelease().id }');
});
