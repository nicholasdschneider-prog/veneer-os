// Fixed harmless runtime probe. Receives synthetic paths, never provider credentials.
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const [fixture, canary, outside, port, unixPath, write, escape] = process.argv.slice(2);
const attempt = fn => { try { fn(); return null; } catch (e) { return e.code; } };
const connect = options => new Promise(resolve => {
  const socket = net.createConnection(options);
  socket.once('connect', () => { socket.destroy(); resolve(null); });
  socket.once('error', error => { socket.destroy(); resolve(error.code); });
});
(async () => {
  const result = {
    booted: true, node: process.versions.node,
    allowedRead: attempt(() => fs.readFileSync(fixture)),
    allowedWrite: attempt(() => fs.writeFileSync(write, 'synthetic')),
    deniedRead: attempt(() => fs.readFileSync(canary)),
    deniedWrite: attempt(() => fs.writeFileSync(outside, 'synthetic')),
    deniedSymlink: attempt(() => fs.readFileSync(escape)),
    deniedSelfSpawn: spawnSync(process.execPath, ['--version']).error?.code ?? null,
    deniedShellSpawn: spawnSync('/bin/sh', ['-c', 'exit 0']).error?.code ?? null,
    parentMarkerAbsent: process.env.FIXTURE_PARENT_CANARY === undefined,
    deniedTcp: await connect({ host: '127.0.0.1', port: Number(port) }),
    deniedUnix: await connect({ path: unixPath }),
  };
  console.log(JSON.stringify(result));
})().catch(() => { process.exitCode = 70; });
