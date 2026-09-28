import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { communicationService } from '../src/bots/communication.js';
import { messageDelegationService } from '../src/bots/messageDelegation.js';
import { approvedMessageSchema } from '../src/bots/draftPayload.js';
import { approvedCaseRegistrySchema, approvedCaseResolver, boundedResolverGet, loadApprovedCaseRegistry, type ResolverIO } from '../src/bots/approvedCaseResolver.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import * as secrets from '../src/secrets/readSecret.js';
import { createCommunicationRouter } from '../src/bots/communicationRoutes.js';

const ids={owner:'10000000-0000-4000-8000-000000000001',executor:'10000000-0000-4000-8000-000000000002',other:'10000000-0000-4000-8000-000000000003',business:'20000000-0000-4000-8000-000000000001',foreign:'20000000-0000-4000-8000-000000000002',case:'30000000-0000-4000-8000-000000000001',customer:'40000000-0000-4000-8000-000000000001'};
const origin='https://orderops-dev-web-production.up.railway.app';
const runtime={projectId:'71cc77d6-9c0d-4770-9d6d-62b8c4bb516c',environmentId:'530025e2-352d-443c-a8ed-e589fc20621d',serviceId:'ede1932e-b3f9-4e7b-b1be-45804dfbe842'};
function registration(){return approvedCaseRegistrySchema.parse({schema_version:'approved-case-registry/v1',registrations:[{id:'fixture-registration',active:true,business_id:ids.business,business_owner_user_id:1,account_id:'fixture-source-account',source_origin:origin,runtime,payload_accounts:['support@example.test'],expires_at:'2026-10-01T00:00:00Z',provenance:{custodian_id:ids.other,receipt:'synthetic-custody-only',registered_at:'2026-09-28T00:00:00Z',authority:'approved-message-resolver-custody'},callers:[ids.owner,ids.executor].map((conversation_id,i)=>({conversation_id,user_id:1,principal_id:`fixture-principal-${i}`,credential:{project:'fixture',config:'test',name:`FIXTURE_${i}_CREDENTIAL`}}))}]});}

