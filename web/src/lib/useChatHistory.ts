import {useCallback,useEffect,useRef,useState} from 'react';
import type {ConversationEvent} from './types';
import {emptyTranscript,reduceEvents,type TranscriptState} from './transcript';
import {wsBus,type HistoryWindow} from './ws';
/** Retain only explicitly loaded pages and subsequent live events. Never replay
 * actions: all entries flow through the display reducer, not send APIs. */
export function useChatHistory(conversationId:string,setTranscript:(value:TranscriptState)=>void){
 const [window,setWindow]=useState<HistoryWindow>();
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [record,setRecord]=useState<{token:string;index:number;offset:number;text:string;next:number|null}|null>(null);
 const events=useRef(new Map<number,ConversationEvent>()),live=useRef<ConversationEvent[]>([]),sequence=useRef(0),windowRef=useRef<HistoryWindow|undefined>(undefined);
 const loading=useRef(false);
 const anchor=useRef<{el:HTMLElement;height:number;top:number}|null>(null);
 const snapshot=useCallback((incoming:ConversationEvent[],h?:HistoryWindow)=>{
  events.current=new Map(incoming.map((e,i)=>[typeof e.historyIndex==='number'?e.historyIndex:i,e]));live.current=[];sequence.current=h?.nextSequence??incoming.length;
  windowRef.current=h;setWindow(h);setBusy(false);loading.current=false;setError('');setRecord(null);
 },[]);
 useEffect(()=>{snapshot([],undefined);},[conversationId,snapshot]);
 const event=useCallback((e:ConversationEvent):ConversationEvent=>{const next:ConversationEvent={...e,displaySequence:sequence.current++};live.current.push(next);return next;},[]);
 const page=useCallback((incoming:ConversationEvent[],h:HistoryWindow)=>{
  if(h.token!==windowRef.current?.token)return;
  for(const e of incoming)if(typeof e.historyIndex==='number')events.current.set(e.historyIndex,e);
  const history=[...events.current].sort(([a],[b])=>a-b).map(([,e])=>e);
  setTranscript(reduceEvents(emptyTranscript(),[...history,...live.current]));
  const merged={...h,oversized:[...new Set([...(windowRef.current?.oversized??[]),...h.oversized])]};
  windowRef.current=merged;setWindow(merged);setBusy(false);loading.current=false;setError('');
  requestAnimationFrame(()=>{const a=anchor.current;if(a?.el.isConnected)a.el.scrollTop=a.top+a.el.scrollHeight-a.height;anchor.current=null;});
 },[setTranscript]);
 const load=useCallback(()=>{
  const h=windowRef.current;if(!h?.hasOlder||loading.current)return;
  const el=document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
  if(el)anchor.current={el,height:el.scrollHeight,top:el.scrollTop};
  loading.current=true;setBusy(true);setError('');wsBus.history(conversationId,h.token,h.before);
 },[conversationId]);
 const fail=useCallback((message:string)=>{loading.current=false;setBusy(false);setError(message);},[]);
 const openRecord=useCallback((index:number,offset=0)=>{const h=windowRef.current;if(h)wsBus.historyRecord(conversationId,h.token,index,offset);},[conversationId]);
 const receiveRecord=useCallback((r:NonNullable<typeof record>)=>{if(r.token===windowRef.current?.token)setRecord(r);},[]);
 return {window,busy,error,record,snapshot,event,page,load,fail,openRecord,receiveRecord,closeRecord:()=>setRecord(null)};
}
