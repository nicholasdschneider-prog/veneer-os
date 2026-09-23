import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ConversationEvent} from './events.js';
const displayFields:Record<string,string[]>={turn_started:['text','at'],text_final:['markdown','at'],tool_started:['displayName','toolName','inputPreview'],tool_finished:['resultPreview'],notice:['message'],error:['message'],context_compacted:['notice']};
/** Large-record viewer exposes only original public display text, never hidden
 * reasoning, raw tool input, internal origin IDs or provider metadata. */
export function historyRecordText(event:ConversationEvent){
 const e=event as Record<string,unknown>,fields=displayFields[event.type];
 if(!fields)return 'This event has no standalone public text view. Its structured controls remain in the transcript.';
 return fields.filter(k=>typeof e[k]==='string').map(k=>`${k}:\n${e[k]}`).join('\n\n');
}
export const HISTORY_EVENTS=300, HISTORY_BYTES=256*1024, HISTORY_EVENT_BYTES=64*1024;
export type HistoryPage={events:ConversationEvent[];history:{token:string;before:number;hasOlder:boolean;total:number;nextSequence:number;streamRevision:number;streamEpoch:string;oversized:number[]}};
type Entry={offset:number;bytes:number;at:number;dependencies:number[]};
type Archive={conversation:string;file:string;entries:Entry[];created:number;nextSequence:number;revision:number;epoch:string};
/** Private, disposable UI index. Provider history remains the source of truth.
 * No transcript contents or filesystem names are sent to the browser. */
export class HistoryPages {
 private root=fs.mkdtempSync(path.join(os.tmpdir(),'veneer-ui-history-'));
 private archives=new Map<string,Archive>();
 constructor(){fs.chmodSync(this.root,0o700);}
 open(conversation:string,events:ConversationEvent[],revision=0,epoch="fixture"):HistoryPage {
  for(const [token,a] of this.archives) if(Date.now()-a.created>3600000 || this.archives.size>=16){fs.rmSync(a.file,{force:true});this.archives.delete(token);}
  const token=crypto.randomUUID(),file=path.join(this.root,token),fd=fs.openSync(file,'wx',0o600),entries:Entry[]=[];
  let offset=0,seq=0,turn=-1,lastNotice:string|null=null;
  const starts=new Map<string,number>();
  try {events.forEach((event,index)=>{
   const e=event as Record<string,unknown>,deps:number[]=[];
   if(e.type==='turn_started')turn=index;
   else if(turn>=0)deps.push(turn);
   const key=e.toolId?`tool:${e.toolId}`:e.requestId?`request:${e.requestId}`:null;
   if(key && ['tool_started','approval_requested','question_asked'].includes(String(e.type))) starts.set(key,index);
   else if(key && starts.has(key))deps.push(starts.get(key)!);
   const item={...event,historyIndex:index,displaySequence:seq};
   const json=JSON.stringify(item)+'\n',bytes=Buffer.byteLength(json);
   fs.writeSync(fd,json);entries.push({offset,bytes,at:typeof e.at==='string'?Date.parse(e.at):NaN,dependencies:[...new Set(deps)]});offset+=bytes;
   switch(e.type){
    case 'turn_started':if(!(typeof e.messageId==='number'&&Number.isSafeInteger(e.messageId)&&e.messageId>0))seq++;lastNotice=null;break;
    case 'text_final':case 'error':seq++;lastNotice=null;break;
    case 'notice':seq++;lastNotice=String(e.message??'');break;
    case 'context_compacted':if(typeof e.notice==='string'&&e.notice.trim()&&lastNotice!==e.notice.trim()){seq++;lastNotice=e.notice.trim();}break;
    case 'tool_started':if(e.toolId==null)seq++;lastNotice=null;break;
    case 'approval_requested':case 'question_asked':if(e.requestId==null)seq++;lastNotice=null;break;
    case 'subagent_started':lastNotice=null;break;
   }
  });}finally{fs.closeSync(fd);}
  this.archives.set(token,{conversation,file,entries,created:Date.now(),nextSequence:seq,revision,epoch});
  return this.page(conversation,token,entries.length,true);
 }
 private archive(conversation:string,token:string){const a=this.archives.get(token);if(!a||a.conversation!==conversation)throw new Error('History window expired. Reload this conversation to reopen its preserved history.');return a;}
 private read(a:Archive,index:number):ConversationEvent {const entry=a.entries[index];if(!entry)throw new Error('History record not found');const fd=fs.openSync(a.file,'r');try{const b=Buffer.alloc(entry.bytes);fs.readSync(fd,b,0,b.length,entry.offset);return JSON.parse(b.toString());}finally{fs.closeSync(fd);}}
 page(conversation:string,token:string,before:number,initial=false):HistoryPage{
  const a=this.archive(conversation,token);if(!Number.isSafeInteger(before)||before<0||before>a.entries.length)throw new Error('Invalid history cursor');
  const selected=new Set<number>();let start=before,bytes=0;
  const cutoff=Date.now()-86400000;
  for(let i=before-1;i>=0;i--){
   const e=a.entries[i]!;
   if(initial && selected.size>30 && Number.isFinite(e.at)&&e.at<cutoff)break;
   const additions=[i,...e.dependencies].filter(n=>!selected.has(n));
   const addedBytes=additions.reduce((sum,n)=>sum+Math.min(a.entries[n]!.bytes,HISTORY_EVENT_BYTES)+200,0);
   if(selected.size && (selected.size+additions.length>HISTORY_EVENTS||bytes+addedBytes>HISTORY_BYTES))break;
   for(const n of additions)selected.add(n);bytes+=addedBytes;start=i;
  }
  const oversized:number[]=[];
  const events=[...selected].sort((x,y)=>x-y).map(i=>{
   if(a.entries[i]!.bytes>HISTORY_EVENT_BYTES){oversized.push(i);return {type:'notice',message:'Large history record — open its complete text using the history record control above.',historyIndex:i,displaySequence:-(i+1)} as ConversationEvent;}
   return this.read(a,i);
  });
  return {events,history:{token,before:start,hasOlder:start>0,total:a.entries.length,nextSequence:a.nextSequence,streamRevision:a.revision,streamEpoch:a.epoch,oversized}};
 }
 record(conversation:string,token:string,index:number){return this.read(this.archive(conversation,token),index);}
 close(){fs.rmSync(this.root,{recursive:true,force:true});this.archives.clear();}
}
