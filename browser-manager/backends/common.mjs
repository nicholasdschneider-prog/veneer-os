import net from 'node:net';
import { WebSocket } from 'ws';

// Profile ids, client ids and project ids all share the manager's id shape; the
// backends validate labels they read back out of the runtime with it.
export const ID = /^[A-Za-z0-9_-]{1,200}$/;

// Chrome answers /json/version as soon as DevTools is listening, which is the
// same readiness gate the container path used.
export async function waitForCdp(port, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Browser did not become ready: ${last}`);
}

// Browser.close lets Chrome flush cookies and leveldb state before it goes, so a
// copy taken straight after a stop is complete. Every caller has a bounded
// fallback (docker stop, or SIGTERM/SIGKILL) when this does not land, and the
// return value says whether waiting for a clean exit is worth anything.
export async function cleanClose(port) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    if (!version.webSocketDebuggerUrl) return false;
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), 5000);
      ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.once('error', reject);
    });
    return true;
  } catch {
    /* The caller's kill path is the bounded fallback. */
    return false;
  }
}

// Chrome has no "pick a port and tell me" mode, so the manager claims one from
// the kernel and hands the number over. The gap between close and launch is a
// race only another listener on this loopback could win.
export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
