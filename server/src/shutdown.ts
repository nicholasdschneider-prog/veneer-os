import type http from 'node:http';

/**
 * Graceful drain-and-exit, shared by all three Veneer Pro services.
 *
 * A restart is "exit 0 and let the supervisor respawn us" — systemd
 * `Restart=always` on Linux, launchd `KeepAlive` on macOS. That keeps the
 * restart mechanism identical on both platforms, with no `systemctl` in
 * application code.
 *
 * Exiting mid-write is not acceptable, so we drain first: stop accepting new
 * connections, let in-flight HTTP requests finish, and only then release
 * in-process resources (agent children, then the SQLite handle). Long-lived
 * sockets — WebSockets for chat/terminal/desktop — are not "in-flight work";
 * they are force-closed and the browser reconnects after respawn.
 */

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface ServiceShutdown {
  /** Drain HTTP, release resources, exit 0. Idempotent: later calls are no-ops. */
  drainAndExit(reason: string): void;
}

export function createShutdown({
  name,
  server,
  release,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
}: {
  /** Log prefix, e.g. 'veneer-pro-runner'. */
  name: string;
  server: http.Server;
  /**
   * Release in-process resources once HTTP has drained. Close the database
   * LAST — nothing may still be writing to it when it goes.
   */
  release: () => void;
  drainTimeoutMs?: number;
}): ServiceShutdown {
  let inFlight = 0;
  server.on('request', (_req, res) => {
    inFlight += 1;
    res.on('close', () => {
      inFlight -= 1;
    });
  });

  let draining = false;
  async function drain(reason: string): Promise<void> {
    console.log(`[${name}] draining (${reason})`);
    server.close();
    // Idle keep-alive sockets hold nothing; drop them so they can't outlive us.
    server.closeIdleConnections();

    const deadline = Date.now() + drainTimeoutMs;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (inFlight > 0) {
      console.warn(`[${name}] drain timed out with ${inFlight} request(s) in flight`);
    }
    // WebSockets and any straggling request sockets.
    server.closeAllConnections();

    try {
      release();
    } catch (err) {
      console.error(`[${name}] shutdown error: ${(err as Error).message}`);
    }
    console.log(`[${name}] exiting 0; supervisor will respawn`);
    process.exit(0);
  }

  return {
    drainAndExit(reason: string): void {
      if (draining) return;
      draining = true;
      void drain(reason);
    },
  };
}
