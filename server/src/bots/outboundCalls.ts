import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { VoiceWorkspace } from '../voice/workspace.js';
import { phoneConfigured } from '../voice/phone.js';
import { phoneBusy, reservePhone, releaseUnstartedPhone } from '../voice/phoneReservation.js';
import { inCallWindow, PHONE_CALLS_PER_HOUR } from './botCalls.js';
import { hash, NICK_ACCOUNTS, NICK_PHONE } from '../calendarReminders/service.js';

export const ARCHER_CHAT = 'f4131f81-27c5-4332-902a-a0d9873dfeb9';
export const outboundSchema = z.object({ request_key:z.string().min(1).max(200), purpose_key:z.string().min(1).max(512), reason:z.string().trim().min(1).max(2000) }).strict();
export function archerOwner(ctx: AppContext, user: UserRow, conversationId = ARCHER_CHAT) {
  const current=ctx.db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow|undefined;
  if(!current||current.role!=='owner'||current.status!=='active'||current.email.toLowerCase()!==user.email.toLowerCase())throw new Error('Owner scope changed.');
  if (user.role !== 'owner' || user.status !== 'active' || !NICK_ACCOUNTS.some(a=>a===user.email.toLowerCase()) || conversationId !== ARCHER_CHAT) throw new Error('Original Archer and Nick owner scope required.');
  const bot = new VoiceWorkspace(ctx,user.id,conversationId).bot();
  const owned = ctx.db.prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=? AND archived=0').get(conversationId,user.id);
  if (!owned || !bot.canMessage || !ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(conversationId)) throw new Error('Original Archer chat unavailable.');
  return bot;
}
export function outboundReady(ctx: AppContext, user: UserRow, calendar = false, reservedLogId='') {
  archerOwner(ctx,user);
  const settings = ctx.db.prepare('SELECT * FROM bot_call_settings WHERE user_id=?').get(user.id) as {phone:string|null;phone_enabled:number;dnd:number;window_start:string;window_end:string;timezone:string}|undefined;
  const policy = ctx.db.prepare('SELECT enabled FROM bot_outbound_policy WHERE user_id=? AND conversation_id=?').get(user.id,ARCHER_CHAT) as {enabled:number}|undefined;
  if (!settings || settings.phone !== NICK_PHONE || !settings.phone_enabled || settings.dnd || !policy?.enabled || !ctx.db.prepare('SELECT 1 FROM bot_call_bots WHERE user_id=? AND conversation_id=? AND enabled=1').get(user.id,ARCHER_CHAT)) throw new Error('Archer phone calling is disabled or paused.');
  if (!ctx.liveVoice || !phoneConfigured(ctx.doppler)) throw new Error('Existing phone connection unavailable.');
  if (!calendar && !inCallWindow(settings,Date.now())) throw new Error('Outside your calling hours.');
  if ((ctx.db.prepare('SELECT count(*) AS n FROM bot_phone_calls WHERE user_id=? AND started_ms>? AND id<>?').get(user.id,Date.now()-3600_000,reservedLogId) as {n:number}).n >= PHONE_CALLS_PER_HOUR) throw new Error('Hourly call limit reached.');
}
export async function requestOutboundCall(ctx: AppContext, user: UserRow, conversationId: string | undefined, input: unknown) {
  if (conversationId !== ARCHER_CHAT) throw new Error('Only original Archer may request this call.');
  archerOwner(ctx,user,conversationId);
  const args = outboundSchema.parse(input); const digest = hash(args);
  const prior = ctx.db.prepare('SELECT * FROM bot_outbound_requests WHERE user_id=? AND conversation_id=? AND (request_key=? OR purpose_key=?)').get(user.id,conversationId,args.request_key,args.purpose_key) as {id:string;payload_hash:string;state:string}|undefined;
  if (prior) {
    if (prior.payload_hash !== digest) throw new Error('Call purpose was already reserved; no replacement key or payload.');
    return { attemptId:prior.id,state:prior.state,execute:false,replayed:false };
  }
  outboundReady(ctx,user);
  if (ctx.liveVoice!.status(user.id) || phoneBusy(ctx.db,user.id,NICK_PHONE)) throw new Error('Already on a call or a previous call needs reconciliation.');
  const {id,logId} = ctx.db.transaction(()=>{
    const logId=reservePhone(ctx.db,user.id,NICK_PHONE,null); const id=randomUUID();
    ctx.db.prepare("INSERT INTO bot_outbound_requests VALUES(?,?,?,?,?,?,?,?,'RESERVED')").run(id,user.id,conversationId,args.request_key,args.purpose_key,digest,args.reason,logId);
    return {id,logId};
  }).immediate();
  ctx.db.prepare("UPDATE bot_outbound_requests SET state='UNKNOWN' WHERE id=?").run(id);
  try {
    await ctx.liveVoice!.start(user.id,{botConversationId:conversationId,outboundReason:args.reason,beforePhoneDispatch:async()=>{outboundReady(ctx,user,false,logId);},phone:{to:NICK_PHONE,logId}});
    ctx.db.prepare("UPDATE bot_outbound_requests SET state='STARTED' WHERE id=?").run(id);
    return {attemptId:id,state:'STARTED',execute:false,providerAcceptanceOnly:true};
  } catch {
    releaseUnstartedPhone(ctx.db,logId);
    return {attemptId:id,state:'UNKNOWN',execute:false,retryAllowed:false};
  }
}