describe('authenticated approved UUID/ticket mapping',()=>{
 let db:Database.Database,bots:ReturnType<typeof createBotService>,owner:Actor,executor:Actor,human:Actor;
 let registry:ReturnType<typeof registration>,now:number,source:Record<string,unknown>,calls:string[],capDrift:string|undefined;
 let resolver:ReturnType<typeof approvedCaseResolver>,secret:ReturnType<typeof vi.fn>,get:ResolverIO['get'];
 let named:string;
 const scope=()=>approvedMessageSchema.parse({canonical_case:ids.case,executor_conversation_id:named,payload:{channel:'email',account:'support@example.test',recipients:['customer@example.test'],subject:'Synthetic approval',body:'Exact fixture body.',customer:'Synthetic customer',ticket:'FIX123',attachments:[{name:'a.pdf',reference:'fixture',sha256:'a'.repeat(64)}],context:'No financial action'}});
 beforeEach(()=>{
  named=ids.executor;registry=registration();now=Date.parse('2026-09-28T12:00:00Z');calls=[];capDrift=undefined;
  source={id:ids.case,ticketNumber:'FIX123',customerId:ids.customer,updatedAt:'2026-09-28T11:00:00Z',relatedOrderId:null,orderBindingVersion:0,orderBindingExplicit:false,messages:['PRIVATE fixture content must never be retained']};
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  for(const id of [1,2])db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')").run(id,`fixture${id}@example.test`,`Person ${id}`);
  db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1),(?,?,1)').run(ids.business,'Fixture',ids.foreign,'Foreign');
  db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES(?,2,'manager')").run(ids.business);
  for(const id of [ids.owner,ids.executor,ids.other]){db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team',?)").run(id,id,id,ids.business);db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id,id);}
  const user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;owner={user,conversationId:ids.owner};executor={user,conversationId:ids.executor};human={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};bots=createBotService(db);
  secret=vi.fn(async(ref:{name:string})=>ref.name);
  get=async(url,bearer)=>{calls.push(url);if(url.endsWith('/capabilities'))return {ok:true,access:{principalId:capDrift??(bearer==='FIXTURE_0_CREDENTIAL'?'fixture-principal-0':'fixture-principal-1'),fullOrderOpsAccess:true,accountId:'fixture-source-account',nativeBusinessId:ids.business,sourceOrigin:origin,runtime}};return structuredClone(source);};
  resetResolver();
 });
 function resetResolver(){resolver=approvedCaseResolver({db} as AppContext,{registry:()=>registry,secret,get,now:()=>now});}
 afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
 function approve(equal=false){const p=scope();if(equal)p.canonical_case=p.payload.ticket;const d=bots.raise(owner,{source_key:'fixture',proposal_key:'v1',proposal:proposalSchema.parse({question:'Fixture only?',recommendation:'Exact message',consequence:'No finance',blocked_action:'Only fixture email',assignee_id:2,message_delivery:p})});bots.answer(human,d.id,1,'fixture-approve',{action:'approve',text:'Approved fixture',scope:'this_case'});return {id:d.id,p};}
 async function services(a:Actor,id:string,receipt=false){const check=await resolver.prepare(a,id,1,receipt);return {bridge:messageDelegationService(db,check),messages:communicationService(db,check)};}
 async function setup(){const {id,p}=approve();const a=await services(owner,id);const g=a.bridge.delegate(owner,id,1,named,'delegate',p);const b=await services(executor,id);const d=b.bridge.accept(executor,g.id,'accept',p);return {id,p,g,d};}
 function running(id:string){db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id IN (SELECT id FROM bot_decision_events WHERE decision_id=? AND kind='answered')").run(id);db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(id);bots.result(owner,id,1,'run',{state:'running',evidence:'Synthetic unchanged material',material_evidence_unchanged:true});}
 const check=(hash:string)=>({payload_hash:hash,material_evidence_unchanged:true,recipient_account_case_verified:true,lease_and_duplicates_checked:true,evidence:'Synthetic current checks'});
 const delivery=(draft:string,hash:string)=>({provider:'fixture',provider_message_id:'fixture-receipt',account:'support@example.test',recipients:['customer@example.test'],canonical_case:ids.case,payload_hash:hash,idempotency_key:`veneer-message:${draft}`,verified:true});
 it.each([false,true])('preserves approval and creates one mapped claim (same owner %s)',async same=>{
  if(same){named=ids.owner;executor=owner;}
  const {id,p}=approve();const original=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id);const a=await services(owner,id);const inspected=a.bridge.inspect(owner,id,1);expect(inspected.ready).toBe(true);expect(inspected.scope).toEqual(p);
  const g=a.bridge.delegate(owner,id,1,named,'delegate',p);expect(a.bridge.delegate(owner,id,1,named,'delegate',p).id).toBe(g.id);
  const b=await services(executor,id);const d=b.bridge.accept(executor,g.id,'accept',p);expect(b.bridge.accept(executor,g.id,'accept',p).id).toBe(d.id);
  expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id)).toEqual(original);expect(JSON.parse(d.payload_json)).toEqual(p.payload);
  const row=db.prepare('SELECT * FROM approved_case_mapping_bindings').get() as {evidence_json:string};expect(row.evidence_json).not.toContain('PRIVATE');expect(row.evidence_json).not.toContain('CREDENTIAL');
  expect(()=>db.prepare("UPDATE approved_case_mapping_bindings SET fingerprint='bad'").run()).toThrow('immutable');
  expect(calls.every(url=>url.endsWith('/capabilities')||url===`${origin}/api/cs/conversations/${ids.case}`)).toBe(true);
  expect(secret.mock.calls.map(c=>c[0].name)).toEqual(same?['FIXTURE_0_CREDENTIAL','FIXTURE_0_CREDENTIAL']:['FIXTURE_0_CREDENTIAL','FIXTURE_1_CREDENTIAL']);
  running(id);const c=await services(executor,id);expect(c.messages.claim(executor,d.id,'claim',check(g.payload_hash)).execute).toBe(true);expect(c.messages.claim(executor,d.id,'claim').execute).toBe(false);
  expect(()=>c.messages.claim(executor,d.id,'other',check(g.payload_hash))).toThrow();
  expect(db.prepare("SELECT count(*) n FROM bot_message_delegation_events WHERE kind='claimed'").get()).toEqual({n:1});
 });
 it('does not obtain credentials for equal IDs or an unauthorized actor',async()=>{
  const {id}=approve(true);expect(await resolver.prepare(owner,id,1)).toBeUndefined();expect(secret).not.toHaveBeenCalled();
  db.prepare("UPDATE bot_decisions SET source_key='other' WHERE id=?").run(id);const unequal=approve();await expect(resolver.prepare({...owner,conversationId:ids.other},unequal.id,1)).rejects.toThrow();expect(secret).not.toHaveBeenCalled();
 });
 it.each(['missing','ambiguous','expired','revoked','business','owner','caller','credential-binding'])('denies %s registration before secret access',async kind=>{
  const {id}=approve();const r=registry.registrations[0]!;
  if(kind==='missing')registry.registrations=[];if(kind==='ambiguous')registry.registrations.push(structuredClone(r));if(kind==='expired')r.expires_at='2026-09-27T00:00:00Z';if(kind==='revoked')r.active=false;if(kind==='business')r.business_id=ids.foreign;if(kind==='owner')r.business_owner_user_id=2;if(kind==='caller')r.callers[0]!.user_id=2;if(kind==='credential-binding')r.callers.pop();
  await expect(resolver.prepare(owner,id,1)).rejects.toThrow();expect(secret).not.toHaveBeenCalled();
 });
 it.each(['principal','account','business','runtime','origin','absent','revoked-between-reads'])('denies capability %s drift',async kind=>{
  const {id}=approve();const base=get;let n=0;get=async(...args)=>{const result=await base(...args) as {access?:Record<string,unknown>};if(result.access){n++;if(kind==='principal'||(kind==='revoked-between-reads'&&n===2))result.access.principalId='foreign';if(kind==='account')result.access.accountId='foreign';if(kind==='business')result.access.nativeBusinessId=ids.foreign;if(kind==='runtime')result.access.runtime={...runtime,serviceId:ids.foreign};if(kind==='origin')result.access.sourceOrigin='https://foreign.invalid';if(kind==='absent')delete result.access.accountId;}return result;};resetResolver();
  await expect(resolver.prepare(owner,id,1)).rejects.toThrow('capability');expect(db.prepare('SELECT count(*) n FROM bot_message_delegations').get()).toEqual({n:0});
 });
 it.each(['id','ticketNumber','customerId','updatedAt'])('denies missing/conflicting source %s',async field=>{const {id}=approve();source[field]=field==='id'?ids.customer:field==='ticketNumber'?'FOREIGN':null;await expect(resolver.prepare(owner,id,1)).rejects.toThrow();});
 it.each(['registration','clock','caller','proposal','version','native-revoke'])('rejects %s change between network observation and transaction',async kind=>{
  const {id,p}=approve();const a=await services(owner,id);
  if(kind==='registration')registry.registrations[0]!.active=false;if(kind==='clock')now+=5001;if(kind==='proposal'){const proposal=JSON.parse((db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(id) as {proposal_json:string}).proposal_json);proposal.message_delivery.payload.body+=' changed';db.prepare('UPDATE bot_decisions SET proposal_json=? WHERE id=?').run(JSON.stringify(proposal),id);}if(kind==='version')db.prepare('UPDATE bot_decisions SET version=2 WHERE id=?').run(id);if(kind==='native-revoke')db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(ids.owner);
  expect(()=>a.bridge.delegate(kind==='caller'?executor:owner,id,1,named,'delegate',p)).toThrow();expect(db.prepare('SELECT count(*) n FROM bot_message_delegations').get()).toEqual({n:0});
 });
 it.each(['revision','customer','order','binding'])('blocks %s drift at inspect/accept/claim after delegation',async kind=>{
  const {id,p,g,d}=await setup();running(id);
  if(kind==='revision')source.updatedAt='2026-09-28T11:01:00Z';if(kind==='customer')source.customerId=ids.other;if(kind==='order')source.relatedOrderId=ids.other;if(kind==='binding')source.orderBindingVersion=1;
  const a=await services(executor,id);expect(()=>a.bridge.inspect(executor,id,1)).toThrow('mapping');expect(()=>a.bridge.accept(executor,g.id,'accept',p)).toThrow('mapping');expect(()=>a.messages.claim(executor,d.id,'claim',check(g.payload_hash))).toThrow('mapping');
 });
 it.each(['body','recipient','hash','executor'])('denies altered %s without changing the approved mapping',async kind=>{
  const {id,p,g,d}=await setup();running(id);const a=await services(executor,id);const changed=structuredClone(p);
  if(kind==='body')changed.payload.body+=' changed';if(kind==='recipient')changed.payload.recipients=['other@example.test'];if(kind==='executor')changed.executor_conversation_id=ids.other;
  if(kind==='hash')expect(()=>a.messages.claim(executor,d.id,'claim',check('0'.repeat(64)))).toThrow('hash');else expect(()=>a.bridge.accept(executor,g.id,'accept',changed)).toThrow('differs');
 });
 it('serializes concurrently prepared claims, unknown reconciliation and completed receipt without new execution',async()=>{
  const {id,p,g,d}=await setup();running(id);const [a,b]=await Promise.all([services(executor,id),services(executor,id)]);
  const results=await Promise.allSettled([Promise.resolve().then(()=>a.messages.claim(executor,d.id,'race-a',check(g.payload_hash))),Promise.resolve().then(()=>b.messages.claim(executor,d.id,'race-b',check(g.payload_hash)))]);
  expect(results.filter(r=>r.status==='fulfilled'&&r.value.execute)).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  a.messages.receipt(executor,d.id,'race-a','uncertain','Synthetic timeout');expect(()=>a.messages.claim(executor,d.id,'again',check(g.payload_hash))).toThrow();
  bots.result(owner,id,1,'complete',{state:'verified_completed',evidence:'Synthetic readback'});const before=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id);
  source.updatedAt='2026-09-28T11:05:00Z';const receipt=await services(executor,id,true);
  expect(()=>receipt.bridge.accept(executor,g.id,'accept',p)).toThrow('uncompleted');expect(()=>receipt.messages.claim(executor,d.id,'race-a')).toThrow('uncompleted');
  receipt.messages.receipt(executor,d.id,'race-a','sent','Synthetic exact readback',delivery(d.id,g.payload_hash));receipt.messages.receipt(executor,d.id,'race-a','sent','Synthetic exact readback',delivery(d.id,g.payload_hash));
  expect(()=>receipt.messages.receipt(executor,d.id,'race-a','sent','Synthetic exact readback',{...delivery(d.id,g.payload_hash),provider_message_id:'other'})).toThrow();
  expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id)).toEqual(before);expect(db.prepare('SELECT count(*) n FROM bot_message_delivery_proofs').get()).toEqual({n:1});
  source.customerId=ids.other;const wrong=await services(executor,id,true);expect(()=>wrong.messages.receipt(executor,d.id,'race-a','sent','Synthetic exact readback',delivery(d.id,g.payload_hash))).toThrow('mapping');
  capDrift='revoked';await expect(services(executor,id,true)).rejects.toThrow('capability');
 });
 it('uses the authenticated resolver through HTTP inspect/delegate/accept/claim/receipt with one racing claim',async()=>{
  const {id,p}=approve();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mapping-route-'));const file=path.join(dir,'registry.json');fs.writeFileSync(file,JSON.stringify(registry),{mode:0o600});
  const readSecret=vi.spyOn(secrets,'readSecretValue').mockImplementation(async(_deps,ref)=>({name:ref.name,project:ref.project??null,config:ref.config??null,value:ref.name}));
  const realFetch=globalThis.fetch;vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   const url=String(input);if(!url.startsWith(origin))return realFetch(input,init);
   const bearer=new Headers(init?.headers).get('Authorization')!.slice(7);return new Response(JSON.stringify(await get(url,bearer,init!.signal!)),{headers:{'content-type':'application/json'}});
  });
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=owner.user;req.agentConversationId=req.header('x-fixture-bot')??ids.owner;next();});app.use(createCommunicationRouter({db,config:{approvedCaseRegistryFile:file}} as AppContext));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const port=(server.address() as {port:number}).port;
  const post=(route:string,body:unknown,actor=ids.owner)=>realFetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json','x-fixture-bot':actor},body:JSON.stringify(body)});
  try{
   expect((await (await post('/approved-messages/inspect',{decision_id:id,expected_version:1})).json()).ready).toBe(true);
   const g=await (await post('/approved-messages/delegate',{decision_id:id,expected_version:1,executor_conversation_id:named,request_key:'delegate',scope:p})).json();expect(g.id).toBeTruthy();
   const d=await (await post('/approved-messages/accept',{delegation_id:g.id,request_key:'accept',scope:p},ids.executor)).json();expect(d.id).toBeTruthy();running(id);
   const replies=await Promise.all(['a','b'].map(claim_key=>post(`/drafts/${d.id}/claim`,{claim_key,send_check:check(g.payload_hash)},ids.executor)));expect(replies.map(r=>r.status).sort()).toEqual([200,409]);const winner=replies[0]!.status===200?'a':'b';
   bots.result(owner,id,1,'completed',{state:'verified_completed',evidence:'Synthetic fixture readback'});source.updatedAt='2026-09-28T12:00:00Z';
   const body={claim_key:winner,state:'sent',receipt:'Synthetic readback',delivery_proof:delivery(d.id,g.payload_hash)};
   expect((await post(`/drafts/${d.id}/receipt`,body,ids.executor)).status).toBe(200);expect((await post(`/drafts/${d.id}/receipt`,body,ids.executor)).status).toBe(200);
   expect((await post(`/drafts/${d.id}/claim`,{claim_key:winner},ids.executor)).status).toBe(409);
   expect(db.prepare('SELECT count(*) n FROM bot_message_delivery_proofs').get()).toEqual({n:1});expect(readSecret.mock.calls.some(c=>c[1].name==='FIXTURE_1_CREDENTIAL')).toBe(true);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('sanitizes source failures and rejects permission changes during fetch',async()=>{
  const {id}=approve();get=async()=>{throw new Error('sensitive source body');};resetResolver();await expect(resolver.prepare(owner,id,1)).rejects.not.toThrow('sensitive source body');
  get=async()=>{registry.registrations[0]!.active=false;return {};};resetResolver();await expect(resolver.prepare(owner,id,1)).rejects.toThrow();
 });
});

