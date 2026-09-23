import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { bindDecisionImages, readDecisionImage, rasterType } from '../src/bots/decisionImages.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import express from 'express';
import { createBotsRouter } from '../src/bots/routes.js';
import type { Server } from 'node:http';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZEAAAAAASUVORK5CYII=', 'base64');
describe('decision image evidence', () => {
  let db: Database.Database, dir: string, file: string, ctx: AppContext, actor: Actor;
  let s: ReturnType<typeof createBotService>;
  const servers: Server[] = [];
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test.invalid','Owner','owner'),(2,'employee@test.invalid','Employee','member')").run();
    for (const id of ['bot','source','foreign']) db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(id,id,id);
    actor = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow, conversationId:'bot' };
    s = createBotService(db); s.register({user:actor.user}, 'bot','Fixture',true);
    dir=realpathSync(mkdtempSync(join(tmpdir(),'decision-images-'))); file=join(dir,'photo.png'); writeFileSync(file,png);
    ctx={db, manager:{listSessionFiles:vi.fn(async (id:string)=>id==='source'?[{path:file,source:'write'}]:[])}} as unknown as AppContext;
  });
  afterEach(async () => {for(const server of servers.splice(0)) await new Promise<void>(resolve=>server.close(()=>resolve())); db.close(); rmSync(dir,{recursive:true,force:true});});
  const proposal = (images: unknown = undefined) => proposalSchema.parse({question:'Review the supplied photo?',recommendation:'Review the evidence.',consequence:'Fixture only.',blocked_action:'Wait for the decision.',assignee_id:1, ...(images ? {images} : {})});
  const refs = () => [{conversation_id:'source',path:file,label:'Customer photo',source:'Customer · fixture ticket'}];
  async function raise() {const p=await bindDecisionImages(ctx,actor,'bot',proposal(refs()));return s.raise(actor,{source_key:'fixture',proposal_key:'photo',proposal:p});}
  it('binds exact bytes and serves them only for the current decision version', async()=>{
    const d=await raise(); expect(d.proposal.images?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const image=await readDecisionImage(ctx,actor,d.id,1,0); expect(image.bytes).toEqual(png);expect(image.type).toBe('image/png');
    await expect(readDecisionImage(ctx,actor,d.id,2,0)).rejects.toThrow('Proposal changed');
    await expect(readDecisionImage(ctx,actor,d.id,1,1)).rejects.toThrow('unavailable');
    writeFileSync(file,Buffer.concat([png,Buffer.from('changed')]));
    await expect(readDecisionImage(ctx,actor,d.id,1,0)).rejects.toThrow('Image or proposal changed');
    await expect(bindDecisionImages(ctx,actor,'bot',d.proposal)).rejects.toThrow('Image changed');
    const revised=await bindDecisionImages(ctx,actor,'bot',proposal(refs()));
    const next=s.revise(actor,d.id,1,'revision',revised);expect(next.version).toBe(2);expect(next.answer).toBeNull();
    await expect(readDecisionImage(ctx,actor,d.id,1,0)).rejects.toThrow('Proposal changed');
    expect((await readDecisionImage(ctx,actor,d.id,2,0)).bytes.length).toBeGreaterThan(png.length);
  });
  it('rejects unrelated paths, symlinks, remote URLs, nonimages, oversize and vanished files',async()=>{
    const other=join(dir,'other.png');writeFileSync(other,png);
    await expect(bindDecisionImages(ctx,actor,'bot',proposal([{...refs()[0],path:other}]))).rejects.toThrow('unavailable');
    await expect(bindDecisionImages(ctx,actor,'bot',proposal([{...refs()[0],path:'https://example.test/photo.png'}]))).rejects.toThrow('unavailable');
    writeFileSync(file,'<svg onload="alert(1)"></svg>');await expect(raise()).rejects.toThrow('unavailable');
    writeFileSync(file,Buffer.alloc(20*1024*1024+1));await expect(raise()).rejects.toThrow('unavailable');
    rmSync(file);symlinkSync(other,file);await expect(raise()).rejects.toThrow('unavailable');
    rmSync(file);await expect(raise()).rejects.toThrow('unavailable');
  });
  it('rechecks employee source access and revocation on every retrieval',async()=>{
    const d=await raise(); const employee={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};
    db.prepare('INSERT INTO employee_workspaces(user_id) VALUES(2)').run();
    db.prepare("INSERT INTO employee_bot_access(user_id,conversation_id) VALUES(2,'bot')").run();
    await expect(readDecisionImage(ctx,employee,d.id,1,0)).rejects.toThrow();
    db.prepare("INSERT INTO employee_bot_access(user_id,conversation_id) VALUES(2,'source')").run();
    expect((await readDecisionImage(ctx,employee,d.id,1,0)).type).toBe('image/png');
    db.prepare("DELETE FROM employee_bot_access WHERE conversation_id='source'").run();
    await expect(readDecisionImage(ctx,employee,d.id,1,0)).rejects.toThrow();
  });
  it('rejects cross-business evidence even when the owner can view both businesses',async()=>{
    db.prepare("INSERT INTO business_teams(id,owner_id,name) VALUES('a',1,'A'),('b',1,'B')").run();
    db.prepare("UPDATE conversations SET business_team_id=CASE WHEN id='bot' THEN 'a' ELSE 'b' END").run();
    await expect(raise()).rejects.toThrow();
  });
  it('keeps old proposals valid without inventing image evidence',async()=>{
    const p=proposal(); expect(await bindDecisionImages(ctx,actor,'bot',p)).toEqual(p);
    const d=s.raise(actor,{source_key:'legacy',proposal_key:'old',proposal:p});
    expect(d.proposal.images).toBeUndefined();await expect(readDecisionImage(ctx,actor,d.id,1,0)).rejects.toThrow('unavailable');
    expect(employeeRouteAllowed('GET',`/bots/decisions/${d.id}/images/1/0`)).toBe(true);
    expect(employeeRouteAllowed('POST',`/bots/decisions/${d.id}/images/1/0`)).toBe(false);
  });
  it('binds images at the proposal HTTP boundary and refuses forged hashes', async()=>{
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=actor.user;req.agentConversationId='bot';next();});app.use('/api/bots',createBotsRouter(ctx));
    const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/api/bots/decisions`;
    const post=(images:unknown)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_key:'http',proposal_key:'image',proposal:proposal(images)})});
    expect((await post([{...refs()[0],sha256:'0'.repeat(64)}])).status).toBe(409);
    const response=await post(refs());expect(response.status).toBe(200);const body=await response.json();expect(body.decision.proposal.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>s.raise(actor,{source_key:'unbound',proposal_key:'image',proposal:proposal(refs())})).toThrow('bound');
  });
  it('serves authenticated raster bytes with private no-store headers and validates indexes',async()=>{
    const d=await raise();const app=express();app.use((req,_res,next)=>{req.user=actor.user;next();});app.use('/api/bots',createBotsRouter(ctx));
    const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address() as {port:number}; const url=`http://127.0.0.1:${address.port}/api/bots/decisions/${d.id}/images/1/`;
    const r=await fetch(url+'0');expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(r.headers.get('content-type')).toContain('image/png');expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(url+'99')).status).toBe(400);
  });
  it('never accepts SVG or HTML as passive raster evidence',()=>{expect(rasterType(Buffer.from('<html>image</html>'))).toBeNull();expect(rasterType(png)).toBe('image/png');});
});
