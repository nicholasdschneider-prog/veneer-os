import type { IPty } from 'node-pty';
import { createRequire } from 'node:module';
import { agentEnv } from '../homes.js';
import { dopplerCliConfigDir } from '../secrets/doppler.js';

const require = createRequire(import.meta.url);

/**
 * Pty session store for the terminal service: one persistent pty per
 * (userId, scopeKey). A client disconnect does NOT kill the shell — output
 * keeps accumulating in a ring buffer and is replayed on the next attach, and
 * a new connection for the same key takes over from any still-open one.
 *
 * This lives in its own service (veneer-pro-term) rather than in the web
 * process so that shipping web/UI code does not end anyone's shell: the web
 * process only relays frames here (see channels/terminal.ts).
 *
 * NEVER log pty output or input — it can contain secrets. Lifecycle only.
 */

export const REPLAY_CAP = 200_000; // chars; trim from the front
export const REAP_INTERVAL_MS = 60 * 1000;
export const REAP_DETACHED_AFTER_MS = 12 * 60 * 60 * 1000;
// A dead-but-not-closed client (mobile network drop, laptop sleep) never fires
// 'close', so force-detach it once it misses several client pings (every 25s).
export const STALE_ATTACHED_MS = 90 * 1000;
// Flow control: pause the pty when this much output is queued to a slow client
// (backgrounded tab, cellular stall) so a chatty shell can't grow the send
// buffer until the whole process OOMs. Resume once it drains below half.
export const SEND_HIGH_WATER = 4 * 1024 * 1024;
const RESUME_POLL_MS = 50;

export type ServerFrame =
  | { t: 'ready'; replay: string; cols: number; rows: number }
  | { t: 'output'; data: string }
  | { t: 'exit'; code: number }
  | { t: 'pong' }
  | { t: 'error'; message: string };

/** The attached client, as the session store needs to see it. */
export interface TermClient {
  /** Bytes queued to this client; drives the pty pause/resume backpressure. */
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  send(frame: ServerFrame): void;
  /** Graceful close, e.g. after telling a client it lost the shell. */
  close(): void;
  /**
   * Hard-drop a client that stopped answering pings. A graceful close would
   * wait for a handshake that a dead socket never sends.
   */
  terminate(): void;
}

interface Session {
  pty: IPty;
  replay: string;
  attached: TermClient | null;
  lastDetachedAt: number;
  lastSeenAt: number;
  paused: boolean;
}

export interface SessionStoreOptions {
  /** Injectable for tests; defaults to a real node-pty spawn. */
  spawnPty?: (cwd: string, cols: number, rows: number) => IPty;
  now?: () => number;
  log?: Pick<Console, 'log' | 'error'>;
}

export interface AttachResult {
  replay: string;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? console;
  const spawnPty = options.spawnPty ?? defaultSpawnPty;

  function spawn(key: string, cwd: string, cols: number, rows: number): Session | null {
    let child: IPty;
    try {
      child = spawnPty(cwd, cols, rows);
    } catch (err) {
      log.error(`[terminal] failed to spawn session (${key}): ${(err as Error).message}`);
      return null;
    }
    const at = now();
    const session: Session = {
      pty: child,
      replay: '',
      attached: null,
      lastDetachedAt: at,
      lastSeenAt: at,
      paused: false,
    };
    sessions.set(key, session);
    log.log(`[terminal] session spawned (${key})`);

    child.onData((data) => {
      session.replay += data;
      if (session.replay.length > REPLAY_CAP) session.replay = trimReplay(session.replay);
      const client = session.attached;
      if (client && client.isOpen) {
        client.send({ t: 'output', data });
        // Backpressure: if the client can't keep up, stop the shell rather
        // than letting the OS/Node send buffer grow without bound.
        if (!session.paused && client.bufferedAmount > SEND_HIGH_WATER) {
          session.paused = true;
          safe(() => child.pause());
          pumpResume(session, client);
        }
      }
    });
    child.onExit(({ exitCode }) => {
      // Ignore exits from ptys we already replaced (restart) or reaped.
      if (sessions.get(key) !== session) return;
      sessions.delete(key);
      log.log(`[terminal] session exited (${key}, code ${exitCode})`);
      // The client stays connected so it can offer a restart UI.
      if (session.attached?.isOpen) session.attached.send({ t: 'exit', code: exitCode });
    });
    return session;
  }

  // Resume a paused pty once its client's send buffer drains — or immediately
  // if the client has since detached (its output just accumulates in replay).
  function pumpResume(session: Session, client: TermClient): void {
    const check = (): void => {
      const gone = session.attached !== client || !client.isOpen;
      if (gone || client.bufferedAmount < SEND_HIGH_WATER / 2) {
        if (session.paused) {
          session.paused = false;
          safe(() => session.pty.resume());
        }
        return;
      }
      setTimeout(check, RESUME_POLL_MS).unref?.();
    };
    setTimeout(check, RESUME_POLL_MS).unref?.();
  }

