import crypto from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow, UserRow } from '../db/db.js';
import { canViewConversation } from '../conversations/access.js';
import { timezone } from './routines.js';

const time = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  .nullable();
export const NotificationPreference = z
  .object({
    input: z.boolean(),
    blocked: z.boolean(),
    completed: z.boolean(),
    quiet_start: time,
    quiet_end: time,
    timezone,
  })
  .strict()
  .refine(
    (p) => (p.quiet_start === null) === (p.quiet_end === null),
    'Set both quiet-hour times',
  );
export type Preference = z.infer<typeof NotificationPreference>;
export function inQuietHours(
  p: Pick<Preference, 'quiet_start' | 'quiet_end' | 'timezone'>,
  now = new Date(),
) {
  if (!p.quiet_start || !p.quiet_end || p.quiet_start === p.quiet_end)
    return false;
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: p.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return p.quiet_start < p.quiet_end
    ? t >= p.quiet_start && t < p.quiet_end
    : t >= p.quiet_start || t < p.quiet_end;
}
export function allowedPushEndpoint(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === 'fcm.googleapis.com' ||
        u.hostname === 'updates.push.services.mozilla.com' ||
        u.hostname.endsWith('.notify.windows.com') ||
        u.hostname === 'web.push.apple.com' ||
        u.hostname.endsWith('.push.apple.com'))
    );
  } catch {
    return false;
  }
}
export const Subscription = z
  .object({
    endpoint: z
      .string()
      .max(4000)
      .refine(allowedPushEndpoint, 'Unsupported push service'),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
  })
  .strict();
