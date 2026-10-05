import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { CodexFixtureSetup } from '../src/fixtureTests/codexSetup.js';
import { createFixtureTestsRouter } from '../src/fixtureTests/routes.js';

const source = fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
describe('isolated native Codex pre-auth coupling', () => {
  it('uses real isolated native bootstrap, scoped peer, authenticated lineage and durable no-replay effects', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-codex-test-')));
    const root = path.join(temp,'host');
    let s = new CodexFixtureSetup(root,source);
    try {
      const setup = await s.setup(1,'setup-one');
      expect(setup.payload.admission).toBe(false);
      expect(await s.setup(1,'setup-one')).toEqual(setup);
      const evidence = setup.payload.evidence as any;
      expect(evidence.hosts.worker.accountAbsent).toBe(true);
      expect(evidence.hosts.worker.credentialStore).toBe('ephemeral');
      expect(evidence.hosts['dedicated-auth'].credentialStore).toBe('file');
      const device = s.deviceSetup(1,setup.payload.id as string);
      expect(device.ready).toBe(false); expect(device.execute).toBe(false);
      expect(device.nativeParams).toEqual({type:'chatgptDeviceCode'});
      const snapshot = s.publishTraining(1,'training-one',{roleConversationId:crypto.randomUUID(),version:1,
        syntheticOnly:true,bytes:'Synthetic shared role guidance: require human approval for refunds and cancellation.'});
      const sessions = [0,1].map(i => ({sessionId:'fixture-session-'+i,customerId:'fixture-customer-'+i,orderId:'fixture-order-'+i}));
      const coupling = {setupId:setup.payload.id,snapshotId:snapshot.payload.id,sessions};
      const run = await s.materialize(1,'run-one',coupling);
      expect(await s.materialize(1,'run-one',coupling)).toEqual(run);
      const runId = run.payload.id as string;
      expect(run.payload.nativeAdmission).toBe(false);
      const material = run.payload.sessions as any[];
      expect(material[0].nativeState).not.toBe(material[1].nativeState);
      const call = {...sessions[0],messageId:'fixture-message-one',tool:'fixture.preference.set',arguments:{preference:'morning'}};
      const accepted = await s.call(1,runId,call);
      expect(accepted.payload.status).toBe('SYNTHETIC_ACCEPTED');
      expect(accepted.payload.effect).toMatchObject({kind:'PREFERENCE',preference:'morning'});
      const count = (s.db.prepare('SELECT count(*) AS n FROM intents').get() as any).n;
      expect(await s.call(1,runId,call)).toEqual(accepted);
      s.close(); s = new CodexFixtureSetup(root,source);
      expect(await s.call(1,runId,call)).toEqual(accepted);
      expect((s.db.prepare('SELECT count(*) AS n FROM intents').get() as any).n).toBe(count);
      await expect(s.call(1,runId,{...call,arguments:{preference:'afternoon'}})).rejects.toThrow('FIXTURE_INTENT_DRIFT');
      const read = await s.call(1,runId,{...sessions[0],messageId:'fixture-read-one',tool:'fixture.order.read',arguments:{}});
      expect(read.payload.effect).toMatchObject({preference:'morning',autoShipSmsPaused:true,proposedHourWindowActive:false});
      const other = await s.call(1,runId,{...sessions[1],messageId:'fixture-read-two',tool:'fixture.order.read',arguments:{}});
      expect(other.payload.effect).toMatchObject({preference:null});
      const sink = await s.call(1,runId,{...sessions[0],messageId:'fixture-sms-one',tool:'fixture.sms.accept',arguments:{text:'Synthetic substantive fixture answer.'}});
      expect(sink.payload.status).toBe('SINK_ACCEPTED'); expect(sink.payload.carrierDelivery).toBeNull();
      for (const tool of ['fixture.cancel.request','fixture.refund.request']) {
        const gate = await s.call(1,runId,{...sessions[0],messageId:'fixture-'+tool.split('.')[1],tool,arguments:{}});
        expect(gate.payload.status).toBe('APPROVAL_REQUIRED'); expect(gate.payload.effect).toMatchObject({execute:false});
      }
      const handoff = await s.call(1,runId,{...sessions[0],messageId:'fixture-handoff-one',tool:'fixture.handoff',arguments:{reason:'Synthetic unresolved request'}});
      expect(handoff.payload.status).toBe('UNRESOLVED_HANDOFF');
      await expect(s.call(2,runId,call)).rejects.toThrow('FIXTURE_MATERIAL_NOT_FOUND');
      await expect(s.call(1,runId,{...call,customerId:sessions[1].customerId})).rejects.toThrow('FIXTURE_SCOPE_MISMATCH');
      await expect(s.call(1,runId,{...call,tool:'shell'})).rejects.toThrow();
      const denied = await s.call(1,runId,{...call,messageId:'fixture-url-one',arguments:{preference:'morning',url:'https://example.invalid'}});
      expect(denied.payload.status).toBe('DENIED');
      const profile = path.join(material[0].peerState,'peer.sb');
      const policy = fs.readFileSync(profile,'utf8');
      fs.writeFileSync(profile,'(version 1)(allow default)');
      const unknownCall = {...call,messageId:'fixture-unknown-one'};
      const unknown = await s.call(1,runId,unknownCall);
      expect(unknown.payload.status).toBe('UNKNOWN');
      fs.writeFileSync(profile,policy);
      expect((await s.call(1,runId,unknownCall)).payload.status).toBe('UNKNOWN');
      // Canonical immutable store prevents unsigned rewrite, while bad material blocks before peer.
      expect(() => s.db.prepare("UPDATE records SET envelope='{}'").run()).toThrow('immutable_fixture_record');
      const forged = 'fixture-forged';
      s.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(forged,1,'run','forged','a'.repeat(64),
        JSON.stringify({payload:{id:forged,owner:1},mac:'0'.repeat(64)}));
      expect(() => s.read(1,forged)).toThrow('FIXTURE_LINEAGE_AUTH_FAILED');
      fs.writeFileSync(material[0].trainingFile,'changed');
      await expect(s.call(1,runId,{...call,messageId:'fixture-drift-one'})).rejects.toThrow('FIXTURE_TRAINING_MATERIAL_DRIFT');
      fs.unlinkSync(material[0].trainingFile); fs.symlinkSync(path.join(root,'authority.key'),material[0].trainingFile);
      await expect(s.call(1,runId,{...call,messageId:'fixture-alias-one'})).rejects.toThrow('FIXTURE_PRIVATE_STORAGE_REQUIRED');
      await expect(s.materialize(1,'missing',{...coupling,snapshotId:crypto.randomUUID()})).rejects.toThrow('FIXTURE_MATERIAL_NOT_FOUND');
      await expect(s.materialize(1,'bad',{...coupling,sessions:[sessions[0],sessions[0]]})).rejects.toThrow();
      await expect(s.materialize(1,'run-one',{...coupling,sessions:[sessions[0]]})).rejects.toThrow('FIXTURE_SETUP_INPUT_DRIFT');
      expect(JSON.stringify(s.read(1,runId))).not.toContain('capabilityHash');
    } finally {s.close();fs.rmSync(temp,{recursive:true,force:true});}
  },60_000);

  it('denies bots/employees and native RPC/profile/token overrides before setup', async () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-codex-route-')));
    const s = new CodexFixtureSetup(path.join(temp,'host'),source);
    const app = express();app.use(express.json());
    app.use((req,_res,next) => {
      req.user = {id:1,role:req.headers['x-employee'] ? 'employee' : 'owner'} as any;
      if (req.headers['x-bot']) req.agentConversationId = 'fixture-bot';
      next();
    });
    app.use('/api/fixture-tests',createFixtureTestsRouter({config:{dataDir:temp,sourceDir:source} as any},undefined,s));
    const server = app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    const base = 'http://127.0.0.1:'+ (server.address() as AddressInfo).port+'/api/fixture-tests';
    try {
      for (const header of ['x-bot','x-employee']) {
        const result=await fetch(base+'/codex-host/setup',{method:'POST',headers:{'content-type':'application/json',[header]:'true'},body:'{"requestKey":"denied"}'});
        expect(result.status).toBe(403);
      }
      for (const bad of [{requestKey:'bad',command:'exec'},{requestKey:'bad',profile:'allow default'},
        {requestKey:'bad',authToken:'not-a-real-secret'},{requestKey:'bad',ownerId:2}]) {
        const result=await fetch(base+'/codex-host/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bad)});
        expect(result.status).toBe(400);expect(await result.text()).not.toContain('not-a-real-secret');
      }
      expect((s.db.prepare('SELECT count(*) AS n FROM records').get() as any).n).toBe(0);
      const result=await fetch(base+'/codex-host/setup',{method:'POST',headers:{'content-type':'application/json'},body:'{"requestKey":"actual"}'});
      expect(result.status).toBe(200);
      expect((await result.json()).payload.admission).toBe(false);
    } finally {await new Promise<void>(r=>server.close(()=>r()));s.close();fs.rmSync(temp,{recursive:true,force:true});}
  },35_000);

  it('proves real same-policy credential/socket/process/session denials and closed peer capability registry',()=>{
    const filename=fileURLToPath(new URL('../../scripts/fixture-host/codex_test.py',import.meta.url));
    expect(execFileSync('/usr/bin/python3',[filename,'-v'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:30_000})).toBe('');
  },35_000);
  it('fences failed bootstrap durably instead of replaying its setup request', async()=>{
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-codex-unknown-')));
    const root = path.join(temp,'host');
    let store = new CodexFixtureSetup(root,path.join(temp,'missing-source'));
    try {
      await expect(store.setup(1,'unknown-bootstrap')).rejects.toThrow('FIXTURE_CHILD_FAILED');
      store.close(); store = new CodexFixtureSetup(root,source);
      await expect(store.setup(1,'unknown-bootstrap')).rejects.toThrow('FIXTURE_SETUP_OUTCOME_UNKNOWN');
      expect((store.db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get('setup-intent') as any).n).toBe(1);
    } finally {store.close();fs.rmSync(temp,{recursive:true,force:true});}
  });
});
