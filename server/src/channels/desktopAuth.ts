import type { UserRow } from '../db/db.js';

/**
 * Accept/reject decision for a /ws/desktop upgrade, factored out so it is unit
 * testable without a live socket — and so the VNC and CDP transports cannot
 * drift apart on who is allowed to drive the browser.
 *
 * Full browser control → active owner/consultant only, identical to the
 * terminal gate.
 */
export function desktopUpgradeAllowed(user: UserRow | undefined): boolean {
  return Boolean(user && user.status === 'active' && user.role !== 'member');
}
