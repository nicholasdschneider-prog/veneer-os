// Read-only adoption verification. No migrations, writes to the live DB, or provider/customer calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const load = createRequire(path.join(root, 'server/package.json'));
const Database = load('better-sqlite3');
const db = new Database(process.argv[2] ?? path.join(os.homedir(), '.local/share/veneer-pro/veneer-pro.db'), { readonly: true, fileMustExist: true });
const out = path.join(root, 'docs/reports/business-fleets');
try {
  const before = JSON.parse(fs.readFileSync(path.join(out, 'adoption-before.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(out, 'ervp-enrollment.json'), 'utf8'));
  const team = db.prepare("SELECT id,name,owner_id FROM business_teams WHERE name='ERVP' AND owner_id=1").get();
  assert.ok(team, 'ERVP team exists');
  const members = db.prepare('SELECT b.conversation_id,r.name,b.role,b.subteam,b.reports_to,r.active FROM business_bot_members b JOIN bot_registrations r ON r.conversation_id=b.conversation_id WHERE b.team_id=? ORDER BY b.conversation_id').all(team.id);
  const ordered = expected.toSorted((a,b) => a.conversation_id.localeCompare(b.conversation_id));
  assert.deepEqual(members, ordered.map(b => ({ ...b, active: 1 })), 'Exact13 membership, names, role and hierarchy');
  const after = before.map(prior => {
    const row = db.prepare('SELECT id,title,user_id,project_id,provider,model,effort,channel,archived,visibility,assistant_id,native_session_id FROM conversations WHERE id=?').get(prior.id);
    row.native_session_sha256 = crypto.createHash('sha256').update(row.native_session_id).digest('hex'); delete row.native_session_id;
    assert.deepEqual(row, prior, `Native identity/model/project metadata unchanged for ${prior.id}`);
    return row;
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business_team_members WHERE team_id=?').get(team.id).n, 0, 'No employee grants');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM business_teams WHERE name LIKE '%BulkBid%'").get().n, 0, 'No BulkBid adoption');
  const receipts = db.prepare('SELECT id,actor_id,actor_chat,applied_at FROM business_previews WHERE team_id=? AND applied_at IS NOT NULL').all(team.id);
  assert.equal(receipts.length, 1, 'Exactly one applied preview');
  assert.equal(receipts[0].actor_chat, '2c5de4ad-00b4-4be2-abf7-25f34eb787a3', 'Henry native actor performed enrollment');
  const audit = db.prepare('SELECT actor_id,actor_chat,action,created_at FROM business_audit WHERE team_id=? ORDER BY id').all(team.id);
  const result = { verified_at: new Date().toISOString(), team, members, identities: after, receipts, audit, verification: 'Exact13; native session hashes, titles, models, effort, provider, ownership and projects unchanged; no employee grants or BulkBid adoption.' };
  fs.writeFileSync(path.join(out, 'adoption-after.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(result.verification);
  console.log(`Henry applied preview ${receipts[0].id}; team ${team.id}.`);
} finally { db.close(); }
