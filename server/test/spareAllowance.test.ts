import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { eligibility, businessHours, type SpareAccount } from '../src/spareAllowance/policy.js';
import { recordCheckpoint, spareBinding, spareRun } from '../src/spareAllowance/store.js';
import { createSpareScheduler } from '../src/spareAllowance/scheduler.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ConversationRow } from '../src/db/db.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';
import { mintAgentToken, resolveAgentTokenContext } from '../src/runtime/agentTokens.js';
import { botFeatureCatalog, botFeatureInstructions } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';

const NOW = Date.parse('2026-10-09T22:00:00Z'); // 6 p.m. Eastern
function account(now=NOW): SpareAccount {
  return {provider:'codex',accountId:'spare',label:'Spare',connected:true,paidUsageDisabled:true,source:'live',capturedAt:new Date(now).toISOString(),windows:[{id:'weekly',label:'Weekly',usedPercent:80,windowMinutes:10080,resetsAt:'2026-10-10T04:00:00.000Z',status:null}]};
}
describe('spare allowance scheduling policy',()=>{
  it('uses actual account reset times and protects the entire remaining business interval',()=>{
    expect(eligibility(account(),NOW)).toMatchObject({reason:'Eligible',reset:'2026-10-10T04:00:00.000Z',deadline:'2026-10-09T22:02:00.000Z'});
    const early=Date.parse('2026-10-10T10:00:00Z');
    const a=account(early);a.windows[0]!.resetsAt='2026-10-10T16:00:00Z';
    expect(eligibility(a,early).reason).toBe('Business hours before reset');
    expect(eligibility(account(),Date.parse('2026-10-09T20:00:00Z')).reason).toBe('Business hours');
  });
  it('handles the Eastern DST fall-back and protects weekends too',()=>{
    expect(businessHours(Date.parse('2026-11-01T12:59:00Z'))).toBe(false);
    expect(businessHours(Date.parse('2026-11-01T13:00:00Z'))).toBe(true);
    expect(businessHours(Date.parse('2026-11-01T21:59:00Z'))).toBe(true);
    expect(businessHours(Date.parse('2026-11-01T22:00:00Z'))).toBe(false);
  });
  it('requires live complete fresh meters and a proven unavailable paid fallback',()=>{
    expect(eligibility({...account(),source:'sessions'},NOW).reason).toBe('Fresh provider telemetry required');
    expect(eligibility({...account(),capturedAt:new Date(NOW-31_000).toISOString()},NOW).reason).toBe('Fresh provider telemetry required');
    expect(eligibility({...account(),paidUsageDisabled:false},NOW).reason).toBe('Paid fallback not verified disabled');
    const missing=account();missing.windows[0]!.resetsAt=null;
    expect(eligibility(missing,NOW).reason).toBe('Incomplete or expired usage windows');
  });
  it('honors short/model windows, targets the reserve conservatively and does not cross reset',()=>{
    const a=account();a.windows.push({...a.windows[0]!,id:'short',windowMinutes:300,usedPercent:99});
    expect(eligibility(a,NOW).reason).toBe('1% reserve reached');
    a.windows[1]!.usedPercent=98;
    expect(eligibility(a,NOW).reason).toBe('Allowance too close to reserve for another batch');
    a.windows[1]!.usedPercent=20;a.windows[1]!.resetsAt=new Date(NOW+45_000).toISOString();
    expect(eligibility(a,NOW).reason).toBe('Insufficient time for a checkpoint');
  });
});