  return {
    /**
     * Attach `client` to the session for `key`, spawning one if needed. An
     * already-attached client is told why it lost the shell and dropped.
     * Returns null when the pty could not be spawned.
     */
    attach(key: string, client: TermClient, cwd: string, cols: number, rows: number): AttachResult | null {
      let session = sessions.get(key);
      if (session) {
        // Takeover: the newest connection wins; the old client learns why.
        const old = session.attached;
        if (old && old !== client && old.isOpen) {
          old.send({ t: 'error', message: 'Terminal opened elsewhere' });
          old.close();
        }
        session.attached = client;
        session.lastSeenAt = now();
        safe(() => session!.pty.resize(cols, rows));
      } else {
        const fresh = spawn(key, cwd, cols, rows);
        if (!fresh) return null;
        fresh.attached = client;
        session = fresh;
      }
      return { replay: session.replay };
    },

    /** Any frame from the client proves it is alive; keeps the reaper away. */
    markSeen(key: string, client: TermClient): void {
      const session = sessions.get(key);
      if (session && session.attached === client) session.lastSeenAt = now();
    },

    write(key: string, client: TermClient, data: string): void {
      const session = sessions.get(key);
      // Only the attached client may drive the session.
      if (!session || session.attached !== client) return;
      session.pty.write(data);
    },

    resize(key: string, client: TermClient, cols: number, rows: number): void {
      const session = sessions.get(key);
      if (!session || session.attached !== client) return;
      safe(() => session.pty.resize(cols, rows));
    },

    /** Kill the shell (if any) and spawn a fresh one attached to `client`. */
    restart(key: string, client: TermClient, cwd: string, cols: number, rows: number): AttachResult | null {
      const current = sessions.get(key);
      if (current) {
        if (current.attached !== client) return null;
        current.attached = null; // stop the dying pty's late output reaching this client
        sessions.delete(key); // before kill, so onExit's guard skips it
        safe(() => current.pty.kill());
      }
      const fresh = spawn(key, cwd, cols, rows);
      if (!fresh) return null;
      fresh.attached = client;
      return { replay: fresh.replay };
    },

    detach(key: string, client: TermClient): void {
      const session = sessions.get(key);
      if (session && session.attached === client) {
        session.attached = null;
        session.lastDetachedAt = now();
      }
    },

    /** One reaper pass: drop silent clients, kill long-detached shells. */
    reap(): void {
      const at = now();
      for (const [key, session] of sessions) {
        // A silently-dead client never fires 'close', so its pty would never
        // become reap-eligible. Force-detach once the client goes quiet.
        if (session.attached) {
          if (at - session.lastSeenAt > STALE_ATTACHED_MS) {
            const dead = session.attached;
            session.attached = null;
            session.lastDetachedAt = at;
            if (session.paused) {
              session.paused = false;
              safe(() => session.pty.resume());
            }
            dead.terminate();
          }
          continue;
        }
        if (at - session.lastDetachedAt > REAP_DETACHED_AFTER_MS) {
          sessions.delete(key);
          safe(() => session.pty.kill());
          log.log(`[terminal] session reaped after long detach (${key})`);
        }
      }
    },

    /** Test/introspection helper: how many shells are alive. */
    size(): number {
      return sessions.size;
    },

    killAll(): void {
      for (const [, session] of sessions) safe(() => session.pty.kill());
      sessions.clear();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

function defaultSpawnPty(cwd: string, cols: number, rows: number): IPty {
  // Lazily require node-pty so loading this module never pulls the native
  // addon in (same pattern as claude/setupToken.ts nodePtySpawner).
  const pty = require('node-pty') as typeof import('node-pty');
  const shell = process.env.SHELL || '/bin/bash';
  return pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      // The browser terminal is the owner's own shell on this machine, so it
      // gets the login environment: `-l` then sources the real login profile
      // and git/gh/ssh find the machine's credentials. Pro's provider
      // directories stay pinned, so a `claude` or `codex` typed here still
      // works on Pro's profile rather than starting an empty one.
      ...agentEnv(true),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Settings → Doppler owns this dedicated CLI scope. Disconnect can
      // therefore remove every cached credential/fallback without touching
      // a user's unrelated global Doppler configuration.
      DOPPLER_CONFIG_DIR: dopplerCliConfigDir(),
    },
  });
}

// Trim the replay ring from the front, then nudge the cut to the next line
// boundary so a reattach never starts mid escape-sequence (which would print
// as garbage or swallow real output).
export function trimReplay(replay: string): string {
  let cut = replay.length - REPLAY_CAP;
  const nl = replay.indexOf('\n', cut);
  if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
  return replay.slice(cut);
}

/** pty calls throw once the process is mid-exit; that is never fatal here. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* pty already gone */
  }
}
