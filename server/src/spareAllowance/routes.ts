import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow } from '../db/db.js';
import { canSendToConversation } from '../conversations/access.js';
import { SPARE_TIME_ZONE } from './policy.js';
import { recordCheckpoint, spareRun, taskAllowed, type SpareTask } from './store.js';

const TaskInput = z.object({
  request_key:z.string().min(1).max(100), conversation_id:z.string().min(1).max(100).optional(),
  title:z.string().trim().min(1).max(200), prompt:z.string().trim().min(1).max(20000),
  output:z.string().trim().min(1).max(2000), account_ids:z.array(z.string().min(1).max(100)).min(1).max(20),
  priority:z.number().int().min(-100).max(100).default(0), max_batches:z.number().int().min(1).max(100).default(1),
}).strict();
export function createSpareAllowanceRouter(ctx: AppContext) {
  const {db} = ctx;
  const router = express.Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if (req.user?.role !== 'owner') {res.status(403).json({error:'Only the installation owner can manage subscription allowance'});return;}
    next();
  });
  const handle = (fn: (req:express.Request,res:express.Response)=>unknown):express.RequestHandler => (req,res,next)=>{
    try { fn(req,res); } catch(e) {
      if(e instanceof z.ZodError) res.status(400).json({error:e.issues.map(i=>i.message).join('; ')});
      else if(e instanceof Error) res.status(409).json({error:e.message});
      else next(e);
    }
  };
  router.get('/',handle((req,res)=>{
    const tasks = db.prepare('SELECT * FROM spare_allowance_tasks WHERE user_id=? AND (? IS NULL OR conversation_id=?) ORDER BY priority DESC,created_at DESC').all(req.user!.id,req.agentConversationId ?? null,req.agentConversationId ?? null);
    const runs = db.prepare('SELECT r.* FROM spare_allowance_runs r JOIN spare_allowance_tasks t ON t.id=r.task_id WHERE t.user_id=? AND (? IS NULL OR t.conversation_id=?) ORDER BY r.rowid DESC LIMIT 50').all(req.user!.id,req.agentConversationId ?? null,req.agentConversationId ?? null);
    const settings = db.prepare('SELECT enabled FROM spare_allowance_settings WHERE id=1').get();
    const accounts = db.prepare('SELECT * FROM spare_allowance_accounts').all();
    // Pick from accessible original chats; never create a replacement bot identity.
    const conversations = (db.prepare("SELECT * FROM conversations WHERE archived=0 AND provider IN ('claude','codex') AND model IS NOT NULL AND (? IS NULL OR id=?) ORDER BY last_active_at DESC LIMIT 500").all(req.agentConversationId ?? null,req.agentConversationId ?? null) as ConversationRow[])
      .filter(c=>(!req.agentConversationId || c.id===req.agentConversationId) && canSendToConversation(req.user!,c,db) && !db.prepare('SELECT 1 FROM coordination_lanes WHERE conversation_id=? UNION SELECT 1 FROM team_room_workers WHERE conversation_id=?').get(c.id,c.id))
      .map(c=>({id:c.id,title:c.title,projectId:c.project_id,provider:c.provider,model:c.model}));
    const connectedAccounts = [...ctx.secrets.listClaudeAccounts().map(a=>({provider:'claude',id:a.id,label:a.label})),...ctx.codexAccounts.list().filter(a=>a.connected).map(a=>({provider:'codex',id:a.id,label:a.label}))];
    res.json({tasks,runs,settings,accounts,conversations,connectedAccounts,policy:{timezone:SPARE_TIME_ZONE,businessHours:'8 a.m.–5 p.m. every day',finalHours:6,reservePercent:1}});
  }));
  router.post('/settings',handle((req,res)=>{
    if(req.agentConversationId) throw new Error('Global pause controls belong to the human owner');
    const input = z.object({enabled:z.boolean()}).strict().parse(req.body);
    db.prepare('UPDATE spare_allowance_settings SET enabled=? WHERE id=1').run(Number(input.enabled));
    res.json({ok:true});
  }));
  router.post('/tasks',handle((req,res)=>{
    const input = TaskInput.parse(req.body);
    const conversationId = req.agentConversationId ?? input.conversation_id;
    if(!conversationId || (req.agentConversationId && input.conversation_id && input.conversation_id !== req.agentConversationId)) throw new Error('A bot can prepare tasks only for its own original chat');
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) as ConversationRow|undefined;
    if(!conv || !conv.model || !['claude','codex'].includes(conv.provider)) throw new Error('Select an original chat with an explicit Claude or Codex model');
    const accounts = conv.provider === 'claude' ? ctx.secrets.listClaudeAccounts() : ctx.codexAccounts.list();
    if(input.account_ids.some(id=>!accounts.some(a=>a.id===id && (!('connected' in a) || a.connected)))) throw new Error('Selected account is not connected for this provider');
    const task = {id:crypto.randomUUID(),request_key:input.request_key,user_id:req.user!.id,conversation_id:conversationId,title:input.title,prompt:input.prompt,output:input.output,provider:conv.provider,model:conv.model,account_ids_json:JSON.stringify([...new Set(input.account_ids)].sort()),priority:input.priority,max_batches:input.max_batches,completed_batches:0,status:'ready',cursor:null} as SpareTask;
    if(!taskAllowed(db,task)) throw new Error('Current chat, project, model or owner access is unavailable');
    const existing = db.prepare('SELECT * FROM spare_allowance_tasks WHERE user_id=? AND request_key=?').get(task.user_id,task.request_key) as SpareTask|undefined;
    if(existing) {
      for(const key of ['conversation_id','title','prompt','output','provider','model','account_ids_json','priority','max_batches'] as const) if(existing[key]!==task[key]) throw new Error('Request key belongs to another task definition');
      res.json({task:existing});return;
    }
    db.prepare('INSERT INTO spare_allowance_tasks(id,request_key,user_id,conversation_id,title,prompt,output,provider,model,account_ids_json,priority,max_batches) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(task.id,task.request_key,task.user_id,task.conversation_id,task.title,task.prompt,task.output,task.provider,task.model,task.account_ids_json,task.priority,task.max_batches);
    res.json({task});
  }));
  router.patch('/tasks/:id',handle((req,res)=>{
    const input = z.object({status:z.enum(['ready','paused','completed'])}).strict().parse(req.body);
    const task = db.prepare('SELECT * FROM spare_allowance_tasks WHERE id=? AND user_id=?').get(req.params.id,req.user!.id) as SpareTask|undefined;
    if(!task || (req.agentConversationId && task.conversation_id!==req.agentConversationId)) throw new Error('Task unavailable');
    if(task.status==='completed' && input.status!=='completed') throw new Error('Completed tasks cannot be restarted');
    if(task.status==='blocked' && (input.status!=='completed' || req.agentConversationId)) throw new Error('Human review required; interrupted batches cannot be replayed');
    db.prepare('UPDATE spare_allowance_tasks SET status=? WHERE id=?').run(input.status,task.id);
    res.json({ok:true});
  }));
  router.post('/checkpoint',handle((req,res)=>{
    if(!req.agentConversationId || !req.spareRunId || spareRun(db,req.agentConversationId)?.id!==req.spareRunId) throw new Error('Checkpoint requires the exact running optional token');
    const input=z.object({outcome:z.enum(['progress','completed','blocked']),cursor:z.string().max(2000).nullable(),summary:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
    recordCheckpoint(db,req.agentConversationId,input);res.json({ok:true,execute:false});
  }));
  return router;
}
