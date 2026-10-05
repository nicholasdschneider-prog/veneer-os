// Isolated retained receiver fixture. Never opens the live database or starts an agent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from '../server/dist/db/db.js';
import { createBotEventsWebhook } from '../server/dist/botWorkflows/routes.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'out/build582',crypto.randomUUID());
const db=openDb(directory);
const source=crypto.randomUUID(),task=crypto.randomUUID(),project=crypto.randomUUID();
db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Fixture','owner')").run();
db.prepare("INSERT INTO projects(id,slug,name) VALUES(?,'fixture','Fixture')").run(project);
db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('fixture-team','Fixture',1)").run();
db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES(?,'fixture-team',1,'Fixture')").run(source);
db.prepare(`INSERT INTO scheduled_tasks(id,user_id,assistant_id,project_id,name,prompt,schedule_json,timezone,provider,model,enabled,next_run_at) VALUES(?,1,1,?,'Fixture','Synthetic only','{"type":"daily","time":"09:00"}','UTC','claude','fixture',1,NULL)`).run(task,project);
db.prepare('INSERT INTO purchase_event_bindings VALUES(?,?,?,1,?)').run(source,task,'fixture-team',project);
const app=express();
// Key exists only for this fixture's lifetime, never persisted or reported.
const key=crypto.randomBytes(32);
app.use('/webhooks/bot-events',createBotEventsWebhook({db,secrets:{getApiKeyOverride:id=>id===`bot-event-source-${source}`?key:null}}));
const server=app.listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
const payload={schema_version:'lippert.purchase_candidate/v1',type:'order.purchase_candidate',id:crypto.randomUUID(),task_id:task,order_id:crypto.randomUUID(),order_revision:'a'.repeat(64),occurred_at:new Date().toISOString()};
const pathname='/webhooks/bot-events/'+source,body=JSON.stringify(payload);
const headers=bytes=>{const stamp=String(Math.floor(Date.now()/1000));return {'content-type':'application/json','x-veneer-timestamp':stamp,'x-veneer-signature':crypto.createHmac('sha256',key).update(stamp+bytes).digest('hex')};};
try {
 const posted=await fetch(base+pathname,{method:'POST',headers:headers('.'+body),body});
 if(posted.status!==200)throw Error('Fixture intake rejected');
 const intake=await posted.json();
 const getPath=pathname+'/purchase-events/'+payload.id;
 const read=await fetch(base+getPath,{headers:headers('.GET.'+getPath)});
 if(read.status!==200)throw Error('Fixture authenticated readback rejected');
 const retained=await read.json();
 if(JSON.stringify(intake.accepted)!==JSON.stringify(retained.receipt)||retained.delivery.worker_started!==false||retained.delivery.status!=='pending'||retained.receipt.purchase_authority!==false)throw Error('Fixture retained receipt mismatch');
 const rejected=await fetch(base+getPath,{headers:{'x-veneer-timestamp':String(Math.floor(Date.now()/1000)),'x-veneer-signature':'0'.repeat(64)}});
 if(rejected.status!==401)throw Error('Fixture unsigned readback accepted');
 const evidence={at:new Date().toISOString(),deployed_modules:['server/dist/botWorkflows/routes.js','server/dist/botWorkflows/purchaseEvents.js'].map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')})),fixture_directory:directory,post_status:posted.status,read_status:read.status,invalid_signature_status:rejected.status,intake,retained,actual_worker_started:false,live_task_run:false,public_access_verified:false};
 const output=path.join(root,'docs/reports/build582/deployed-fixture.json');
 fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({fixture_directory:directory,evidence:output,post_status:posted.status,read_status:read.status,worker_started:false}));
} finally {
 await new Promise(r=>server.close(r));db.close();key.fill(0);
}
