import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AppContext} from '../src/context.js';
import {caseCustodyRoutes,caseCustodyVerifierRoutes,loadCustodyRegistry} from '../src/bots/caseCustodyRoutes.js';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { caseCustody, type CustodyIO } from '../src/bots/caseCustody.js';
import { registrationSchema, CUSTODY_CONTRACT_HASH, custodyHash, evidenceMaterial, sourceRequestDigest, authoritySchema, claimResponseSchema, type Evidence, type SourceIntent } from '../src/bots/caseCustodyContract.js';
import { canonicalSha256 } from '../src/bots/canonical.js';
import { captureHumanMessage } from '../src/bots/humanMessages.js';
import type { Actor } from '../src/bots/service.js';
const uid = () => crypto.randomUUID(), H = 'a'.repeat(64), origin = 'https://orderops-dev-web-production.up.railway.app';
describe('prospective completed case custody', () => {
    let db: Database.Database, io: CustodyIO, s: ReturnType<typeof caseCustody>, reg: ReturnType<typeof registrationSchema.parse>, e: Evidence, intent: SourceIntent, now: number, owner: Actor, reviewer: Actor, sourceReads: number;
    const input = () => ({ registrationId: reg.id, caseId: e.caseId, instructionKind: 'direct_message' as const, instructionId: instruction });
    let instruction: string;
    const renew = () => { e.observedAt = new Date(now).toISOString(); e.expiresAt = new Date(now + 15000).toISOString(); e.snapshotHash = custodyHash('case-custody/evidence/v1', evidenceMaterial(e)); };
    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys=ON');
        migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
        now = Date.parse('2026-09-30T01:00:00Z');
        sourceReads = 0;
        db.prepare("INSERT INTO users(id,email,display_name,role,status) VALUES(1,'fixture@example.test','Owner','owner','active'),(2,'other@example.test','Other','owner','active')").run();
        const business = uid(), reviewerId = uid(), executor = uid();
        db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(business, 'Fixture');
        for (const id of [reviewerId, executor]) {
            db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude',?,'team',?)").run(id, id, business);
            db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id, id);
        }
        owner = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as Actor['user'] };
        reviewer = { ...owner, conversationId: reviewerId };
        const from = { id: uid(), revision: 1, principalId: 'fixture:retired', identityEvidenceHash: H }, to = { id: uid(), revision: 1, principalId: 'fixture:nora', identityEvidenceHash: H };
        reg = registrationSchema.parse({ historicalEnrollment: from, destinationEnrollment: to, schemaVersion: 'case-custody-registration/v1', id: uid(), revision: 1, active: true, businessId: business, ownerUserId: 1, sourceOrigin: origin, accountId: 'fixture-account', runtime: { projectId: uid(), environmentId: uid(), serviceId: uid() }, reviewerConversationId: reviewerId, executorConversationId: executor, executorPrincipalId: 'fixture:nora', servicePrincipalId: 'fixture:service', audience: 'dedicated-fixture', cfClientId: 'dedicated-fixture-client', bearerHash: H, readerCredential: { project: 'fixture', config: 'test', name: 'CASE_CUSTODY_READER' }, custodyReceiptHash: H, sourceAcceptanceHash: H, contractHash: CUSTODY_CONTRACT_HASH, expiresAt: '2026-10-01T00:00:00Z', credentialExpiresAt: '2026-10-01T00:00:00Z' });
        const caseId = uid(), transition = { schemaVersion: 'prospective-custody-transition/v1' as const, ledger: 'cs_prospective_custody' as const, caseId, expectedCustodyRevision: 0 as const, expectedCustodyOwner: null, destinationPrincipalId: reg.executorPrincipalId, permittedChanges: ['insert_prospective_custody_ledger'] as [
                'insert_prospective_custody_ledger'
            ], caseMutation: false as const, historicalMutation: false as const };
        e = { schemaVersion: 'case-custody-evidence/v1', registrationId: reg.id, registrationRevision: 1, servicePrincipalId: reg.servicePrincipalId, businessId: business, accountId: reg.accountId, sourceOrigin: origin, runtime: reg.runtime, caseId, ticket: 'SYNTHETIC', caseVersion: '2026-09-18 16:27:45.824123', materialRevision: H, status: 'complete', closedAt: null, resolvedAt: null, completion: { eventCaseId: caseId, eventId: '6151', eventHash: H, principalId: 'fixture:retired', eventAt: '2026-09-18 16:28:00.000001', caseVersion: '2026-09-18 16:27:45.824123', chronology: 'event_after_case_version_unbound', linkage: 'unbound' }, from: { ...from, principalId: 'fixture:retired', mode: 'historical_only', identityEvidenceHash: H, revoked: false, retired: true }, to: { ...to, principalId: reg.executorPrincipalId, mode: 'active_destination', identityEvidenceHash: H, revoked: false, retired: false }, transition, transitionHash: custodyHash('case-custody/transition/v1', transition), blockers: [], priorEffects: [{ id: 'fixture-effect', revision: H, summary: 'Complete authenticated fixture history: no prior parallel effect.', disposition: 'no_effect' }], coverage: { complete: true, omissions: [] }, observedAt: '', expiresAt: '', snapshotHash: '' };
        renew();
        instruction = captureHumanMessage(db, reviewerId, 1, 'Give the exact completed case prospective custody to the named destination only. Preserve prior completion and do not send or refund.');
        io = { registration: () => structuredClone(reg), evidence: async () => { sourceReads++; return structuredClone(e); }, intent: async () => structuredClone(intent), now: () => now };
        s = caseCustody(db, io);
    });
    afterEach(() => db.close());
    async function enroll() { const p = await s.prepareEnrollment(owner, reg.id, e.caseId); return s.enroll(owner, reg.id, e.caseId, p.enrollmentHash); }
    async function payload() { const p = await s.inspect(reviewer, input()); return { ...input(), inspectionHash: p.inspectionHash, requestKey: uid(), expiresAt: new Date(now + 600000).toISOString(), review: { reviewedFullContext: true as const, instruction: { kind: p.native.instruction.kind, id: p.native.instruction.id, text: p.native.instruction.text }, interpretation: 'unconditional_prospective_custody' as const, explanation: 'Full native fixture direction is unconditional prospective custody only.', context: p.native.human.map(m => ({ citation: { kind: m.kind, id: m.id, text: m.text }, classification: 'supports' as const, explanation: 'Reviewed complete fixture context; no unresolved instruction.' })), effects: e.priorEffects.map(x => ({ id: x.id, revision: x.revision, disposition: 'reconciled_no_parallel_effect' as const, explanation: 'Exact authenticated fixture effects reconciled; no parallel action.' })), scope: 'prospective_completed_case_custody_only' as const, noUnresolvedConditions: true as const } }; }
    async function issued() { await enroll(); return (await s.issue(reviewer, await payload())).authority; }
    function prepare(a: ReturnType<typeof authoritySchema.parse>) { intent = { schemaVersion: 'case-custody-intent/v1', registrationId: reg.id, servicePrincipalId: reg.servicePrincipalId, businessId: reg.businessId, accountId: reg.accountId, sourceOrigin: origin, runtime: reg.runtime, sourceRequestId: uid(), sourceRequestHash: H, authorityId: a.id, authorityHash: a.authorityHash, requestKey: uid(), caseId: a.caseId, executorPrincipalId: reg.executorPrincipalId, state: 'REDEEMING', claimId: null, receiptHash: null, preparation: { preparedEventId: uid(), preparedAt: new Date(now - 1000).toISOString(), preparedContentHash: H, redeemingEventId: uid(), redeemingAt: new Date(now).toISOString(), transitionRevision: 1 }, transition: a.transition, transitionHash: a.transitionHash, outcome: null, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15000).toISOString() }; intent.sourceRequestHash = sourceRequestDigest(intent); intent.preparation.preparedContentHash = intent.sourceRequestHash; return { schemaVersion: 'case-custody-claim/v1' as const, authorityId: a.id, authorityHash: a.authorityHash, sourceRequestId: intent.sourceRequestId, sourceRequestHash: intent.sourceRequestHash, requestKey: intent.requestKey }; }
    it('requires genuine owner enrollment, never reviewer impersonation', async () => { await expect(s.inspect(reviewer, input())).rejects.toThrow('BOUNDARY'); await expect(s.prepareEnrollment(reviewer, reg.id, e.caseId)).rejects.toThrow('human'); expect(sourceReads).toBe(0); await enroll(); expect((await s.inspect(reviewer, input())).execute).toBe(false); });
    it('issues prospectively while preserving foreign unbound chronology and old immutable context', async () => { const before = db.prepare('SELECT * FROM bot_human_messages').all(), a = await issued(); expect(a.completion).toEqual(e.completion); expect(a.closedAt).toBeNull(); expect(a.from.retired).toBe(true); expect(a.transition.caseMutation).toBe(false); expect(db.prepare('SELECT * FROM bot_human_messages').all()).toEqual(before); expect(() => db.prepare('DELETE FROM case_custody_authorities').run()).toThrow('Immutable'); const { authorityHash, ...tuple } = a; expect(authorityHash).toBe(custodyHash('case-custody/authority/v1', tuple)); expect((await s.verify(reg.id, a.id)).custodyEntitlement).toBe(false); });
    it.each(['status_only', 'quoted', 'conditional', 'ambiguous'] as const)('does not turn %s review into authority', async (interpretation) => { await enroll(); const p = await payload(); await expect(s.issue(reviewer, { ...p, review: { ...p.review, interpretation } })).rejects.toThrow('EXPLICIT'); expect(db.prepare('SELECT count(*) n FROM case_custody_authorities').get()).toEqual({ n: 0 }); });
    it('requires exact full citations, all context and prior effects', async () => { await enroll(); const p = await payload(); for (const review of [{ ...p.review, context: [] }, { ...p.review, effects: [] }, { ...p.review, instruction: { ...p.review.instruction, text: 'forged' } }])
        await expect(s.issue(reviewer, { ...p, review })).rejects.toThrow(); });
    it('rejects nonhuman result reply and foreign human source', async () => { await enroll(); await expect(s.inspect(reviewer, { ...input(), instructionKind: 'result_reply', instructionId: uid() })).rejects.toThrow('HUMAN'); const foreign = captureHumanMessage(db, reg.reviewerConversationId, 2, 'Grant custody'); await expect(s.inspect(reviewer, { ...input(), instructionId: foreign })).rejects.toThrow('HUMAN'); });
    it.each(['fromRevoked', 'destinationRetired', 'foreignAccount', 'foreignRuntime', 'missingEventCase', 'unknownChronology', 'changedIdentity'] as const)('denies %s source evidence', async (kind) => { await enroll(); if (kind === 'fromRevoked')
        e.from.revoked = true; if (kind === 'destinationRetired')
        e.to.retired = true; if (kind === 'foreignAccount')
        e.accountId = 'foreign'; if (kind === 'foreignRuntime')
        e.runtime = { ...reg.runtime, serviceId: uid() }; if (kind === 'missingEventCase')
        e.completion.eventCaseId = uid(); if (kind === 'unknownChronology')
        e.completion.chronology = 'unavailable'; if (kind === 'changedIdentity')
        e.from.identityEvidenceHash = 'b'.repeat(64); renew(); await expect(s.inspect(reviewer, input())).rejects.toThrow(); });
    it.each(['unknownEffect', 'foreignLease', 'humanAssignment', 'incomplete'] as const)('blocks %s eligibility without hiding source evidence', async (kind) => { await enroll(); if (kind === 'unknownEffect')
        e.priorEffects[0]!.disposition = 'unknown'; if (kind === 'foreignLease' || kind === 'humanAssignment')
        e.blockers = [kind]; if (kind === 'incomplete')
        e.coverage.complete = false; renew(); await expect(s.issue(reviewer, await payload())).rejects.toThrow('UNRESOLVED'); });
    it('rejects native context drift after fetch and issue inspection', async () => { await enroll(); const p = await payload(); captureHumanMessage(db, reg.reviewerConversationId, 1, 'Hold pending previous effects.'); await expect(s.issue(reviewer, p)).rejects.toThrow('INSPECTION_CHANGED'); io.evidence = async () => { captureHumanMessage(db, reg.reviewerConversationId, 1, 'Later message'); return e; }; await expect(s.inspect(reviewer, input())).rejects.toThrow('CONTEXT_CHANGED'); });
    it.each(['owner', 'reviewer', 'executor', 'registration', 'expiry'])('denies %s revocation/expiry', async (kind) => { const a = await issued(); if (kind === 'owner')
        db.prepare("UPDATE users SET status='disabled' WHERE id=1").run(); if (kind === 'reviewer' || kind === 'executor')
        db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(kind === 'reviewer' ? reg.reviewerConversationId : reg.executorConversationId); if (kind === 'registration')
        reg.active = false; if (kind === 'expiry')
        now += 86400000; await expect(s.verify(reg.id, a.id)).rejects.toThrow(); });
    it('permanently dedupes issuance across keys and lost response', async () => { await enroll(); const p = await payload(), a = await s.issue(reviewer, p); expect((await s.issue(reviewer, p)).authority.id).toBe(a.authority.id); await expect(s.issue(reviewer, { ...p, requestKey: uid() })).rejects.toThrow('ALREADY_RESERVED'); s.revoke(reviewer, a.authority.id, 'Fixture revoke'); await expect(s.issue(reviewer, { ...p, requestKey: uid() })).rejects.toThrow('ALREADY_RESERVED'); });
    it('atomic claim race grants once; replay never grants and revocation cannot free it', async () => { const a = await issued(), p = prepare(a); const results = await Promise.all([s.claim(reg.id, p), s.claim(reg.id, p)]); expect(results.filter(x => x.custodyEntitlement)).toHaveLength(1); results.forEach(x => claimResponseSchema.parse(x)); expect(s.revoke(reviewer, a.id, 'Later revoke').reservationIrrevocable).toBe(true); expect((await s.claim(reg.id, p)).custodyEntitlement).toBe(false); await expect(s.claim(reg.id, { ...p, requestKey: uid() })).rejects.toThrow('CONFLICT'); });
    it('revocation before claim prevents reservation', async () => { const a = await issued(), p = prepare(a); s.revoke(reviewer, a.id, 'Before claim'); await expect(s.claim(reg.id, p)).rejects.toThrow('REVOKED'); expect(s.claimRead(reg.id, a.id).claim).toBeNull(); });
    it('revocation during authenticated intent read denies first claim', async () => { const a = await issued(), p = prepare(a); io.intent = async () => { s.revoke(reviewer, a.id, 'Race'); return intent; }; await expect(s.claim(reg.id, p)).rejects.toThrow('REVOKED'); });
    it.each(['key', 'transition', 'prepared', 'state', 'scope'])('rejects incompatible source intent %s', async (kind) => { const a = await issued(), p = prepare(a); if (kind === 'key')
        intent.requestKey = uid(); if (kind === 'transition')
        intent.transitionHash = 'b'.repeat(64); if (kind === 'prepared')
        intent.preparation.preparedContentHash = 'b'.repeat(64); if (kind === 'state')
        intent.state = 'UNKNOWN'; if (kind === 'scope')
        intent.executorPrincipalId = 'foreign'; await expect(s.claim(reg.id, p)).rejects.toThrow(); });
    it('expired observation during source read cannot renew claim eligibility', async () => { const a = await issued(), p = prepare(a); io.intent = async () => { now += 16000; return intent; }; await expect(s.claim(reg.id, p)).rejects.toThrow('EXPIRED'); });
    it('unknown receipt and source local rollback never regrant; terminal proof required', async () => { const a = await issued(), p = prepare(a), c = await s.claim(reg.id, p); intent.claimId = null; intent.state = 'UNKNOWN'; expect((await s.receipt(reg.id, a.id)).state).toBe('UNKNOWN'); expect((await s.claim(reg.id, p)).custodyEntitlement).toBe(false); intent.claimId = c.claim!.id; intent.state = 'ROLLED_BACK_TERMINAL'; await expect(s.receipt(reg.id, a.id)).rejects.toThrow(); intent.outcome = { kind: 'ROLLED_BACK_TERMINAL', auditEventId: uid(), recordedAt: new Date(now).toISOString(), rollbackEvidenceHash: H, noRetry: true }; intent.receiptHash = custodyHash('case-custody/outcome/v1', intent.outcome); expect((await s.receipt(reg.id, a.id)).state).toBe('ROLLED_BACK_TERMINAL'); expect((await s.claim(reg.id, p)).custodyEntitlement).toBe(false); });
    it('authenticates exact applied audit, preserving case version; conflicting receipt denied', async () => { const a = await issued(), p = prepare(a), c = await s.claim(reg.id, p); intent.claimId = c.claim!.id; intent.state = 'APPLIED'; intent.outcome = { kind: 'APPLIED', auditEventId: uid(), committedAt: new Date(now).toISOString(), beforeCaseVersion: a.caseVersion, afterCaseVersion: a.caseVersion, beforeCustodyRevision: 0, afterCustodyRevision: 1, transition: a.transition, transitionHash: a.transitionHash }; intent.receiptHash = custodyHash('case-custody/outcome/v1', intent.outcome); expect((await s.receipt(reg.id, a.id)).state).toBe('APPLIED'); expect((await s.receipt(reg.id, a.id)).state).toBe('APPLIED'); intent.outcome.auditEventId = uid(); intent.receiptHash = custodyHash('case-custody/outcome/v1', intent.outcome); await expect(s.receipt(reg.id, a.id)).rejects.toThrow('CONFLICT'); });
    it('rejects stale material and source context before claim', async () => { const a = await issued(), p = prepare(a); e.materialRevision = 'b'.repeat(64); renew(); await expect(s.claim(reg.id, p)).rejects.toThrow('MATERIAL_CHANGED'); });
    it('bounded complete context refuses excerpts', async () => { await enroll(); captureHumanMessage(db, reg.reviewerConversationId, 1, 'x'.repeat(120001)); await expect(s.inspect(reviewer, input())).rejects.toThrow('BOUND'); });
    it.each(['no-cf','no-bearer','shared-audience','valid'] as const)('dedicated service HTTP boundary %s never borrows a human identity',async mode=>{
      const bearer='synthetic-case-custody-credential-fixture-only';reg.bearerHash=crypto.createHash('sha256').update(bearer).digest('hex');
      if(mode==='shared-audience')reg.audience='human';await enroll();const reads=sourceReads;
      const app=express();app.use('/api/case-custody/verifier',caseCustodyVerifierRoutes({db,config:{cfAud:'human'}} as AppContext,{io,cf:async()=>mode!=='no-cf'}));
      const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
      try{const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/case-custody/verifier/authorities/${uid()}`,{headers:{'x-case-custody-registration-id':reg.id,authorization:`Bearer ${mode==='no-bearer'?'invalid':bearer}`}});expect(response.status).toBe(mode==='valid'?404:mode==='shared-audience'?403:401);expect(sourceReads).toBe(reads);expect(response.headers.get('cache-control')).toBe('no-store');}finally{await new Promise<void>(r=>server.close(()=>r()));}
    });
    it('native route returns strict inspection and rejects bot enrollment and unknown query fields',async()=>{
      await enroll();const app=express();app.use(express.json());app.use((q,_r,n)=>{q.user=reviewer.user;q.agentConversationId=reviewer.conversationId;n();});app.use(caseCustodyRoutes({db,config:{}} as AppContext,io));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
      const post=(route:string,body:unknown)=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      try{const inspected=await post('/case-custody/inspect',input());expect(inspected.status).toBe(200);expect((await inspected.json()).execute).toBe(false);expect((await post('/case-custody/enrollment/prepare',{registrationId:reg.id,caseId:e.caseId})).status).toBe(403);expect((await post('/case-custody/inspect?fallback=true',input())).status).toBe(400);}finally{await new Promise<void>(r=>server.close(()=>r()));}
    });
    it('protected registry never accepts absent config, symlink or public file',()=>{
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'case-custody-fixture-')),file=path.join(dir,'registry.json');try{const content={schemaVersion:'case-custody-registry/v1',registrations:[reg]};fs.writeFileSync(file,JSON.stringify(content),{mode:0o600});expect(loadCustodyRegistry(file)).toEqual(content);fs.symlinkSync(file,path.join(dir,'link'));expect(()=>loadCustodyRegistry(path.join(dir,'link'))).toThrow();fs.chmodSync(file,0o644);expect(()=>loadCustodyRegistry(file)).toThrow();expect(()=>loadCustodyRegistry(null)).toThrow('BOUNDARY');}finally{fs.rmSync(dir,{recursive:true,force:true});}
    });

    it('concurrent identical issuance reconciles to one permanent authority',async()=>{await enroll();const p=await payload();const results=await Promise.all([s.issue(reviewer,p),s.issue(reviewer,p)]);expect(results[0]!.authority.id).toBe(results[1]!.authority.id);expect(db.prepare('SELECT count(*) n FROM case_custody_authorities').get()).toEqual({n:1});});
    it('new registration cannot escape historical case/event uniqueness',async()=>{await issued();reg={...reg,id:uid()};e.registrationId=reg.id;renew();await enroll();await expect(s.issue(reviewer,await payload())).rejects.toThrow('ALREADY_RESERVED');});

    it('wrong reviewer and executor cannot issue; no credential/source read happens',async()=>{await enroll();const before=sourceReads;await expect(s.inspect({...reviewer,conversationId:reg.executorConversationId},input())).rejects.toThrow('reviewer');await expect(s.inspect({...reviewer,user:db.prepare('SELECT * FROM users WHERE id=2').get() as Actor['user']},input())).rejects.toThrow('reviewer');expect(sourceReads).toBe(before);});
    it('later status requires explicit complete review; substantive supersession denies',async()=>{await enroll();captureHumanMessage(db,reg.reviewerConversationId,1,'Was custody recorded?');const p=await payload();const status={...p.review,context:p.review.context.map((x,i)=>({...x,classification:i===1?'status_only':'supports'}))};expect((await s.issue(reviewer,{...p,review:status})).custodyEntitlement).toBe(false);});
    it('substantive and ambiguous context classifications cannot be ignored',async()=>{await enroll();const p=await payload();for(const classification of ['supersedes','ambiguous'])await expect(s.issue(reviewer,{...p,review:{...p.review,context:p.review.context.map(x=>({...x,classification}))}})).rejects.toThrow('UNRESOLVED');});

});
