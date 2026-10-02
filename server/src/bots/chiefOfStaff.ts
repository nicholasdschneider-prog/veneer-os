import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConversationRow } from '../db/db.js';
import { BotError, chiefOfStaffActive, type Actor } from './service.js';

const designationSchema = z
  .object({
    conversation_id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean(),
  })
  .strict();

/** The owner's single cross-business bot. Designation is reach only: it opens
 * the read-only open-question overview and changes no approval, connection or
 * business membership. */
export function createChiefOfStaffService(db: Database.Database) {
  const chat = (id: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow | undefined;
  const slug = (c: ConversationRow) =>
    (db.prepare('SELECT slug FROM assistants WHERE id=?').get(c.assistant_id) as { slug: string } | undefined)?.slug;
  function admin(actor: Actor) {
    if (actor.user.role !== 'owner') throw new BotError(403, 'Only the workspace owner can designate a chief of staff');
    if (!actor.conversationId) return;
    const source = chat(actor.conversationId);
    // Same rule as business management: Platform Dev in the owner's own chat
    // is the only agent that may act here, and its chat is recorded.
    if (!source || source.user_id !== actor.user.id || slug(source) !== 'platform-dev')
      throw new BotError(403, 'Human owner or authenticated owner Platform Dev required');
  }
  const current = (ownerId: number) =>
    db
      .prepare(
        `SELECT s.conversation_id, r.name, s.created_at FROM chief_of_staff_bots s
         LEFT JOIN bot_registrations r ON r.conversation_id=s.conversation_id WHERE s.owner_id=?`,
      )
      .get(ownerId) as { conversation_id: string; name: string | null; created_at: string } | undefined;
  return {
    status(actor: Actor) {
      // Every signed-in human may ask; only an owner can have one.
      if (!actor.conversationId && actor.user.role !== 'owner') return { chief_of_staff: null };
      admin(actor);
      const row = current(actor.user.id);
      if (!row) return { chief_of_staff: null };
      const c = chat(row.conversation_id);
      return { chief_of_staff: { ...row, active: Boolean(c && chiefOfStaffActive(db, c, actor.user.id)) } };
    },
    designate(actor: Actor, raw: unknown) {
      const input = designationSchema.parse(raw);
      admin(actor);
      return db.transaction(() => {
        const c = chat(input.conversation_id);
        if (!c || c.user_id !== actor.user.id) throw new BotError(404, 'Chat not found');
        const audit = (action: 'granted' | 'revoked') =>
          db
            .prepare('INSERT INTO chief_of_staff_audit(conversation_id,owner_id,actor_id,actor_chat,action) VALUES(?,?,?,?,?)')
            .run(c.id, actor.user.id, actor.user.id, actor.conversationId ?? null, action);
        if (!input.enabled) {
          if (db.prepare('DELETE FROM chief_of_staff_bots WHERE conversation_id=?').run(c.id).changes) audit('revoked');
          return { conversation_id: c.id, designated: false };
        }
        if (c.archived || c.channel !== 'web' || slug(c) === 'platform-dev')
          throw new BotError(409, 'Only an active operational chat can be the chief of staff');
        if (c.business_team_id)
          throw new BotError(409, 'A bot enrolled in a business cannot be the chief of staff');
        if (
          db.prepare('SELECT 1 FROM coordination_lanes WHERE conversation_id=?').get(c.id) ||
          db.prepare('SELECT 1 FROM team_room_workers WHERE conversation_id=?').get(c.id)
        )
          throw new BotError(409, 'Only an active operational chat can be the chief of staff');
        const existing = current(actor.user.id);
        if (existing && existing.conversation_id !== c.id)
          throw new BotError(409, 'Another chat is already the chief of staff. Revoke it first.');
        const registration = db.prepare('SELECT name FROM bot_registrations WHERE conversation_id=?').get(c.id) as
          | { name: string }
          | undefined;
        const name = input.name ?? registration?.name;
        if (!name) throw new BotError(400, 'name: Required to register this chat as a bot');
        db.prepare(
          'INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,?) ON CONFLICT(conversation_id) DO UPDATE SET name=excluded.name,active=1',
        ).run(c.id, name, actor.user.id);
        if (db.prepare('INSERT OR IGNORE INTO chief_of_staff_bots(conversation_id,owner_id) VALUES(?,?)').run(c.id, actor.user.id).changes)
          audit('granted');
        return { conversation_id: c.id, designated: true, name };
      })();
    },
  };
}
