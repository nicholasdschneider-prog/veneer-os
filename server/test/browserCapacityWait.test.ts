import {createConversationWakeupScheduler} from '../src/scheduled/wakeups.js';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import {migrate} from '../src/db/migrate.js';
import {createCapacityWaits,browserCapacityWakeAllowed} from '../src/veneerBrowser/capacityWait.js';
let db:Database.Database; let free:boolean; let open:ReturnType<typeof vi.fn>; let busy:boolean;
const input={request_key:'task-one',task:'Continue authorized research',timeout_minutes:60};
function service(){return createCapacityWaits({db,clientScope:()=> 'test',authorize:()=>{},open,available:async()=>free,busy:()=>busy});}
beforeEach(()=>{db=new Database(':memory:');migrate(db,path.resolve('src/db/migrations'));db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@example.com','One','owner'),(2,'two@example.com','Two','owner')").run();
 for(let i=1;i<=8;i++)db.prepare("INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id) VALUES(?,1,1,'claude',?)").run(`c${i}`,`native${i}`);
 free=false;busy=false;open=vi.fn(async()=>{});
});
afterEach(()=>{db.close();vi.useRealTimers();});
it('retains bounded FIFO work across reconstruction and opens more than five chats without commands',async()=>{
 const q=service();for(let i=1;i<=8;i++)q.register(1,`c${i}`,input);
 await q.tick();expect(open).not.toHaveBeenCalled();free=true;
 const recovered=service();for(let i=1;i<=8;i++)await recovered.tick();
 expect(open.mock.calls.map(x=>x[1])).toEqual(Array.from({length:8},(_,i)=>`c${i+1}`));
 expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:8});
 await recovered.tick();expect(open).toHaveBeenCalledTimes(8);
});
it('same key is idempotent, conflicting context and duplicate waiting task are refused',()=>{
 const q=service(),a=q.register(1,'c1',input);expect(q.register(1,'c1',input)).toEqual(a);
 expect(()=>q.register(1,'c1',{...input,task:'Different'})).toThrow();expect(()=>q.register(1,'c1',{...input,request_key:'new'})).toThrow();
 expect(()=>q.register(2,'c1',input)).toThrow();
});
it('cancels before allocation on new human instructions or owner changes',async()=>{
 const q=service();q.register(1,'c1',input);q.register(1,'c2',input);
 db.prepare("UPDATE conversations SET last_user_activity_at='2026-09-29T12:00:00Z' WHERE id='c1'").run();
 db.prepare("UPDATE conversations SET user_id=2 WHERE id='c2'").run();free=true;await q.tick();expect(open).not.toHaveBeenCalled();expect(q.status('c1')?.status).toBe('cancelled');
});
it('expiration delivers one blocker wake without allocation',async()=>{
 const q=service();q.register(1,'c1',input);db.prepare("UPDATE browser_capacity_waits SET expires_at='2000-01-01T00:00:00Z'").run();await q.tick();await q.tick();
 expect(open).not.toHaveBeenCalled();expect(q.status('c1')?.status).toBe('expired');expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:1});
});
it('cancellation suppresses both pending allocation and undelivered wake',async()=>{
 const q=service();q.register(1,'c1',input);free=true;await q.tick();const w=db.prepare('SELECT id FROM conversation_wakeups').get() as {id:string};
 expect(browserCapacityWakeAllowed(db,w.id)).toBe(true);q.cancel(1,'c1');expect(browserCapacityWakeAllowed(db,w.id)).toBe(false);
 expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual({status:'cancelled'});
});
it('scope is rechecked at wake dispatch, and active turns cannot be admitted',async()=>{
 const q=service();q.register(1,'c1',input);free=true;busy=true;await q.tick();expect(open).not.toHaveBeenCalled();busy=false;await q.tick();
 const w=db.prepare('SELECT id FROM conversation_wakeups').get() as {id:string};db.prepare("UPDATE conversations SET archived=1 WHERE id='c1'").run();expect(browserCapacityWakeAllowed(db,w.id)).toBe(false);
});
it('capacity errors retain the wait, uncertain errors produce one failure wake',async()=>{
 const q=service();q.register(1,'c1',input);free=true;open.mockRejectedValueOnce(new Error('Browser capacity is busy.'));
 await q.tick();expect(q.status('c1')?.status).toBe('waiting');open.mockRejectedValueOnce(new Error('lost response'));await q.tick();await q.tick();expect(q.status('c1')?.status).toBe('failed');expect(open).toHaveBeenCalledTimes(2);
});
it('interrupted allocation requests reconciliation only, never a new blind attempt',async()=>{
 const q=service();q.register(1,'c1',input);db.prepare("UPDATE browser_capacity_waits SET status='admitting'").run();await service().tick();expect(open).toHaveBeenCalledWith(1,'c1',true,expect.any(Function));
});

it('automatic waits cannot loop after expiry in the same human task context',async()=>{
 const q=service();const a=q.automatic(1,'c1');expect(q.automatic(1,'c1')).toEqual(a);
 db.prepare("UPDATE browser_capacity_waits SET expires_at='2000-01-01T00:00:00Z'").run();await q.tick();
 expect(q.automatic(1,'c1').status).toBe('expired');expect(db.prepare('SELECT count(*) n FROM browser_capacity_waits').get()).toEqual({n:1});
});

it('delivers a ready wake once through the existing scheduler, with no browser commands',async()=>{
 const q=service();q.register(1,'c1',input);free=true;await q.tick();
 const deliverWakeup=vi.fn((_conv:any,_text:string,_id:string,_actor?:number|null)=>({disposition:'queued'} as any));
 const scheduler=createConversationWakeupScheduler({db,manager:{deliverWakeup},log:{info:()=>{},warn:()=>{},error:()=>{}}});
 scheduler.tick();scheduler.tick();expect(deliverWakeup).toHaveBeenCalledTimes(1);
 expect(deliverWakeup.mock.calls[0]?.[1]).toContain('Never replay an uncertain mutation');
 expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual({status:'delivered'});
});
it('cancels a changed selected profile before allocation',async()=>{
 const q=service();q.register(1,'c1',input);
 db.prepare("INSERT INTO veneer_browser_profiles(id,client_scope,project_id,name,owner_user_id,created_by) VALUES('changed-profile','test','unfiled-user-1','Changed',1,1)").run();
 db.prepare("INSERT INTO veneer_browser_project_settings(project_id,client_scope,user_id,default_profile_id,updated_at) VALUES('unfiled-user-1','test',1,'changed-profile',datetime('now'))").run();
 free=true;await q.tick();expect(open).not.toHaveBeenCalled();expect(q.status('c1')?.status).toBe('cancelled');
});

it('cancellation during the capacity probe prevents allocation',async()=>{
 let release!:()=>void;
 const available=()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);});
 const q=createCapacityWaits({db,clientScope:()=> 'test',authorize:()=>{},open,available,busy:()=>false});
 q.register(1,'c1',input);const ticking=q.tick();q.cancel(1,'c1');release();await ticking;
 expect(open).not.toHaveBeenCalled();expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:0});
});
it('cancellation during an in-flight allocation suppresses its wake without killing the copy',async()=>{
 let release!:()=>void;open.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
 const q=service();q.register(1,'c1',input);free=true;const ticking=q.tick();await new Promise(resolve=>setImmediate(resolve));
 q.cancel(1,'c1');release();await ticking;
 expect(q.status('c1')?.status).toBe('cancelled');expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:0});
});
