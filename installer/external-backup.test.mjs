import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createBackup} from './backup.mjs';
test('backup contains relocated transcript content and preserves unrelated links',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'veneer-external-backup-test-'));
 try {
  const data=path.join(root,'data'), external=path.join(root,'external'), backups=path.join(root,'backups');
  fs.mkdirSync(data);fs.mkdirSync(external);
  fs.writeFileSync(path.join(external,'history.jsonl'),'preserved history\n');
  fs.symlinkSync(external,path.join(data,'transcripts'));
  fs.symlinkSync(external,path.join(data,'other-link'));
  const archive=await createBackup({dataDir:data,backupDir:backups});
  const restored=path.join(root,'restored');fs.mkdirSync(restored);
  execFileSync('tar',['-xzf',archive,'-C',restored]);
  assert.equal(fs.readFileSync(path.join(restored,'data/transcripts/history.jsonl'),'utf8'),'preserved history\n');
  assert.equal(fs.lstatSync(path.join(restored,'data/transcripts')).isSymbolicLink(),false);
  assert.equal(fs.lstatSync(path.join(restored,'data/other-link')).isSymbolicLink(),true);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
