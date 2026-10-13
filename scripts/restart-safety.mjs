import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function assertRunnerRestartSafe({ targets, dataDir, serverPackage, allowActive = false, maintenanceApproved = false }) {
  if (!targets.length) return;
  if (!maintenanceApproved) throw new Error('Production restart refused: an explicit human-approved maintenance window is required. Keep serving the current build; batch changes for that window. Use --maintenance-approved only within that approved window.');
  if (allowActive) return;
  const file = path.join(dataDir, 'veneer-pro.db');
  if (!fs.existsSync(file)) return;
  const Database = createRequire(serverPackage)('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const { n } = db.prepare("SELECT COUNT(*) n FROM pending_turns WHERE status='pending'").get();
    if (n) throw new Error(`${n} active turns: production restart refused (including web-only restarts). Wait for idle or use --allow-active-turns only for an explicitly authorized interruption. No delayed force-restart fallback.`);
  } finally { db.close(); }
}
