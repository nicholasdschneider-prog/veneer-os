/**
 * Theme system. A theme is a named set of CSS token overrides in styles.css,
 * keyed off `data-theme` on <html>. The separate color-mode setting follows
 * the device or forces the default theme to light or dark.
 *
 * The choices are per-device (localStorage), applied pre-paint by a tiny inline
 * script in index.html that mirrors the storage keys — keep the two in sync.
 *
 * Adding a theme: add a block in styles.css (`:root[data-theme='<id>'] { … }`),
 * an entry in THEMES here, and — if it's a dark theme — extend the
 * `@custom-variant dark` selector list in styles.css so `dark:` utilities apply.
 */
export type ThemeId = 'default' | 'terminal';
export type ColorMode = 'system' | 'light' | 'dark';

export interface ThemeDef {
  id: ThemeId;
  label: string;
  description: string;
  /**
   * 'system' themes restyle colors only and follow the device light/dark
   * setting; 'dark'/'light' themes force a scheme and may also restyle
   * typography, shape, chrome and controls (see the layer list in styles.css).
   */
  appearance: 'system' | 'dark' | 'light';
  /**
   * Fixed browser-chrome color (the theme-color meta) for themes that don't
   * follow the device scheme; null = keep the light/dark media defaults.
   */
  themeColor: string | null;
  /** Swatch colors (background, text, accent) for the Settings picker. */
  preview: [string, string, string];
  /** Short trait chips shown in the picker (what the theme changes). */
  tags: string[];
}

export const THEMES: ThemeDef[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Clean and neutral with serif prose.',
    appearance: 'system',
    themeColor: null,
    preview: ['#fafafa', '#27282b', '#7b7062'],
    tags: ['neutral', 'serif prose'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'The full IDE treatment, in the style of VS Code: monospace type, compact chrome, square controls.',
    appearance: 'dark',
    themeColor: '#101014',
    preview: ['#101014', '#c9d1d9', '#1f6feb'],
    tags: ['always dark', 'monospace', 'compact'],
  },
];

const THEME_STORAGE_KEY = 'vp-theme';
const COLOR_MODE_STORAGE_KEY = 'vp-color-mode';

// index.html ships light/dark theme-color metas; remember their defaults so
// switching back to 'default' restores media-based behavior.
const META_DEFAULTS: Record<string, string> = {
  '(prefers-color-scheme: light)': '#fafafa',
  '(prefers-color-scheme: dark)': '#191c21',
};

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function getTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    /* private mode etc. — fall through */
  }
  return 'default';
}

export function getColorMode(): ColorMode {
  try {
    const stored = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* private mode etc. — fall through */
  }
  return 'system';
}

function syncThemeColor(theme: ThemeDef, colorMode: ColorMode): void {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    const fallback = META_DEFAULTS[meta.media] ?? meta.content;
    const forcedColor = colorMode === 'light' ? META_DEFAULTS['(prefers-color-scheme: light)']
      : colorMode === 'dark' ? META_DEFAULTS['(prefers-color-scheme: dark)']
        : null;
    meta.content = theme.themeColor ?? forcedColor ?? fallback;
  });
}

export function applyTheme(id: ThemeId): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;

  if (theme.id === 'default') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.id;

  syncThemeColor(theme, getColorMode());

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    /* non-fatal: theme just won't persist */
  }
}

export function applyColorMode(mode: ColorMode): void {
  if (mode === 'system') delete document.documentElement.dataset.colorMode;
  else document.documentElement.dataset.colorMode = mode;

  const theme =
    THEMES.find((item) => item.id === document.documentElement.dataset.theme) ?? THEMES[0]!;
  syncThemeColor(theme, mode);

  try {
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
  } catch {
    /* non-fatal: color mode just won't persist */
  }
}
