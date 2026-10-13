// Shared across checkouts and service HOME directories on the same Mac.
// Fail closed on abandoned locks: never guess that an orphaned compiler stopped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function runDevelopmentCommand(command, args, lockDir = `/tmp/veneer-development-${process.getuid?.() ?? 'user'}.lock`) {
  if (!command) throw new Error('A development command is required');
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another development job holds ${lockDir}. Do not overlap tests/builds or retry in a loop. Wait for its owner to finish; if abandoned, verify the owner and child processes have exited before removing the lock.`);
  }
  let child;
  const forward = (signal) => {
    if (!child?.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const term = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  try {
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() }), { mode: 0o600 });
    child = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32' });
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
    try {
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, childPid: child.pid, cwd: process.cwd(), startedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch (error) {
      forward('SIGTERM');
      await completion.catch(() => {});
      throw error;
    }
    return await completion;
  } finally {
    process.off('SIGTERM', term);
    process.off('SIGINT', interrupt);
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runDevelopmentCommand(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(`[development] ${error.message}`); process.exitCode = 1; }
}
