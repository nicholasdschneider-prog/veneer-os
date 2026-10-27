import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createBackup, retainRecoveryCopy} from './backup.mjs';
test('backup contains relocated transcript content and preserves unrelated links',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'veneer-external-backup-test-'));
 try {
  const data=path.join(root,'data'), external=path.join(root,'external'), backups=path.join(root,'backups');
  fs.mkdirSync(data);fs.mkdirSync(external);
  fs.writeFileSync(path.join(external,'history.jsonl'),'preserved history\n');
  fs.symlinkSync(external,path.join(data,'transcripts'));
  fs.symlinkSync(external,path.join(data,'other-link'));
  const archive=await createBackup({dataDir:data,backupDir:backups,recoveryDir:null});
  const restored=path.join(root,'restored');fs.mkdirSync(restored);
  execFileSync('tar',['-xzf',archive,'-C',restored]);
  assert.equal(fs.readFileSync(path.join(restored,'data/transcripts/history.jsonl'),'utf8'),'preserved history\n');
  assert.equal(fs.lstatSync(path.join(restored,'data/transcripts')).isSymbolicLink(),false);
  assert.equal(fs.lstatSync(path.join(restored,'data/other-link')).isSymbolicLink(),true);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('recovery retains one verified archive, preserving unrelated files and the old copy on failure', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'veneer-recovery-test-'));
 try {
  const primary=path.join(root,'primary'), recovery=path.join(root,'recovery');
  fs.mkdirSync(primary);fs.mkdirSync(recovery);
  const old='veneer-pro-20261026T072000Z.tar.gz', next='veneer-pro-20261027T072000Z.tar.gz';
  fs.writeFileSync(path.join(recovery,old),'old');fs.writeFileSync(path.join(recovery,'notes.txt'),'keep');
  await assert.rejects(retainRecoveryCopy(path.join(primary,next),recovery));
  assert.equal(fs.readFileSync(path.join(recovery,old),'utf8'),'old');
  fs.writeFileSync(path.join(primary,next),'new archive');
  await retainRecoveryCopy(path.join(primary,next),recovery);
  assert.equal(fs.readFileSync(path.join(recovery,next),'utf8'),'new archive');
  assert.equal(fs.existsSync(path.join(recovery,old)),false);
  assert.equal(fs.readFileSync(path.join(recovery,'notes.txt'),'utf8'),'keep');
  await assert.rejects(retainRecoveryCopy(path.join(primary,next),primary));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
