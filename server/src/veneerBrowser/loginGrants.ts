import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canTrainBusinessBot } from '../conversations/access.js';
import type { ConversationRow } from '../db/db.js';

const origin = z.string().url().refine(value => {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  return u.protocol === 'https:' && u.origin === value && !u.username && !u.password
    && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}, 'Use an exact HTTPS origin');
export const LoginGrantSchema = z.object({
  profileId: z.string().min(1),
  secretProject: z.string().regex(/^[a-z0-9_-]+$/i),
  secretConfig: z.string().regex(/^[a-z0-9_-]+$/i),
  secretName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.enum(['password', 'totp']),
  origins: z.array(origin).min(1).max(8),
  allowSave: z.boolean().default(false),
});
export interface LoginGrant {
  id: number; conversation_id: string; project_id: string; profile_id: string; granted_by: number;
  secret_project: string; secret_config: string; secret_name: string; kind: 'password' | 'totp';
  origins_json: string; allow_save: number;
}

export function activeLoginGrants(db: Database.Database, userId: number, conversationId: string): LoginGrant[] {
  const c = db.prepare('SELECT * FROM conversations WHERE id=? AND archived=0').get(conversationId) as ConversationRow | undefined;
  if (!c || !canTrainBusinessBot({ id: userId }, c, db)) return [];
  return db.prepare(`SELECT g.* FROM browser_login_grants g
    JOIN veneer_browser_conversation_profiles cp ON cp.conversation_id=g.conversation_id AND cp.profile_id=g.profile_id AND cp.project_id=g.project_id
    JOIN veneer_browser_profiles p ON p.id=g.profile_id AND p.owner_user_id=g.granted_by
    JOIN users u ON u.id=g.granted_by AND u.status='active'
    WHERE g.conversation_id=? AND g.project_id=? AND g.granted_by=?
    AND NOT EXISTS (SELECT 1 FROM veneer_browser_clone_sessions s WHERE s.conversation_id=g.conversation_id
      AND (s.mode!='profile' OR s.source_profile_id!=g.profile_id))`).all(conversationId,c.project_id,c.user_id) as LoginGrant[];
}

export function authorizeLoginSecret(db: Database.Database, userId: number, conversationId: string, args: Record<string, unknown>, kind: LoginGrant['kind']): LoginGrant {
  const grant = activeLoginGrants(db,userId,conversationId).find(g => g.kind === kind
    && g.secret_project === args.project && g.secret_config === args.config && g.secret_name === args.secret_name);
  if (!grant) throw new Error('No active browser login grant matches this credential and assigned profile.');
  return grant;
}

/** One synchronous page evaluation: never resolve an @ref against another frame or navigate between validation and filling. */
export function guardedLoginScript(selector: string, value: string, origins: string[], kind: LoginGrant['kind']): string {
  if (!selector || selector.startsWith('@') || selector.length > 500) throw new Error('Granted login filling requires a CSS input selector from the current login page, not an @ref.');
  return `(() => {
    const allowed = ${JSON.stringify(origins)};
    if (window !== window.top || !allowed.includes(location.origin)) throw new Error('Login origin is not approved');
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    if (nodes.length !== 1) throw new Error('Login field must match exactly one input');
    const field = nodes[0];
    if (!(field instanceof HTMLInputElement) || field.ownerDocument !== document || field.disabled || field.readOnly || !field.getClientRects().length) throw new Error('Login field is unavailable');
    if (${JSON.stringify(kind)} === 'password' ? field.type !== 'password' : !['text','tel','number','password'].includes(field.type)) throw new Error('Unexpected login field type');
    if (field.form && !allowed.includes(new URL(field.form.action || location.href, location.href).origin)) throw new Error('Login form destination is not approved');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
    return 'Login field filled';
  })()`;
}
