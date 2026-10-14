import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { guardSetTypeOfService } from './type-of-service-guard.mjs';

const errno = (code, syscall) => Object.assign(new Error(`${syscall} ${code}`), { code, syscall });

test('only setTypeOfService EINVAL becomes a no-op; every other error still throws', (t) => {
  t.mock.method(console, 'warn', () => {});
  const socket = {};
  assert.equal(guardSetTypeOfService(() => { throw errno('EINVAL', 'setTypeOfService'); }).call(socket, 0), socket);
  assert.throws(() => guardSetTypeOfService(() => { throw errno('EPERM', 'setTypeOfService'); }).call(socket, 0), /EPERM/);
  assert.throws(() => guardSetTypeOfService(() => { throw errno('EINVAL', 'write'); }).call(socket, 0), /write EINVAL/);
});

test('the manager installs the guard before anything else runs', () => {
  const source = fs.readFileSync(new URL('./manager.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ installTypeOfServiceGuard \} from '\.\/type-of-service-guard\.mjs';[\s\S]*?\ninstallTypeOfServiceGuard\(\);/);
  assert.ok(source.indexOf('installTypeOfServiceGuard();') < source.indexOf('const exec = promisify'));
});

// The crash needs the reset to land while the client's event loop is busy, so
// the client runs in its own process and stalls between requests.
test('a guarded process survives peers that reset during an event-loop stall', async () => {
  const server = net.createServer((socket) => socket.resetAndDestroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tos-'));
  try {
    const script = path.join(dir, 'client.mjs');
    fs.writeFileSync(script, `
      (await import(${JSON.stringify(fileURLToPath(new URL('./type-of-service-guard.mjs', import.meta.url)))})).installTypeOfServiceGuard();
      process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e.code, e.syscall); process.exit(3); });
      const results = new Set();
      for (let i = 0; i < 120; i++) {
        const p = fetch('http://127.0.0.1:${server.address().port}/').then(() => 'ok', () => 'rejected');
        for (let k = 0; k < i % 4; k++) await new Promise((r) => setImmediate(r));
        const until = Date.now() + 20; while (Date.now() < until) {}
        results.add(await p);
      }
      console.log('done ' + [...results].join(','));
    `);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.doesNotMatch(output, /UNCAUGHT/);
    assert.equal(code, 0);
    assert.match(output, /done rejected/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