export function pushKeys(ctx: AppContext) {
  let raw = ctx.secrets.getApiKeyOverride('bot-push-vapid');
  if (!raw) {
    ctx.secrets.setApiKeyOverride(
      'bot-push-vapid',
      JSON.stringify(webpush.generateVAPIDKeys()),
    );
    raw = ctx.secrets.getApiKeyOverride('bot-push-vapid');
  }
  return JSON.parse(raw!) as { publicKey: string; privateKey: string };
}
export function subscribeDevice(
  ctx: AppContext,
  user: UserRow,
  input: unknown,
) {
  const sub = Subscription.parse(input),
    hash = crypto.createHash('sha256').update(sub.endpoint).digest('hex');
  const old = ctx.db
    .prepare('SELECT id,user_id FROM bot_push_devices WHERE endpoint_hash=?')
    .get(hash) as { id: string; user_id: number } | undefined;
  const id = old?.id ?? crypto.randomUUID();
  // A device signing into another account must not keep the former account's notifications.
  if (old && old.user_id !== user.id)
    ctx.db.prepare('DELETE FROM bot_push_devices WHERE id=?').run(id);
  ctx.secrets.setApiKeyOverride(`bot-push-device-${id}`, JSON.stringify(sub));
  ctx.db
    .prepare(
      'INSERT OR IGNORE INTO bot_push_devices(id,user_id,endpoint_hash) VALUES(?,?,?)',
    )
    .run(id, user.id, hash);
  return id;
}
export function queueNotification(
  ctx: AppContext,
  conversationId: string,
  key: string,
  kind: 'input' | 'blocked' | 'completed',
  href: string,
  at = new Date().toISOString(),
) {
  const rows = ctx.db
    .prepare(
      `SELECT d.id FROM bot_push_devices d JOIN bot_notification_preferences p ON p.user_id=d.user_id WHERE p.conversation_id=? AND p.${kind}=1 AND julianday(p.created_at)<=julianday(?) AND julianday(d.created_at)<=julianday(?)`,
    )
    .all(conversationId, at, at) as { id: string }[];
  for (const d of rows)
    ctx.db
      .prepare(
        'INSERT OR IGNORE INTO bot_notification_outbox(id,device_id,conversation_id,event_key,kind,href,next_attempt_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        crypto.randomUUID(),
        d.id,
        conversationId,
        key,
        kind,
        href,
        new Date().toISOString(),
      );
}
export async function tickNotifications(
  ctx: AppContext,
  send = webpush.sendNotification,
  now = new Date(),
) {
  // Decision versions/updates are durable, so a web restart cannot lose an approval notification.
  for (const d of ctx.db
    .prepare(
      "SELECT id,conversation_id,version,state,updated_at FROM bot_decisions WHERE state IN ('needs_input','blocked','failed','verified_completed') AND julianday(updated_at)>julianday('now','-1 day')",
    )
    .all() as {
    id: string;
    conversation_id: string;
    version: number;
    state: string;
    updated_at: string;
  }[]) {
    const kind =
      d.state === 'needs_input'
        ? 'input'
        : d.state === 'verified_completed'
          ? 'completed'
          : 'blocked';
    queueNotification(
      ctx,
      d.conversation_id,
      `decision:${d.id}:${d.version}:${d.state}:${d.updated_at}`,
      kind,
      `#/bots/${encodeURIComponent(d.id)}`,
      d.updated_at,
    );
  }
  const due = ctx.db
    .prepare(
      'SELECT o.*,d.user_id FROM bot_notification_outbox o JOIN bot_push_devices d ON d.id=o.device_id WHERE o.sent_at IS NULL AND o.abandoned=0 AND o.next_attempt_at<=? ORDER BY o.next_attempt_at LIMIT 30',
    )
    .all(now.toISOString()) as {
    id: string;
    device_id: string;
    conversation_id: string;
    user_id: number;
    kind: 'input' | 'blocked' | 'completed';
    href: string;
    attempts: number;
  }[];
  for (const o of due) {
    const c = ctx.db
      .prepare('SELECT * FROM conversations WHERE id=?')
      .get(o.conversation_id) as ConversationRow | undefined;
    const user = ctx.db
      .prepare('SELECT * FROM users WHERE id=?')
      .get(o.user_id) as UserRow | undefined;
    const p = ctx.db
      .prepare(
        'SELECT * FROM bot_notification_preferences WHERE user_id=? AND conversation_id=?',
      )
      .get(o.user_id, o.conversation_id) as Preference | undefined;
    if (
      !c ||
      !user ||
      !p ||
      !p[o.kind] ||
      !canViewConversation(user, c, ctx.db)
    ) {
      ctx.db
        .prepare('UPDATE bot_notification_outbox SET abandoned=1 WHERE id=?')
        .run(o.id);
      continue;
    }
    if (inQuietHours(p, now)) {
      ctx.db
        .prepare(
          'UPDATE bot_notification_outbox SET next_attempt_at=? WHERE id=?',
        )
        .run(new Date(now.getTime() + 60000).toISOString(), o.id);
      continue;
    }
    const raw = ctx.secrets.getApiKeyOverride(`bot-push-device-${o.device_id}`);
    if (!raw) {
      ctx.db
        .prepare('DELETE FROM bot_push_devices WHERE id=?')
        .run(o.device_id);
      continue;
    }
    try {
      const subscription = Subscription.parse(JSON.parse(raw));
      await send(
        subscription,
        JSON.stringify({
          title: 'Veneer',
          body:
            o.kind === 'input'
              ? 'A bot needs your input.'
              : o.kind === 'blocked'
                ? 'A bot needs help to continue.'
                : 'A bot has finished work.',
          href: o.href,
          tag: o.id,
        }),
        {
          vapidDetails: { subject: 'https://veneer.app', ...pushKeys(ctx) },
          TTL: 3600,
          timeout: 10000,
        },
      );
      ctx.db
        .prepare('UPDATE bot_notification_outbox SET sent_at=? WHERE id=?')
        .run(now.toISOString(), o.id);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        ctx.db
          .prepare('DELETE FROM bot_push_devices WHERE id=?')
          .run(o.device_id);
        ctx.secrets.clearApiKeyOverride(`bot-push-device-${o.device_id}`);
      } else
        ctx.db
          .prepare(
            'UPDATE bot_notification_outbox SET attempts=attempts+1,abandoned=?,next_attempt_at=? WHERE id=?',
          )
          .run(
            o.attempts >= 7 ? 1 : 0,
            new Date(
              now.getTime() + Math.min(3600000, 30000 * 2 ** o.attempts),
            ).toISOString(),
            o.id,
          );
    }
  }
}
