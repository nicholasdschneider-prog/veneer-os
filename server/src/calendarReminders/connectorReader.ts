import { Composio } from '@composio/core';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import { connectedConnectorRowsForConversation } from '../connectors/access.js';
import { calendarReminderReader, type CalendarRead } from './googleReader.js';
import { hash, NICK_ACCOUNTS, type Binding, type ReminderManifest } from './service.js';
import { ARCHER_CHAT } from '../bots/outboundCalls.js';

const configSchema=z.object({sessionId:z.string().min(1),connectedAccountId:z.string().min(1),composioUserId:z.string().optional()});
const READ_TOOLS=['GOOGLECALENDAR_GET_CURRENT_USER','GOOGLECALENDAR_LIST_CALENDARS','GOOGLECALENDAR_EVENTS_LIST','GOOGLECALENDAR_EVENTS_GET'] as const;
type ReadTool=typeof READ_TOOLS[number];
export type ConnectorExecute=(binding:Binding,slug:ReadTool,args:Record<string,unknown>)=>Promise<unknown>;
export function connectorPins(ctx:AppContext,userId:number,bindings:Binding[]) {
  const rows=connectedConnectorRowsForConversation(ctx.db,ARCHER_CHAT,userId);
  return bindings.map(b=> {
    const row=rows.find(r=>String(r.id)===b.sourceId && r.connector_slug==='googlecalendar' && r.user_id===userId);
    if(!row)throw new Error('Original owner calendar connector missing, revoked or out of Archer scope.');
    const c=configSchema.parse(JSON.parse(row.config_json));
    return {sourceId:b.sourceId,fingerprint:hash([row.id,row.user_id,row.config_json,row.access_mode,row.access_version,row.sharing,row.scope_mode]),connectedAccountId:c.connectedAccountId};
  });
}
/** Reuses the owner's existing connector custody. Never exports Google tokens or enrolls a second service. */
export function connectorExecute(ctx:AppContext,userId:number,pins:ReturnType<typeof connectorPins>):ConnectorExecute {
  return async (b,slug,args)=> {
    if(!READ_TOOLS.includes(slug))throw new Error('Calendar writes are not supported.');
    const current=connectorPins(ctx,userId,[b])[0]!;
    if(!pins.some(p=>p.sourceId===current.sourceId && p.fingerprint===current.fingerprint && p.connectedAccountId===current.connectedAccountId))throw new Error('Calendar connection changed since owner setup.');
    const row=connectedConnectorRowsForConversation(ctx.db,ARCHER_CHAT,userId).find(r=>String(r.id)===b.sourceId)!;
    const config=configSchema.parse(JSON.parse(row.config_json));
    const apiKey=effectiveApiKey('composio',ctx.secrets,ctx.config,ctx.doppler).value;
    if(!apiKey)throw new Error('Existing connector service unavailable.');
    const client=new Composio({apiKey,allowTracking:false});
    const signal=AbortSignal.timeout(10_000);
    if((await client.connectedAccounts.get(config.connectedAccountId,{signal})).status!=='ACTIVE')throw new Error('Calendar account inactive.');
    const schema=await client.tools.getRawComposioToolBySlug(slug,{version:'20261001_00'},{signal});
    if(schema.slug!==slug||schema.toolkit?.slug.toLowerCase()!=='googlecalendar'||schema.version!=='20261001_00')throw new Error('Pinned calendar tool identity/version changed.');
    const properties=schema.inputParameters?.properties ?? {};
    const mapped:Record<string,unknown>={};
    for(const [key,value] of Object.entries(args)) {
      const found=Object.keys(properties).find(k=>k.replaceAll('_','').toLowerCase()===key.toLowerCase());
      if(!found)throw new Error('Pinned calendar tool schema does not support required read parameter.');
      mapped[found]=value;
    }
    const result=await client.tools.execute(slug,{connectedAccountId:config.connectedAccountId,version:'20261001_00',arguments:mapped},{signal});
    if(result.error || !result.successful)throw new Error('Calendar read failed.');
    if(connectorPins(ctx,userId,[b])[0]!.fingerprint!==current.fingerprint)throw new Error('Calendar connector changed during read.');
    return result.data;
  };
}
export function connectorReminderReader(execute:ConnectorExecute,clock=Date.now) {
  const read:CalendarRead=async (b,path,params)=> {
    if(path==='/oauth2/v2/userinfo')return execute(b,'GOOGLECALENDAR_GET_CURRENT_USER',{});
    const args:Record<string,unknown>={};
    for(const [k,v] of params??[])args[k]=k==='maxResults'?Number(v):['showHidden','showDeleted','singleEvents'].includes(k)?v==='true':v;
    if(path==='/calendar/v3/users/me/calendarList')return execute(b,'GOOGLECALENDAR_LIST_CALENDARS',args);
    const match=path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if(!match)throw new Error('Unsupported calendar read.');
    args.calendarId=decodeURIComponent(match[1]!);
    if(match[2])args.eventId=decodeURIComponent(match[2]);
    return execute(b,match[2]?'GOOGLECALENDAR_EVENTS_GET':'GOOGLECALENDAR_EVENTS_LIST',args);
  };
  return calendarReminderReader(read,clock);
}
/** Complete discovery for human setup; only exact live account identities select a connector. */
export async function discoverReminderBindings(ctx:AppContext,userId:number,executeFactory=connectorExecute):Promise<ReminderManifest['bindings']> {
  const bindings:Binding[]=[];
  for(const row of connectedConnectorRowsForConversation(ctx.db,ARCHER_CHAT,userId).filter(r=>r.connector_slug==='googlecalendar' && r.user_id===userId)) {
    const provisional:Binding={account:NICK_ACCOUNTS[0],sourceId:String(row.id),calendarIds:[]};
    const execute=executeFactory(ctx,userId,connectorPins(ctx,userId,[provisional]));
    const identity=z.object({email:z.string().email()}).parse(await execute(provisional,'GOOGLECALENDAR_GET_CURRENT_USER',{}));
    const account=NICK_ACCOUNTS.find(a=>a===identity.email.toLowerCase()); if(!account)continue;
    if(bindings.some(b=>b.account===account))throw new Error('Multiple connectors match one Nick account; select exact original connection first.');
    const ids:string[]=[];let token:string|undefined;const seen=new Set<string>();
    for(let n=0;;n++) {
      if(n>=10)throw new Error('Calendar inventory incomplete.');
      const page=z.object({items:z.array(z.object({id:z.string().min(1),accessRole:z.string()})),nextPageToken:z.string().optional()}).parse(await execute(provisional,'GOOGLECALENDAR_LIST_CALENDARS',{showHidden:true,maxResults:250,...(token?{pageToken:token}:{})}));
      for(const c of page.items){if(!['owner','writer','reader'].includes(c.accessRole))throw new Error('Calendar details unavailable.');ids.push(c.id);}
      token=page.nextPageToken;if(!token)break;if(seen.has(token))throw new Error('Calendar inventory pagination repeated.');seen.add(token);
    }
    bindings.push({account,sourceId:String(row.id),calendarIds:ids.sort()});
  }
  if(bindings.length!==3)throw new Error('The three original Nick calendar accounts are not all available to Archer.');
  return bindings.sort((a,b)=>NICK_ACCOUNTS.indexOf(a.account)-NICK_ACCOUNTS.indexOf(b.account));
}
