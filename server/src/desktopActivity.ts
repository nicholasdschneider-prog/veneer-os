import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serviceHome } from './homes.js';

// Pro's own state, resolved on use rather than at import: the service env file
// is loaded after this module is evaluated, and both the web routes and an MCP
// child (which for a Full Access agent runs with the login HOME) must land on
// the same directory.
const activityDir = (): string => path.join(serviceHome(), '.veneer-desktop');
const activityFile = (): string => path.join(activityDir(), 'agent-activity.json');

/**
 * A lightweight "an agent just drove the shared desktop" heartbeat, written by
 * the runner-side agent-browser code after each successful shared command and
 * read by the web /activity route so the SPA can auto-pop its live-view thumbnail
 * on the user's phone. Best-effort: it must never fail a browser command, and a
 * missing or corrupt file simply means "no recent activity".
 */
export interface DesktopActivity {
  lastAt: string;
  conversationId: string;
}

export function writeActivity(conversationId: string): void {
  fs.mkdirSync(activityDir(), { recursive: true, mode: 0o700 });
  const tmp = path.join(
    activityDir(),
    '.agent-activity.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp',
  );
  fs.writeFileSync(tmp, JSON.stringify({ lastAt: new Date().toISOString(), conversationId }), { mode: 0o600 });
  fs.renameSync(tmp, activityFile());
}

export function readActivity(): DesktopActivity | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activityFile(), 'utf8')) as Partial<DesktopActivity>;
    if (!parsed || typeof parsed.lastAt !== 'string' || typeof parsed.conversationId !== 'string') return null;
    return { lastAt: parsed.lastAt, conversationId: parsed.conversationId };
  } catch {
    return null;
  }
}
