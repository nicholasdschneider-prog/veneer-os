import {it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadCorrespondenceRegistry,correspondenceRegistrySchema} from '../src/bots/composedSmsReader.js';
const file=new URL('../../docs/reports/composed-sms/build434-manifest.json',import.meta.url);
it('pins the reviewed six-caller read-only custody extension without renewing expiry or claiming SMS identity',()=>{
 const m=correspondenceRegistrySchema.parse(JSON.parse(fs.readFileSync(file,'utf8'))),r=m.registrations[0]!;
 expect(m.registrations).toHaveLength(1);expect(r.callers).toHaveLength(6);expect(new Set(r.callers.map(c=>c.conversation_id)).size).toBe(6);
 expect(r.expires_at).toBe('2026-10-28T21:04:00Z');expect(r.account_id).toBe('help@elkhartrvparts.com');expect(r.payload_accounts).toEqual(['OrderOps SMS +15746756919']);
 expect(r.provenance.authority).toBe('compose-send-correspondence-custody');expect(r.provenance.receipt).toBe('approved-case-correspondence-custody-permission-20260928-v1');
 expect(r.callers.every(c=>c.user_id===1&&c.credential.project==='ervp'&&c.credential.config==='prd')).toBe(true);
 expect(r.callers.some(c=>c.conversation_id==='2c5de4ad-00b4-4be2-abf7-25f34eb787a3')).toBe(false);
});
it('loads only a protected regular file; rejects symlink, excess permissions and unknown dispatch fields',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'correspondence-custody-')),target=path.join(dir,'registry.json');
 try{fs.writeFileSync(target,fs.readFileSync(file),{mode:0o600});expect(loadCorrespondenceRegistry(target).registrations).toHaveLength(1);
 fs.symlinkSync(target,path.join(dir,'link'));expect(()=>loadCorrespondenceRegistry(path.join(dir,'link'))).toThrow('CUSTODY_REQUIRED');
 fs.chmodSync(target,0o644);expect(()=>loadCorrespondenceRegistry(target)).toThrow('CUSTODY_REQUIRED');fs.chmodSync(target,0o600);
 const m=JSON.parse(fs.readFileSync(target,'utf8'));m.registrations[0].sender_verified=true;fs.writeFileSync(target,JSON.stringify(m));expect(()=>loadCorrespondenceRegistry(target)).toThrow('CUSTODY_REQUIRED');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
