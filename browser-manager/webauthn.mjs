import { WebSocket } from 'ws';

// Passkey-first sites (Shopify admin among them) call navigator.credentials.get()
// the moment an email is submitted. In a working copy there is no platform
// authenticator to answer, so in a plain Chrome that promise never settles: the
// page shows a spinning "Log in with passkey" button and the "use a different
// method" links stay inert, and the agent never reaches the password + TOTP
// path it actually has credentials for.
//
// Chrome 153 has no launch flag that switches WebAuthn off (verified: the
// promise still hangs with --disable-features=WebAuthentication). What does
// work is the DevTools WebAuthn domain: a virtual authenticator that holds no
// credentials and cannot verify a user makes credentials.get() reject with
// NotAllowedError in milliseconds and reports no platform authenticator, so the
// site falls back to its non-passkey path. The virtual environment is per page
// target and is torn down when the DevTools session that created it goes away,
// so the manager keeps one browser-level connection per working copy for the
// life of the runtime and installs the authenticator on every page it attaches
// to, including tabs the agent opens later.

/** An authenticator with nothing to offer: no credentials, no user verification. */
export const VIRTUAL_AUTHENTICATOR = Object.freeze({
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: false,
  isUserVerified: false,
  automaticPresenceSimulation: true,
});

/** Set VP_BROWSER_ALLOW_PASSKEYS=1 (or the VENEER_BROWSER_ spelling) to leave WebAuthn alone. */
export function passkeysAllowed(env = process.env) {
  return env.VP_BROWSER_ALLOW_PASSKEYS === '1' || env.VENEER_BROWSER_ALLOW_PASSKEYS === '1';
}

/** Chrome's browser-target socket address behind a loopback DevTools port. */
export async function browserSocketUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10_000) });
  const version = await response.json();
  const target = new URL(version.webSocketDebuggerUrl);
  return `ws://127.0.0.1:${port}${target.pathname}`;
}

/**
 * Hold a browser-level DevTools session that installs the empty virtual
 * authenticator on every page target for as long as the socket stays open.
 *
 * Returns a handle: `close()` drops the session (Chrome removes the virtual
 * authenticators with it), `done` settles when the socket has closed for any
 * reason, and `ready` settles once auto-attach is on (rejects if the socket
 * fails before that).
 */
export function blockPasskeys(socketUrl, { log = () => {}, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(socketUrl, { perMessageDeflate: false });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
    rejectReady(new Error(reason));
    try { socket.close(); } catch {}
    resolveDone(reason);
  };

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed || socket.readyState !== WebSocketImpl.OPEN) return reject(new Error('The browser control socket is closed.'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    socket.send(JSON.stringify(message));
  });

  // Errors here are logged and swallowed: a page that cannot take the
  // authenticator (a crashed or already-gone target) must not stall the rest,
  // and the target is released whatever happened so it never waits forever.
  const arm = async (sessionId, targetInfo, waitingForDebugger) => {
    try {
      await send('WebAuthn.enable', { enableUI: false }, sessionId);
      await send('WebAuthn.addVirtualAuthenticator', { options: { ...VIRTUAL_AUTHENTICATOR } }, sessionId);
    } catch (error) {
      log(`passkeys stay live on ${targetInfo?.url ?? 'a page'}: ${error.message}`);
    } finally {
      if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  };

  socket.on('open', () => {
    send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'page', exclude: false }],
    }).then(resolveReady, (error) => finish(`auto-attach refused: ${error.message}`));
  });
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'DevTools error'));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'Target.attachedToTarget' && message.params?.sessionId) {
      const { sessionId, targetInfo, waitingForDebugger } = message.params;
      void arm(sessionId, targetInfo, waitingForDebugger === true);
    }
  });
  socket.on('close', () => finish('closed'));
  socket.on('error', (error) => finish(error?.message ?? 'socket error'));

  return {
    ready,
    done,
    get closed() { return closed; },
    close() { finish('stopped'); },
  };
}
