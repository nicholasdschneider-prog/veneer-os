import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function assertRunnerRestartSafe({ targets, dataDir, serverPackage, allowActive = false }) {
  if (!targets.includes('veneer-pro-runner') || allowActive) return;
  const file = path.join(dataDir, 'veneer-pro.db');
  if (!fs.existsSync(file)) return;
  const Database = createRequire(serverPackage)('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const { n } = db.prepare("SELECT COUNT(*) n FROM pending_turns WHERE status='pending'").get();
    if (n) throw new Error(`${n} active turns: runner restart refused. Wait for idle or use --allow-active-turns only for an explicitly authorized interruption. No delayed force-restart fallback.`);
  } finally { db.close(); }
}
