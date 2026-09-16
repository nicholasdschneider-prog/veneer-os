import type Database from 'better-sqlite3';
import {
  CloudflareMiniAppDeployer,
  type MiniAppCloudflareConfig,
  type MiniAppDeployment,
} from './cloudflare.js';

export const MINI_APP_WRAPPER_VERSION = 3;
const WRAPPER_VERSIONS_SETTING = 'mini_app_wrapper_versions';

type WrapperVersions = Record<string, number>;

function readVersions(db: Database.Database): WrapperVersions {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(WRAPPER_VERSIONS_SETTING) as
    | { value_json: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function writeVersions(db: Database.Database, versions: WrapperVersions): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(WRAPPER_VERSIONS_SETTING, JSON.stringify(versions));
}

export function markMiniAppWrapperCurrent(db: Database.Database, appId: string): void {
  const versions = readVersions(db);
  if (versions[appId] === MINI_APP_WRAPPER_VERSION) return;
  versions[appId] = MINI_APP_WRAPPER_VERSION;
  writeVersions(db, versions);
}

export function forgetMiniAppWrapper(db: Database.Database, appId: string): void {
  const versions = readVersions(db);
  if (!(appId in versions)) return;
  delete versions[appId];
  writeVersions(db, versions);
}

/** Existing Cloudflare Workers contain a generated platform wrapper, so a
 * Veneer release that changes that wrapper refreshes deployed apps once before
 * the web server accepts requests. App source and stable routes are preserved. */
export async function refreshMiniAppWrappers(
  db: Database.Database,
  config: MiniAppCloudflareConfig,
  request: typeof fetch = fetch,
): Promise<{ updated: number; failed: number }> {
  const versions = readVersions(db);
  const rows = db
    .prepare(
      `SELECT id, slug, script_name, route_id, source_text
       FROM mini_apps WHERE runtime = 'cloudflare' AND status = 'deployed'`,
    )
    .all() as Array<{
      id: string;
      slug: string;
      script_name: string;
      route_id: string | null;
      source_text: string;
    }>;
  const activeIds = new Set(rows.map((row) => row.id));
  for (const appId of Object.keys(versions)) {
    if (!activeIds.has(appId)) delete versions[appId];
  }

  const stale = rows.filter((row) => versions[row.id] !== MINI_APP_WRAPPER_VERSION);
  if (stale.length === 0) {
    writeVersions(db, versions);
    return { updated: 0, failed: 0 };
  }

  const deployer = new CloudflareMiniAppDeployer(config, request);
  const results = await Promise.allSettled(
    stale.map((row) => {
      const app: MiniAppDeployment = {
        id: row.id,
        slug: row.slug,
        scriptName: row.script_name,
        routeId: row.route_id,
        source: row.source_text,
      };
      return deployer.deploy(app);
    }),
  );
  let updated = 0;
  let failed = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      const row = stale[index]!;
      if (row.route_id !== result.value.routeId) {
        db.prepare('UPDATE mini_apps SET route_id = ? WHERE id = ?').run(result.value.routeId, row.id);
      }
      versions[row.id] = MINI_APP_WRAPPER_VERSION;
      updated += 1;
    } else {
      failed += 1;
    }
  }
  writeVersions(db, versions);
  return { updated, failed };
}