describe('protected registry and bounded transport',()=>{
 it('accepts only protected regular registry files and a fixed reviewed origin',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resolver-fixture-'));try{const file=path.join(dir,'registry.json');fs.writeFileSync(file,JSON.stringify(registration()),{mode:0o600});expect(loadApprovedCaseRegistry(file).registrations).toHaveLength(1);fs.chmodSync(file,0o644);expect(()=>loadApprovedCaseRegistry(file)).toThrow();fs.chmodSync(file,0o600);fs.symlinkSync(file,path.join(dir,'link'));expect(()=>loadApprovedCaseRegistry(path.join(dir,'link'))).toThrow();expect(()=>loadApprovedCaseRegistry(null)).toThrow();const altered=registration();Object.assign(altered.registrations[0]!,{source_origin:'http://127.0.0.1'});expect(approvedCaseRegistrySchema.safeParse(altered).success).toBe(false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('uses GET without redirects/cache and rejects oversized/error responses',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'fixture'})));vi.stubGlobal('fetch',fetcher);try{expect(await boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).toEqual({id:'fixture'});expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'GET',redirect:'error',cache:'no-store'});fetcher.mockResolvedValue(new Response('x'.repeat(1024*1024+1)));await expect(boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).rejects.toThrow('bound');fetcher.mockResolvedValue(new Response('private error',{status:403}));await expect(boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).rejects.toThrow('unavailable');}finally{vi.unstubAllGlobals();}
 });
});
