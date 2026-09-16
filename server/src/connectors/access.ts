import type Database from 'better-sqlite3';
import type { UserConnectorRow } from '../db/db.js';

/** Project ids an installation is explicitly assigned to, in project-name order. */
export function connectorProjectIds(db: Database.Database, connectorId: number): string[] {
  return (
    db
      .prepare(
        `SELECT cp.project_id
           FROM user_connector_projects cp
           JOIN projects p ON p.id = cp.project_id
          WHERE cp.connector_id = ?
          ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .all(connectorId) as { project_id: string }[]
  ).map((row) => row.project_id);
}

/**
 * Connected installations available to one conversation turn. User access and
 * project scope are independent: personal installs must belong to the user who
 * initiated this turn, while shared installs are available to everyone. Either
 * type can cover all projects or only the projects in the join table.
 */
export function connectedConnectorRowsForConversation(
  db: Database.Database,
  conversationId: string,
  actorUserId: number | null,
): UserConnectorRow[] {
  return db
    .prepare(
      `SELECT uc.*
         FROM conversations c
         JOIN user_connectors uc ON uc.status = 'connected'
        WHERE c.id = ?
          AND EXISTS (
            SELECT 1 FROM users actor
             WHERE actor.id = ? AND actor.status = 'active'
          )
          AND (uc.sharing = 'shared' OR uc.user_id = ?)
          AND (
            uc.scope_mode = 'all'
            OR (
              c.project_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM user_connector_projects cp
                 WHERE cp.connector_id = uc.id AND cp.project_id = c.project_id
              )
            )
          )
        ORDER BY uc.id`,
    )
    .all(conversationId, actorUserId, actorUserId) as UserConnectorRow[];
}

export function conversationHasConnector(
  db: Database.Database,
  conversationId: string,
  connectorSlug: string,
  actorUserId: number | null,
): boolean {
  return connectedConnectorRowsForConversation(db, conversationId, actorUserId).some(
    (row) => row.connector_slug === connectorSlug,
  );
}