describe('durable optional execution',()=>{
  let db:Database.Database;
  let manager:ReturnType<typeof createConversationManager>;
  let scheduler:ReturnType<typeof createSpareScheduler>;
  let lastSpec:TurnSpec|undefined;
  let emit:((event:ConversationEvent)=>void)|undefined;
  let finish:(()=>void)|undefined;
  let killed:ReturnType<typeof vi.fn>;
  let load:ReturnType<typeof vi.fn>;
  beforeEach(()=>{
    lastSpec=undefined;emit=undefined;finish=undefined;
    vi.useFakeTimers();vi.setSystemTime(NOW);
    db=new Database(':memory:');db.pragma('foreign_keys=ON');
    migrate(db,path.join(path.dirname(fileURLToPath(import.meta.url)),'../src/db/migrations'));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.com','Owner','owner')").run();
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,model,native_session_id,channel) VALUES('source',1,1,'Piper','codex','gpt-test','native','web'),('normal',1,1,'Normal','codex','gpt-test','normal-native','web')").run();
    db.prepare("INSERT INTO spare_allowance_tasks(id,request_key,user_id,conversation_id,title,prompt,output,provider,model,account_ids_json,max_batches) VALUES('task','request',1,'source','Gallery','Prepare local drafts','Six accurate images','codex','gpt-test','[\"spare\"]',3)").run();
    killed=vi.fn();
    const adapter:ProviderAdapter={id:'codex',mintSessionId:()=> 'native',readTranscript:async()=>[],runTurn(spec,onEvent){
      lastSpec=spec;emit=onEvent;
      const done=new Promise<void>(resolve=>{finish=()=>{onEvent({type:'turn_done',turnId:spec.turnId,outcome:'completed'});resolve();};killed.mockImplementation(()=>{onEvent({type:'turn_done',turnId:spec.turnId,outcome:'timed_out'});resolve();});});
      return {done,kill:killed,respondToApproval:()=>false};
    }};
    manager=createConversationManager({db,adapters:{codex:adapter},resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'assistant',elevated:false,fullAccess:true}),approvalTimeoutMs:60000,log:{warn:()=>{},error:()=>{}}});
    load=vi.fn(async()=>[account(Date.now())]);
    scheduler=createSpareScheduler({db,manager,loadAccounts:load});scheduler.start();
  });
  afterEach(async()=>{scheduler.stop();manager.shutdown();await Promise.resolve();await Promise.resolve();db.close();vi.useRealTimers();});
  it('binds the real TurnSpec to the spare account, limits time and disables Full Access',async()=>{
    await scheduler.tick();
    expect(lastSpec).toMatchObject({subscriptionAccountId:'spare',optionalDeadline:NOW+120000,dangerous:false,conversationId:'source'});
    expect(spareRun(db,'source')?.status).toBe('running');
    await scheduler.tick();expect(load).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT count(*) n FROM spare_allowance_runs').get()).toEqual({n:1});
  });
  it('advances only after an immutable explicit checkpoint and successful turn completion',async()=>{
    await scheduler.tick();recordCheckpoint(db,'source',{outcome:'progress',cursor:'model saved, cameras next',summary:'Saved the source-grounded model'});
    expect(()=>recordCheckpoint(db,'source',{outcome:'completed',cursor:null,summary:'Different'})).toThrow('already recorded');
    finish!();await Promise.resolve();
    expect(db.prepare('SELECT completed_batches,status,cursor FROM spare_allowance_tasks').get()).toMatchObject({completed_batches:1,status:'ready',cursor:'model saved, cameras next'});
    await scheduler.tick();expect(load).toHaveBeenCalledTimes(2);
    recordCheckpoint(db,'source',{outcome:'completed',cursor:null,summary:'All requested gallery drafts saved'});finish!();await Promise.resolve();
    await scheduler.tick();
    expect(db.prepare('SELECT completed_batches,status FROM spare_allowance_tasks').get()).toEqual({completed_batches:2,status:'completed'});
    expect(db.prepare('SELECT count(*) n FROM spare_allowance_runs').get()).toEqual({n:2});
  });
  it('does not treat a completed turn with no checkpoint as completed task work',async()=>{
    await scheduler.tick();finish!();await Promise.resolve();await scheduler.tick();
    expect(db.prepare('SELECT status FROM spare_allowance_tasks').get()).toEqual({status:'blocked'});
    expect(db.prepare('SELECT status FROM spare_allowance_runs').get()).toEqual({status:'unknown'});
  });
  it('preempts immediately for normal work and never spends a fresh cycle or restarts the unknown batch',async()=>{
    await scheduler.tick();
    const conv=db.prepare("SELECT * FROM conversations WHERE id='normal'").get() as ConversationRow;
    manager.postMessage(conv,'Human work');expect(killed).toHaveBeenCalled();await Promise.resolve();
    expect(db.prepare('SELECT status FROM spare_allowance_tasks').get()).toEqual({status:'blocked'});
    expect(db.prepare('SELECT status FROM spare_allowance_runs').get()).toEqual({status:'unknown'});
    vi.setSystemTime('2026-10-10T04:00:00Z');await scheduler.tick();
    expect(db.prepare('SELECT count(*) n FROM spare_allowance_runs').get()).toEqual({n:1});
  });
  it('fences optional callbacks after pause, reserve, identity drift and restart',async()=>{
    await scheduler.tick();const run=spareRun(db,'source')!;
    const token=mintAgentToken(db,'owner@example.com','source',null,run.id);
    expect(resolveAgentTokenContext(db,token)?.spareRunId).toBe(run.id);
    db.prepare('UPDATE spare_allowance_settings SET enabled=0').run();scheduler.monitor();
    expect(resolveAgentTokenContext(db,token)).toBeNull();expect(spareBinding(db,run.id,'source')).toBeUndefined();
    expect(killed).toHaveBeenCalled();
  });
  it('keeps provider/model changes and stale usage from starting a batch',async()=>{
    db.prepare("UPDATE conversations SET model='different' WHERE id='source'").run();
    await scheduler.tick();expect(lastSpec).toBeUndefined();
    db.prepare("UPDATE conversations SET model='gpt-test' WHERE id='source'").run();
    vi.setSystemTime(NOW+11000);load.mockResolvedValue([{...account(),capturedAt:new Date(NOW-60000).toISOString()}]);
    await scheduler.tick();expect(lastSpec).toBeUndefined();
  });
  it('blocks a crash-interrupted batch instead of replaying its pending turn',async()=>{
    await scheduler.tick();scheduler.stop();
    const replacement=createSpareScheduler({db,manager,loadAccounts:load});replacement.start();replacement.stop();
    expect(db.prepare('SELECT status,reason FROM spare_allowance_runs').get()).toMatchObject({status:'unknown',reason:'Runner restarted; prior batch outcome unknown'});
    expect(db.prepare('SELECT status FROM spare_allowance_tasks').get()).toEqual({status:'blocked'});
  });
  it('stops at deadline even without an account refresh and waits on native permission prompts',async()=>{
    await scheduler.tick();emit!({type:'approval_requested',requestId:'permission',toolName:'Bash',input:{command:'blender'}});
    scheduler.monitor();expect(killed).toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM spare_allowance_tasks').get()).toEqual({status:'blocked'});
  });
});

it('delivers owner setup and optional boundaries to employees and fresh/resumed bots',()=>{
  const feature=botFeatureCatalog(NOW).features.find(f=>f.id==='spare-allowance')!;
  expect(feature.isNew).toBe(true);expect(feature.steps.join(' ')).toContain('Settings → Usage');
  expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
  expect(botFeatureInstructions()).toContain(feature.prompt);
  for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'piper',elevated})).toContain(feature.prompt);
});
