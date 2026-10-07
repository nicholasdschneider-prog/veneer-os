// Run with Node 24; add --import tsx and --source to measure source before build.
import Database from '../../node_modules/better-sqlite3/lib/index.js';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const source = process.argv.includes('--source');
const base = source ? '../../server/src/bots/' : '../../server/dist/bots/';
const suffix = source ? '.ts' : '.js';
const { createBotService } = await import(base + 'service' + suffix);
const { questionLine } = await import(base + 'questionLine' + suffix);
const db = new Database('/Users/archerclawdington/.local/share/veneer-pro/veneer-pro.db', { readonly: true });
const user = db.prepare('SELECT * FROM users WHERE id=1').get();
const service = createBotService(db);
for (const [name, run] of [['list', () => service.list({ user })], ['questionLine', () => questionLine({ db }, user).snapshot().decisions]]) {
  const ms = []; let count;
  for (let i = 0; i < 5; i++) { const start = performance.now(); count = run().length; ms.push(Number((performance.now() - start).toFixed(1))); }
  console.log(JSON.stringify({ name, count, ms }));
}
db.close();
if (process.argv.includes('--live')) {
  const pid = fs.readFileSync('/Users/archerclawdington/.local/share/veneer-pro/run/veneer-pro.pid', 'utf8').trim();
  const cpuTime = () => {
    const value = execFileSync('/bin/ps', ['-p', pid, '-o', 'time='], { encoding: 'utf8' }).trim();
    const [minutes, seconds] = value.split(':').map(Number);
    return minutes * 60 + seconds;
  };
  const start = performance.now(), cpuStart = cpuTime(); const healthMs = [];
  for (let i = 0; i < 15; i++) {
    const at = performance.now();
    try { const response = await fetch('http://127.0.0.1:3100/healthz', { signal: AbortSignal.timeout(5000) }); await response.text(); healthMs.push({ status: response.status, ms: Number((performance.now() - at).toFixed(1)) }); }
    catch { healthMs.push({ status: 'timeout', ms: Number((performance.now() - at).toFixed(1)) }); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log(JSON.stringify({ pid, cpuPercent: Number((100000 * (cpuTime() - cpuStart) / (performance.now() - start)).toFixed(1)), healthMs }));
}
