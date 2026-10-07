import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { ARCHER_CHAT, outboundReady } from '../bots/outboundCalls.js';
import { phoneBusy, reservePhone, releaseUnstartedPhone } from '../voice/phoneReservation.js';
import { PHONE_ENDED } from '../voice/phone.js';
import { NICK_PHONE, reminderReason, type ReminderPhone } from './service.js';

/** Archer's existing conversational LiveVoice worker, assigned voice, phone and own chat. */
export function reminderPhoneAdapter(ctx:AppContext,user:UserRow,active=()=>true):ReminderPhone {
  return {
    async busy() { outboundReady(ctx,user,true);return !!ctx.liveVoice!.status(user.id)||phoneBusy(ctx.db,user.id,NICK_PHONE); },
    async place(input) {
      if(input.to!==NICK_PHONE)throw new Error('Nick-only reminder destination.');
      outboundReady(ctx,user,true);
      const logId=reservePhone(ctx.db,user.id,NICK_PHONE,null,Date.now(),input.attemptId);
      try {
        await ctx.liveVoice!.start(user.id,{botConversationId:ARCHER_CHAT,outboundReason:reminderReason(input.meeting),beforePhoneDispatch:async()=>{
          if(!active()||!ctx.db.prepare('SELECT 1 FROM calendar_phone_settings WHERE user_id=? AND enabled=1').get(user.id))throw new Error('Reminders paused.');
          outboundReady(ctx,user,true,logId);await input.beforeDispatch();
          if(!active()||!ctx.db.prepare('SELECT 1 FROM calendar_phone_settings WHERE user_id=? AND enabled=1').get(user.id))throw new Error('Reminders paused during source recheck.');
          outboundReady(ctx,user,true,logId);
        },phone:{to:NICK_PHONE,logId}});
        const row=ctx.db.prepare('SELECT provider_sid FROM bot_phone_calls WHERE id=?').get(logId) as {provider_sid:string|null};
        if(!row.provider_sid)throw new Error('Original provider acceptance unavailable.');
        return {providerId:row.provider_sid};
      } catch { releaseUnstartedPhone(ctx.db,logId);throw new Error('Reminder attempt unconfirmed; do not replay.'); }
    },
    async ended(providerId) {
      const row=ctx.db.prepare('SELECT status,to_phone FROM bot_phone_calls WHERE user_id=? AND provider_sid=?').get(user.id,providerId) as {status:string;to_phone:string}|undefined;
      return row?.to_phone===NICK_PHONE && PHONE_ENDED.includes(row.status);
    },
  };
}
