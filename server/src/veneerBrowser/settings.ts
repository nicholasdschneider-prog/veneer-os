import type Database from 'better-sqlite3';

export interface VeneerBrowserSettings {
  quality: number;
  resolution: VeneerBrowserResolution;
}

export const VENEER_BROWSER_RESOLUTIONS = ['standard', 'auto', 'retina'] as const;
export type VeneerBrowserResolution = (typeof VENEER_BROWSER_RESOLUTIONS)[number];
export const VENEER_BROWSER_QUALITY_MIN = 40;
export const VENEER_BROWSER_QUALITY_MAX = 95;
export const DEFAULT_VENEER_BROWSER_SETTINGS: VeneerBrowserSettings = { quality: 80, resolution: 'auto' };
export const VENEER_BROWSER_SETTINGS_KEY = 'veneer_browser_settings';

function normalizedSettings(value: unknown): VeneerBrowserSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_VENEER_BROWSER_SETTINGS };
  }
  const candidate = value as Partial<VeneerBrowserSettings>;
  const parsedQuality = Number(candidate.quality);
  const quality = Number.isInteger(parsedQuality)
    && parsedQuality >= VENEER_BROWSER_QUALITY_MIN
    && parsedQuality <= VENEER_BROWSER_QUALITY_MAX
    ? parsedQuality
    : DEFAULT_VENEER_BROWSER_SETTINGS.quality;
  const resolution = VENEER_BROWSER_RESOLUTIONS.includes(candidate.resolution as VeneerBrowserResolution)
    ? candidate.resolution as VeneerBrowserResolution
    : DEFAULT_VENEER_BROWSER_SETTINGS.resolution;
  return { quality, resolution };
}

export function readVeneerBrowserSettings(db: Database.Database): VeneerBrowserSettings {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(VENEER_BROWSER_SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_VENEER_BROWSER_SETTINGS };
  try {
    return normalizedSettings(JSON.parse(row.value_json));
  } catch {
    return { ...DEFAULT_VENEER_BROWSER_SETTINGS };
  }
}

export function writeVeneerBrowserSettings(
  db: Database.Database,
  settings: VeneerBrowserSettings,
): VeneerBrowserSettings {
  const normalized = normalizedSettings(settings);
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(VENEER_BROWSER_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
