import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { manifestSchema, createReminderPass, reconcileAcceptedReminder, POLL_MS, hash } from './service.js';
import { connectorPins, connectorExecute, connectorReminderReader } from './connectorReader.js';
import { reminderPhoneAdapter } from './phone.js';

/** Bounded polling in the existing web service, default disabled. No separate bot or queued turn. */
export function startCalendarReminderWorker(ctx:AppContext) {
  let busy=false; let closed=false;
  const passes=new Map<number,{hash:string;run:ReturnType<typeof createReminderPass>}>();
  const tick=async ()=>{
    if(busy||closed)return;busy=true;
    try {
      const settings=ctx.db.prepare('SELECT user_id,manifest_json,manifest_hash,source_pins_json FROM calendar_phone_settings WHERE enabled=1 LIMIT 1').all() as {user_id:number;manifest_json:string;manifest_hash:string;source_pins_json:string|null}[];
      for(const s of settings){
        if(closed)break;
        const user=ctx.db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(s.user_id) as UserRow|undefined;
        if(!user||!s.source_pins_json)continue;
        const manifest=manifestSchema.parse(JSON.parse(s.manifest_json));const pins=connectorPins(ctx,user.id,manifest.bindings);
        if(hash(pins)!==hash(JSON.parse(s.source_pins_json)))continue;
        const phone=reminderPhoneAdapter(ctx,user,()=>!closed);
        const accepted=ctx.db.prepare("SELECT id FROM calendar_phone_attempts WHERE user_id=? AND state='ACCEPTED' LIMIT 10").all(user.id) as {id:string}[];
        for(const a of accepted)await reconcileAcceptedReminder(ctx.db,a.id,phone);
        let pass=passes.get(user.id);
        if(!pass||pass.hash!==s.manifest_hash){pass={hash:s.manifest_hash,run:createReminderPass(ctx.db,user.id,manifest,connectorReminderReader(connectorExecute(ctx,user.id,pins)),phone)};passes.set(user.id,pass);}
        await pass.run();
      }
    } catch { /* No dispatch retry; permanent occurrence fences and expiry remain authoritative. */ }
    finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),POLL_MS);timer.unref();
  return ()=>{closed=true;clearInterval(timer);passes.clear();};
}
