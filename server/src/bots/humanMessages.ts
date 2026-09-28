import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from './canonical.js';

/** Called only by authenticated human composer ingress, never by agent tools.
 * Capture the message before dispatch so later instructions cannot race an answer.
 * This is evidence of a submission, not a classification or approval. */
export function captureHumanMessage(db: Database.Database, conversationId: string, actorId: number, text: string) {
  const proposals = (db.prepare("SELECT id,version,proposal_json,handling_revision FROM bot_decisions WHERE conversation_id=? AND state='needs_input'").all(conversationId) as {id:string;version:number;proposal_json:string;handling_revision:number}[])
    .map(d => ({id:d.id,version:d.version,proposal_hash:canonicalSha256(JSON.parse(d.proposal_json)),handling_revision:d.handling_revision}));
  const id=crypto.randomUUID();
  db.prepare('INSERT INTO bot_human_messages(id,conversation_id,actor_id,text,proposals_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(id,conversationId,actorId,text,JSON.stringify(proposals),new Date().toISOString());
  return id;
}
