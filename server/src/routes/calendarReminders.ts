import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { prepareReminder, manifestSchema, hash, NICK_ACCOUNTS, NICK_PHONE, NICK_ZONE } from '../calendarReminders/service.js';
import { archerOwner, outboundReady } from '../bots/outboundCalls.js';
import { connectorPins, connectorExecute, connectorReminderReader, discoverReminderBindings } from '../calendarReminders/connectorReader.js';
import { phoneBusy } from '../voice/phoneReservation.js';

/** Human Nick owner-only setup of the existing Archer phone/calendar connections. No test-call route. */
export function createCalendarRemindersRouter(ctx: AppContext) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.agentConversationId || !req.user || req.user.role !== 'owner' || req.user.status !== 'active' || !NICK_ACCOUNTS.some(a => a === req.user!.email.toLowerCase())) {
      res.status(403).json({ error: 'Nick owner session required.' }); return;
    }
    next();
  });
  router.get('/settings', (req, res) => {
    const prepared = ctx.db.prepare('SELECT manifest_hash,manifest_json,source_pins_json,enabled,prepared_ms FROM calendar_phone_settings WHERE user_id=?').get(req.user!.id) as {enabled:number;manifest_json:string;manifest_hash:string;source_pins_json:string|null}|undefined;
    const blockers:string[]=[];
    if(!prepared?.enabled)blockers.push('OWNER_ACTIVATION_REQUIRED');
    try {outboundReady(ctx,req.user!,true);if(prepared){const m=manifestSchema.parse(JSON.parse(prepared.manifest_json));const pins=connectorPins(ctx,req.user!.id,m.bindings);if(prepared.enabled&&(!prepared.source_pins_json||hash(pins)!==hash(JSON.parse(prepared.source_pins_json))))throw new Error('Connection drift.');}} catch {blockers.push('EXISTING_ARCHER_PHONE_OR_CALENDAR_CONNECTION_UNAVAILABLE');}
    const unresolved=!!ctx.db.prepare("SELECT 1 FROM calendar_phone_attempts WHERE user_id=? AND state IN ('RESERVED','UNKNOWN')").get(req.user!.id);
    if(unresolved)blockers.push('ORIGINAL_REMINDER_OUTCOME_UNRESOLVED');
    if(ctx.liveVoice?.status(req.user!.id)||phoneBusy(ctx.db,req.user!.id,NICK_PHONE))blockers.push('PHONE_BUSY_OR_ORIGINAL_PHONE_OUTCOME_UNRESOLVED');
    res.json({prepared:prepared?{...prepared,manifest:JSON.parse(prepared.manifest_json)}:null,enabled:!!prepared?.enabled,ready:blockers.length===0,execute:false,blockers});
  });
  router.post('/prepare', (req, res) => {
    try { res.json(prepareReminder(ctx.db, req.user!, req.body)); }
    catch (e) { res.status(e instanceof z.ZodError ? 400 : 409).json({ error: e instanceof z.ZodError ? 'Invalid disabled reminder manifest.' : 'Reminder preparation refused.' }); }
  });
  router.post('/prepare-from-connectors', (req,res)=>{
    void (async()=>{
      archerOwner(ctx,req.user!);z.object({}).strict().parse(req.body);
      const bindings=await discoverReminderBindings(ctx,req.user!.id);
      return prepareReminder(ctx.db,req.user!,{ownerEmail:req.user!.email.toLowerCase(),phone:NICK_PHONE,timezone:NICK_ZONE,leadMinutes:20,enabled:false,policy:'actual-phone-even-when-present;one-attempt;no-redial;all-hours;timed-confirmed-meetings-only',bindings,verifiedAliases:[]});
    })().then(result=>res.json(result)).catch(()=>res.status(409).json({error:'Exact existing owner calendar connections could not be prepared. No call was enabled.'}));
  });
  router.post('/enable', (req,res)=>{
    void (async()=>{
      const {manifestHash}=z.object({manifestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
      outboundReady(ctx,req.user!,true);
      const row=ctx.db.prepare('SELECT manifest_json,manifest_hash FROM calendar_phone_settings WHERE user_id=?').get(req.user!.id) as {manifest_json:string;manifest_hash:string}|undefined;
      if(!row||row.manifest_hash!==manifestHash)throw new Error('Manifest changed.');
      const m=manifestSchema.parse(JSON.parse(row.manifest_json));const pins=connectorPins(ctx,req.user!.id,m.bindings);
      const source=connectorReminderReader(connectorExecute(ctx,req.user!.id,pins));
      for(const b of m.bindings){await source.identity(b);const scan=await source.list(b,Date.now(),Date.now()+86400_000);if(!scan.complete)throw new Error('Incomplete scope.');}
      if(hash(connectorPins(ctx,req.user!.id,m.bindings))!==hash(pins))throw new Error('Connector drift.');
      outboundReady(ctx,req.user!,true);
      if(!ctx.db.prepare('UPDATE calendar_phone_settings SET enabled=1,source_pins_json=? WHERE user_id=? AND manifest_hash=?').run(JSON.stringify(pins),req.user!.id,manifestHash).changes)throw new Error('Manifest changed.');
      return {enabled:true,execute:false,policy:m.policy,note:'Existing Archer worker may make due reminder calls after fresh dispatch checks. No immediate test call.'};
    })().then(result=>res.json(result)).catch(()=>res.status(409).json({enabled:false,execute:false,error:'Exact setup unavailable or changed; no activation occurred.'}));
  });
  router.post('/disable',(req,res)=>{ctx.db.prepare('UPDATE calendar_phone_settings SET enabled=0 WHERE user_id=?').run(req.user!.id);res.json({enabled:false,execute:false});});
  return router;
}
