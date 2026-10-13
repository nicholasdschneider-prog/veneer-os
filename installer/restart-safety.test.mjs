import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertRunnerRestartSafe } from '../scripts/restart-safety.mjs';

test('protects active turns before a routine restart while allowing web-only and explicit emergency recovery', () => {
  const serverPackage = fileURLToPath(new URL('../server/package.json', import.meta.url));
  const Database = createRequire(serverPackage)('better-sqlite3');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-restart-safety-'));
  const db = new Database(path.join(dataDir,'veneer-pro.db'));
  try {
    db.exec("CREATE TABLE pending_turns(status TEXT); INSERT INTO pending_turns VALUES('failed')");
    const options = {targets:['veneer-pro','veneer-pro-runner'],dataDir,serverPackage};
    assert.doesNotThrow(()=>assertRunnerRestartSafe(options));
    db.exec("INSERT INTO pending_turns VALUES('pending')");
    assert.throws(()=>assertRunnerRestartSafe(options),/1 active turns/);
    assert.doesNotThrow(()=>assertRunnerRestartSafe({...options,targets:['veneer-pro']}));
    assert.doesNotThrow(()=>assertRunnerRestartSafe({...options,allowActive:true}));
    db.exec('DROP TABLE pending_turns');
    assert.throws(()=>assertRunnerRestartSafe(options));
  } finally {db.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
