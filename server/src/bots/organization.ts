import type Database from "better-sqlite3";
import { z } from "zod";
import { BotError, createBotService } from "./service.js";
import type { UserRow, ConversationRow } from "../db/db.js";
const id = z.string().min(1).max(200);
const definition = z.object({
  groups: z
    .array(z.object({ id, name: z.string().trim().min(1).max(80) }))
    .max(100),
  placements: z.record(id, z.string().max(200)),
  fallback: z.string().trim().min(1).max(80).nullable(),
});
export type Organization = z.infer<typeof definition> & { revision: number };
export function createOrganizationService(db: Database.Database) {
  const bots = createBotService(db);
  function visible(user: UserRow, scope: string) {
    return (
      db
        .prepare(
          "SELECT c.* FROM conversations c JOIN bot_registrations b ON b.conversation_id=c.id WHERE b.active=1",
        )
        .all() as ConversationRow[]
    ).filter((c) => {
      try {
        bots.chat({ user }, c.id);
        return !scope || c.business_team_id === scope;
      } catch {
        return false;
      }
    });
  }
  function get(user: UserRow, scope: string): Organization {
    const allowed = new Set(visible(user, scope).map((c) => c.id));
    const row = db
      .prepare(
        "SELECT revision,definition FROM chat_organization WHERE user_id=? AND scope=?",
      )
      .get(user.id, scope) as
      { revision: number; definition: string } | undefined;
    if (row) {
      const d = definition.parse(JSON.parse(row.definition));
      return {
        ...d,
        revision: row.revision,
        placements: Object.fromEntries(
          Object.entries(d.placements).filter(([key]) => allowed.has(key)),
        ),
      };
    }
    const groups: Organization["groups"] = [],
      placements: Record<string, string> = {};
    for (const c of visible(user, scope)) {
      const m = db
        .prepare(
          "SELECT subteam FROM business_bot_members WHERE conversation_id=?",
        )
        .get(c.id) as { subteam: string } | undefined;
      const name = m?.subteam?.trim();
      if (!name) continue;
      const key = "seed:" + name;
      if (!groups.some((g) => g.id === key)) groups.push({ id: key, name });
      placements[c.id] = key;
    }
    return { groups, placements, fallback: "Unassigned", revision: 0 };
  }
  return {
    get,
    save(user: UserRow, scope: string, input: unknown) {
      const parsed = z
        .object({ expected_revision: z.number().int().min(0), definition })
        .parse(input);
      return db.transaction(() => {
        const current = get(user, scope);
        if (current.revision !== parsed.expected_revision)
          throw new BotError(
            409,
            "Organization changed. Reload and try again.",
          );
        const d = parsed.definition,
          ids = new Set(d.groups.map((g) => g.id));
        if (ids.size !== d.groups.length)
          throw new BotError(400, "Group identifiers must be unique");
        const allowed = new Set(visible(user, scope).map((c) => c.id));
        for (const [c, g] of Object.entries(d.placements)) {
          if (!allowed.has(c))
            throw new BotError(403, "Bot is not available in this business");
          if (g && !ids.has(g)) throw new BotError(400, "Unknown group");
        }
        db.prepare(
          "INSERT INTO chat_organization(user_id,scope,revision,definition) VALUES(?,?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET revision=excluded.revision,definition=excluded.definition",
        ).run(user.id, scope, current.revision + 1, JSON.stringify(d));
        return get(user, scope);
      })();
    },
  };
}
export function latestBotPreview(
  db: Database.Database,
  conversationId: string,
) {
  const row = db
    .prepare(
      "SELECT substr(body,1,800) text,at FROM bot_search_documents WHERE conversation_id=? AND kind='assistant' ORDER BY at DESC,rowid DESC LIMIT 1",
    )
    .get(conversationId) as { text: string; at: string } | undefined;
  if (!row) return null;
  return {
    text: row.text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/[`#*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240),
    at: row.at,
  };
}
