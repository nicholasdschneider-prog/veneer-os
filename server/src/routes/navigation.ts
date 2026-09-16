import type Database from 'better-sqlite3';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const NAVIGATION_SETTINGS_KEY = 'workspace_navigation';

export const BUILTIN_NAVIGATION_KEYS = ['automations', 'todos', 'pages', 'apps', 'terminal'] as const;
export const MINI_APP_ICON_KEYS = ['app', 'chart', 'table', 'calendar', 'list', 'star'] as const;

const BuiltinItemSchema = z.object({
  kind: z.literal('builtin'),
  key: z.enum(BUILTIN_NAVIGATION_KEYS),
  visible: z.boolean(),
});

const MiniAppItemSchema = z.object({
  kind: z.literal('app'),
  appId: z.string().min(1).max(100),
  visible: z.boolean(),
  icon: z.enum(MINI_APP_ICON_KEYS),
  label: z.string().trim().min(1).max(32).nullable().optional(),
  // GET responses include the current app title. Accept and discard it when
  // the browser sends that response back after reordering the list.
  title: z.string().optional(),
});

const NavigationSchema = z.object({
  items: z.array(z.discriminatedUnion('kind', [BuiltinItemSchema, MiniAppItemSchema])).max(64),
});

export type BuiltinNavigationKey = (typeof BUILTIN_NAVIGATION_KEYS)[number];
export type MiniAppIconKey = (typeof MINI_APP_ICON_KEYS)[number];
export type NavigationItem =
  | { kind: 'builtin'; key: BuiltinNavigationKey; visible: boolean }
  | { kind: 'app'; appId: string; visible: boolean; icon: MiniAppIconKey; label: string | null };
export type NavigationSettings = { items: NavigationItem[] };

const DEFAULT_NAVIGATION: NavigationSettings = {
  items: [
    { kind: 'builtin', key: 'automations', visible: true },
    { kind: 'builtin', key: 'todos', visible: true },
    { kind: 'builtin', key: 'pages', visible: true },
    { kind: 'builtin', key: 'apps', visible: true },
    { kind: 'builtin', key: 'terminal', visible: false },
  ],
};

function normalizeNavigation(input: z.infer<typeof NavigationSchema>): NavigationSettings {
  const items: NavigationItem[] = [];
  const builtins = new Set<BuiltinNavigationKey>();
  const apps = new Set<string>();

  for (const item of input.items) {
    if (item.kind === 'builtin') {
      if (builtins.has(item.key)) continue;
      builtins.add(item.key);
      items.push({ kind: 'builtin', key: item.key, visible: item.visible });
      continue;
    }
    if (apps.has(item.appId)) continue;
    apps.add(item.appId);
    items.push({
      kind: 'app',
      appId: item.appId,
      visible: item.visible,
      icon: item.icon,
      label: item.label?.trim() || null,
    });
  }

  for (const defaultItem of DEFAULT_NAVIGATION.items) {
    if (defaultItem.kind === 'builtin' && !builtins.has(defaultItem.key)) items.push({ ...defaultItem });
  }
  return { items };
}

export function readNavigationSettings(db: Database.Database): { configured: boolean; navigation: NavigationSettings } {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(NAVIGATION_SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { configured: false, navigation: structuredClone(DEFAULT_NAVIGATION) };
  try {
    const parsed = NavigationSchema.safeParse(JSON.parse(row.value_json));
    if (parsed.success) return { configured: true, navigation: normalizeNavigation(parsed.data) };
  } catch {
    // A corrupt preference must not remove the primary navigation.
  }
  return { configured: true, navigation: structuredClone(DEFAULT_NAVIGATION) };
}

export function writeNavigationSettings(db: Database.Database, navigation: NavigationSettings): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(NAVIGATION_SETTINGS_KEY, JSON.stringify(navigation));
}

export function removeMiniAppFromNavigation(db: Database.Database, appId: string): void {
  const current = readNavigationSettings(db);
  if (!current.configured) return;
  const items = current.navigation.items.filter((item) => item.kind !== 'app' || item.appId !== appId);
  if (items.length !== current.navigation.items.length) writeNavigationSettings(db, { items });
}

function navigationView(db: Database.Database, navigation: NavigationSettings) {
  const titles = new Map(
    (db.prepare('SELECT id, title FROM mini_apps').all() as Array<{ id: string; title: string }>).map((app) => [app.id, app.title]),
  );
  const items: Array<NavigationItem | (Extract<NavigationItem, { kind: 'app' }> & { title: string })> = [];
  for (const item of navigation.items) {
    if (item.kind === 'builtin') {
      items.push(item);
      continue;
    }
    const title = titles.get(item.appId);
    if (title) items.push({ ...item, title });
  }
  return { items };
}

export function createNavigationRouter(ctx: AppContext): Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const current = readNavigationSettings(ctx.db);
    res.json({ ok: true, configured: current.configured, navigation: navigationView(ctx.db, current.navigation) });
  });

  router.put('/', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const parsed = NavigationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid navigation settings' });
      return;
    }
    const navigation = normalizeNavigation(parsed.data);
    const appIds = navigation.items.filter((item) => item.kind === 'app').map((item) => item.appId);
    if (appIds.length) {
      const placeholders = appIds.map(() => '?').join(',');
      const found = new Set(
        (ctx.db.prepare(`SELECT id FROM mini_apps WHERE id IN (${placeholders})`).all(...appIds) as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      );
      if (appIds.some((id) => !found.has(id))) {
        res.status(400).json({ ok: false, error: 'Navigation contains an unknown Mini App' });
        return;
      }
    }
    writeNavigationSettings(ctx.db, navigation);
    res.json({ ok: true, configured: true, navigation: navigationView(ctx.db, navigation) });
  });

  return router;
}
