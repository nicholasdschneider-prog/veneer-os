/**
 * Legacy per-device Terminal pin. Workspace navigation replaced this setting;
 * App reads it once during migration, then removes it.
 */
export const TERMINAL_PINNED_KEY = 'veneer:terminal-pinned';

export function isLegacyTerminalPinned(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_PINNED_KEY) === 'true';
  } catch {
    // localStorage unavailable (private mode); fall back to unpinned.
    return false;
  }
}

export function clearLegacyTerminalPin(): void {
  try {
    window.localStorage.removeItem(TERMINAL_PINNED_KEY);
  } catch {
    // A blocked local store leaves no active preference system behind.
  }
}
