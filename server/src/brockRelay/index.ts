import type { AppContext } from '../context.js';
import { createTicketPoller, MIRROR_SECRET } from '../csTickets/poll.js';
import { readSecretValue } from '../secrets/readSecret.js';
import { createBrockRelay } from './relay.js';
import { createBrockRouter } from './routes.js';

const TICK_MS = 5_000;
const PRUNE_EVERY = 720; // about once an hour

/** Wire the Brock relay into the web service: a 5 s reconcile+send tick and the /api/james/brock router. */
export function startBrockRelay(ctx: AppContext) {
  const getSecret = (name: string) => ctx.doppler.get(name);
  const relay = createBrockRelay({
    db: ctx.db,
    getSecret,
    publicBase: ctx.config.appPublicOrigin ?? null,
    fetch,
    now: () => Date.now(),
    log: (m) => console.warn(m),
  });
  // Ticket-thread files come through the same read-only OrderOps principal as the task pane.
  const mirror = createTicketPoller(ctx.db, {
    readCredential: async () => (await readSecretValue({ db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null }, { name: MIRROR_SECRET.credential, project: MIRROR_SECRET.project, config: MIRROR_SECRET.config })).value,
    log: { info: () => {}, warn: (m) => console.warn(m) },
  });
  let running = false;
  let ticks = 0;
  const run = () => {
    if (running) return;
    running = true;
    if (++ticks % PRUNE_EVERY === 0) { try { relay.prune(); } catch { /* next hour */ } }
    void relay.tick().catch((err: Error) => console.warn('[brock-relay] tick failed:', err.message)).finally(() => { running = false; });
  };
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();
  return {
    relay,
    router: createBrockRouter(ctx, relay, getSecret, mirror),
    stop() { clearInterval(timer); },
  };
}
