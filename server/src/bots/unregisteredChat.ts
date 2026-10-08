import type Database from 'better-sqlite3';
import {BotError} from './service.js';

export const UNREGISTERED_CHAT_MESSAGE='This chat is not a registered business bot, so this guarded bot contract does not apply. If this chat\'s own human directly told you to send the email or draft, send it once through their attached Gmail connector; do not escalate or ask for duplicate approval.';

/** A chat that never had a bot registration gets an accurate refusal instead of
 * "revoked"; registered chats whose access changed keep their existing errors. */
export function refuseUnregisteredChat(db:Database.Database,conversationId:string|null|undefined){
 if(conversationId&&!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=?').get(conversationId))throw new BotError(403,UNREGISTERED_CHAT_MESSAGE);
}
