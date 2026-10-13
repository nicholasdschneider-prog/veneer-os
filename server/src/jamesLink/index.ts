import type { AppContext } from '../context.js';
import type { ConversationEvent } from '../runtime/events.js';
import { createConnectorMailer } from './mail.js';
import { backfillThreads, getState, setState } from './registry.js';
import { createJamesRouter } from './routes.js';
import { JamesLink } from './service.js';

const TICK_MS = 60_000;

let current: JamesLink | null = null;
/** The running link in this web process, for the agent notify routes. */
export const currentJamesLink = () => current;

/** Wire the James link into the web service: registry backfill, bus stamping, the minute tick, and the API router. */
export function startJamesLink(ctx: AppContext) {
  const db = ctx.db;
  if (!getState(db, 'backfill_v1')) {
    const count = backfillThreads(db);
    setState(db, 'backfill_v1', new Date().toISOString());
    console.log(`[james-link] backfilled ${count} threads`);
  }
  const getSecret = (name: string) => ctx.doppler.get(name);
  const ownerId = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() as { id: number }).id;
  const link = new JamesLink({
    db,
    getSecret,
    fetch,
    mailer: createConnectorMailer(ctx, () => {
      const value = Number(getState(db, 'gmail_connector_id'));
      return Number.isInteger(value) && value > 0 ? value : null;
    }),
    now: () => Date.now(),
    publicOrigin: ctx.config.appPublicOrigin ?? null,
    postToChat: async (conversationId, text) => ctx.manager.postMessage(conversationId, text, ownerId()),
    statusOf: (conversationId) => ctx.manager.statusOf(conversationId),
    log: (message) => console.warn(message),
  });
  current = link;
  const onEvent = (conversationId: string, event: ConversationEvent) => link.onEvent(conversationId, event);
  ctx.manager.bus.on('event', onEvent);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void link.tick().catch((err: Error) => console.warn('[james-link] tick failed:', err.message)).finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return {
    link,
    router: createJamesRouter(db, link, getSecret, {
      list: () => ctx.manager.listBuildQueue(),
      move: (jobId, target, actor) => ctx.manager.moveBuild(jobId, target, actor),
      ownerId,
    }),
    stop() { clearInterval(timer); ctx.manager.bus.off('event', onEvent); if (current === link) current = null; },
  };
}
