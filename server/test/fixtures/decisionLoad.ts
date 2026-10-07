import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { proposalSchema } from '../../src/bots/service.js';
import type { UserRow } from '../../src/db/db.js';

/** Synthetic native history only. No credentials, source accounts or customers. */
export function decisionLoad(history = 540) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  migrate(db, fileURLToPath(new URL('../../src/db/migrations', import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner'),(2,'staff@test','Staff','member'),(3,'limited@test','Limited','member')").run();
  db.prepare('INSERT INTO employee_workspaces VALUES(2),(3)').run();
  const decision=db.prepare(`INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,state,proposal_json,assignee_id,created_at) VALUES(?,?,?,?,?,?,1,?)`);
  const event=db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES(?,?,1,?,1,?,?,?)');
  const thread=db.prepare('INSERT INTO bot_decision_threads(id,decision_id,actor_id,actor_conversation_id,text) VALUES(?,?,1,?,?)');
  db.transaction(()=>{
    for(let i=0;i<6;i++) {
      const bot=`load-${i}`;
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(bot,bot,bot);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(bot,bot);
      db.prepare('INSERT INTO shared_bot_queues VALUES(?)').run(bot);
      db.prepare('INSERT INTO employee_bot_access VALUES(2,?)').run(bot);
      if(i===0) db.prepare('INSERT INTO employee_bot_access VALUES(3,?)').run(bot);
    }
    for(let i=0;i<history+18;i++) {
      const bot=`load-${i%6}`, id=`decision-${i}`;
      const proposal=proposalSchema.parse({question:`Review synthetic case ${i}?`,recommendation:'Use internal draft.',consequence:'Fixture only.',blocked_action:'Internal fixture',assignee_id:1,evidence:[{conversation_id:bot,label:'Synthetic native context'}],choices:[{id:'use',label:'Use internal draft',action:'approve',answer:'draft'},{id:'pause',label:'Pause fixture review',action:'defer'}]});
      decision.run(id,bot,id,id,i<history?'decided':'needs_input',JSON.stringify(proposal),new Date(Date.UTC(2026,8,1)+i*1000).toISOString());
      // A prior bot reply plus two human messages exercises thread/event joins
      // and the current discussion status subqueries for every historical row.
      for(let j=0;j<3;j++) {
        const eid=`${id}-message-${j}`, actor=j===0?bot:null;
        event.run(eid,id,'message',actor,JSON.stringify({text:'Synthetic discussion'}),eid);
        thread.run(eid,id,actor,'Synthetic discussion');
      }
      if(i<history) {
        const eid=`${id}-answered`;
        event.run(eid,id,'answered',null,JSON.stringify({action:'defer',text:'Fixture defer',scope:'this_case'}),eid);
        db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,status) VALUES(?,?,?,'Fixture only',?,'delivered')").run(eid,bot,eid,'2026-09-01T00:00:00Z');
      }
    }
  })();
  const users=db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  return { db, users };
}

export function countReads(db: Database.Database) {
  const counts={prepare:0,reads:0};
  const observed=new Proxy(db,{get(target,prop){
    if(prop==='prepare')return(sql:string)=>{
      counts.prepare++;
      const stmt=target.prepare(sql);
      return new Proxy(stmt,{get(s,method){const value=Reflect.get(s,method,s);
        if(method==='get'||method==='all')return(...args:unknown[])=>{counts.reads++;return value.apply(s,args);};
        return typeof value==='function'?value.bind(s):value;
      }});
    };
    const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  }});
  return { db:observed, counts, reset(){counts.prepare=0;counts.reads=0;} };
}
