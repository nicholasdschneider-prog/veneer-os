import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { questionLine } from '../src/bots/questionLine.js';
import { QuestionHotline } from '../src/voice/hotline.js';
import type { UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';

describe('global question line and hotline',()=>{
 let db: Database.Database; let user:UserRow; let service:ReturnType<typeof createBotService>; let ctx:AppContext;
 const raise=(bot:string,key:string)=>service.raise({user,conversationId:bot},{source_key:key,proposal_key:key,proposal:proposalSchema.parse({question:`Review ${key}?`,recommendation:'Use the internal draft.',consequence:'Internal test only.',assignee_id:1,blocked_action:'Internal fixture',choices:[{id:'use',label:'Use draft',action:'approve',answer:'draft',recommended:true},{id:'hold',label:'Hold',action:'defer'}]})});
 beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'other@example.test','Other','member')").run();
  user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
  service=createBotService(db);
  for(const bot of ['a','b','c']) {db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'private')").run(bot,bot,bot);service.register({user},bot,`Bot ${bot}`,true);}
  ctx={db} as AppContext;
 });
 afterEach(()=>{vi.useRealTimers();db.close();});
 it('interleaves bots rather than making a twenty-question bot monopolize the line',()=>{
  const a=raise('a','a1'),a2=raise('a','a2'),b=raise('b','b1'),c=raise('c','c1');
  const line=questionLine(ctx,user);const ids=line.snapshot().decisions.map(d=>d.conversation_id);
  expect(ids.slice(0,3).sort()).toEqual(['a','b','c']);expect(ids[3]).toBe('a');
  line.mutate({action:'select',decisionId:a.id,revision:0});
  service.choose({user},a.id,1,'answer','use','','this_case');
  const next=line.snapshot();expect(next.selectedId).toBeNull();expect(next.decisions.at(-1)?.id).toBe(a2.id);expect(next.decisions).toHaveLength(3);
 });
 it('skip and timed reminders persist without answering or waking business work',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-01T14:00:00Z'));
  const a=raise('a','a'),b=raise('b','b');const line=questionLine(ctx,user);
  line.mutate({action:'select',decisionId:a.id,revision:0});
  line.mutate({action:'remind',decisionId:a.id,until:Date.now()+60000,revision:1});
  expect(questionLine(ctx,user).snapshot().decisions.map(d=>d.id)).toEqual([b.id]);
  expect(service.view({user},service.read({user},a.id)).answer).toBeNull();
  vi.advanceTimersByTime(60001);expect(line.snapshot().sleeping).toHaveLength(0);expect(line.snapshot().decisions).toHaveLength(2);
  expect(()=>line.mutate({action:'select',decisionId:a.id,revision:0})).toThrow(/changed/);
 });
 it('does not expose other users’ private questions or permit guessed selections',()=>{
  const a=raise('a','a');const other=db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
  const line=questionLine(ctx,other);expect(line.snapshot().decisions).toEqual([]);
  expect(()=>line.mutate({action:'select',decisionId:a.id,revision:0})).toThrow(/available/);
  expect(()=>new QuestionHotline(ctx,2).workspace(a.id)).toThrow();
 });
 it('pins each hotline action to selected question and rechecks versions, access and answered state',()=>{
  const a=raise('a','a'),b=raise('b','b');const h=new QuestionHotline(ctx,1);
  h.navigate('select',a.id);expect(h.focus(a.id).bot).toBe('Bot a');expect(()=>h.workspace(b.id)).toThrow(/Select/);
  expect(()=>h.workspace(a.id).answerChoice('session',{decisionId:a.id,version:99,choiceId:'use',text:'Use draft'})).toThrow();
  const result=h.workspace(a.id).answerChoice('session',{decisionId:a.id,version:1,choiceId:'use',text:'Use draft'});expect(result.ok).toBe(true);
  expect(()=>h.workspace(a.id)).toThrow();expect(h.navigate('next')).toMatchObject({bot:'Bot b',decisionId:b.id});
  db.prepare("UPDATE conversations SET archived=1 WHERE id='b'").run();
  expect(h.focus(b.id)).toMatchObject({bot:'Bot b'}); // archive does not silently confer execution permission
  db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>h.list()).toThrow(/Caller/);
 });
 it('removes answered and withdrawn questions, even when a reminder was pending',()=>{
  const a=raise('a','a');const line=questionLine(ctx,user);line.mutate({action:'remind',decisionId:a.id,until:Date.now()+60000,revision:0});
  service.choose({user},a.id,1,'answer','hold','','this_case');expect(line.snapshot().decisions).toEqual([]);expect(line.snapshot().sleeping).toEqual([]);
 });
 it('does not turn skipping into native defer and supports out-of-order selection',()=>{
  const a=raise('a','a'),b=raise('b','b');const h=new QuestionHotline(ctx,1);h.navigate('select',b.id);h.navigate('skip');
  expect(service.view({user},service.read({user},b.id)).state).toBe('needs_input');expect(h.navigate('next')).toMatchObject({decisionId:a.id});
 });
});
