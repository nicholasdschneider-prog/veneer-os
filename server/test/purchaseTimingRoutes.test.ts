import Database from 'better-sqlite3';
import express from 'express';
import {it,expect} from 'vitest';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {purchaseTimingVerifierRoutes,purchaseTimingSetupRoutes} from '../src/bots/purchaseTimingRoutes.js';
import type {AppContext} from '../src/context.js';
import type {UserRow} from '../src/db/db.js';
it('keeps dedicated service auth separate from owner setup and returns strict errors',async()=>{
 const db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner')").run();
 const ctx={db,config:{identity:'cloudflare',cfTeamDomain:'fixture.cloudflareaccess.com',cfAud:'human',purchaseTimingCfAud:'timing',purchaseTimingClientId:'client'}} as AppContext;
 const app=express();app.use('/verifier',purchaseTimingVerifierRoutes(ctx,async req=>req.headers['x-fixture-service']==='yes'?{kind:'purchase_timing_verifier',clientId:'client',audience:'timing'}:null));
 app.use(express.json());app.use('/setup',(req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;if(req.headers['x-fixture-bot'])req.agentConversationId='bot';next();},purchaseTimingSetupRoutes(ctx));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  for(const url of ['/verifier/verify','/verifier/claims','/verifier/captures']){
   const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(401);expect(await r.json()).toMatchObject({code:'IDENTITY_REJECTED',execute:false});
   const invalid=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-service':'yes'},body:'{"approved":true}'});expect(invalid.status).toBe(400);expect(await invalid.json()).toMatchObject({code:'INVALID_FIELDS',execute:false});
  }
  const bot=await fetch(base+'/setup',{headers:{'x-fixture-bot':'yes'}});expect(bot.status).toBe(403);
  const options=await fetch(base+'/setup');expect(await options.json()).toMatchObject({configured:true,businesses:[]});
  const malformed=await fetch(base+'/verifier/claims',{method:'POST',headers:{'Content-Type':'application/json','x-fixture-service':'yes'},body:'{'});expect(malformed.status).toBe(400);expect(await malformed.json()).toMatchObject({execute:false});
  const missing=await fetch(base+'/verifier/trusts/no-trust/claims/intent',{headers:{'x-fixture-service':'yes'}});expect(missing.status).toBe(404);expect(await missing.json()).toMatchObject({code:'NOT_FOUND',execute:false});
 }finally{server.close();db.close();}
});
