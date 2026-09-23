import type Database from 'better-sqlite3';
import type { RequestHandler } from 'express';

export function isEmployee(db: Database.Database, userId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM employee_workspaces WHERE user_id=?').get(userId));
}

// Restricted employees have a small operational surface. New platform routes are
// denied by default; project files, credentials, tools and admin APIs are not inherited.
export function employeeRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET') return [
    /^\/bot-communication\/(chats\/[^/]+(?:\/threads)?|threads\/[^/]+|briefings\/[^/]+\/audio)\/?$/,
    /^\/bot-workflows\/(guide|search|push|bots\/[^/]+)\/?$/,
    /^\/live-voice\/?$/,
    /^\/bots\/?$/,
    /^\/bots\/teams\/?$/,
    /^\/bots\/decisions\/[^/]+\/?$/,
    /^\/conversations\/?$/,
    /^\/recent-conversations\/?$/,
    /^\/conversations\/[^/]+\/?$/,
    /^\/conversations\/[^/]+\/transcript\/?$/,
    /^\/generated-files(?:\/.*)?$/,
  ].some(pattern => pattern.test(path));
  if (method === 'PUT') return /^\/bot-workflows\/bots\/[^/]+\/notifications\/?$/.test(path);
  if (method === 'DELETE') return /^\/bot-workflows\/push\/[^/]+\/?$/.test(path);
  if (method === 'PATCH') return /^\/bots\/preferences\/[^/]+\/?$/.test(path);
  if (method === 'POST') return [
    /^\/bot-communication\/(drafts\/[^/]+|decisions\/[^/]+\/briefing|briefings\/[^/]+\/audio|chats\/[^/]+\/threads|threads\/[^/]+\/(seen|replies|reactions))\/?$/,
    /^\/bot-workflows\/push\/?$/,
    /^\/live-voice\/calls(?:\/[^/]+\/(?:heartbeat|end))?\/?$/,
    /^\/bots\/decisions\/[^/]+\/(answer|choice|thread|handling|dismiss)\/?$/,
    /^\/conversations\/[^/]+\/messages\/?$/,
  ].some(pattern => pattern.test(path));
  return false;
}

export function employeeApiBoundary(db: Database.Database): RequestHandler {
  return (req, res, next) => {
    if (!isEmployee(db, req.user!.id)) return next();
    if (req.agentConversationId || !employeeRouteAllowed(req.method, req.path)) {
      res.status(403).json({ error: 'This account has access only to its assigned customer service workspace.' });
      return;
    }
    next();
  };
}
