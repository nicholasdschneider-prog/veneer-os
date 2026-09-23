import {useEffect,useRef} from 'react';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from './ui/dialog';
import type {useChatHistory} from '../lib/useChatHistory';
export function ChatHistoryControls({history}:{history:ReturnType<typeof useChatHistory>}){
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const viewport=root.current?.closest<HTMLElement>('[data-slot="message-scroller-viewport"]');if(!viewport)return;
  let wasBelow=viewport.scrollTop>150;
  const scroll=()=>{if(viewport.scrollTop>150)wasBelow=true;else if(wasBelow&&viewport.scrollTop<60){wasBelow=false;history.load();}};
  viewport.addEventListener('scroll',scroll,{passive:true});return()=>viewport.removeEventListener('scroll',scroll);
 },[history.load]);
 return <div ref={root} className="space-y-2 text-sm">
  {history.window?.hasOlder&&<><p className="text-muted-foreground">Recent history is loaded. Earlier messages and any omitted part of a long turn remain available.</p><Button variant="outline" disabled={history.busy} onClick={history.load}>{history.busy?'Loading earlier messages…':'Load earlier messages'}</Button></>}
  {history.error&&<p role="status">{history.error}</p>}
  {!!history.window?.oversized.length&&<details><summary>Large history records ({history.window.oversized.length})</summary><p>Complete original record text is available in bounded pages. No history was deleted.</p>{history.window.oversized.map(i=><Button key={i} variant="outline" onClick={()=>history.openRecord(i)}>Open record {i+1}</Button>)}</details>}
  <Dialog open={!!history.record} onOpenChange={open=>{if(!open)history.closeRecord();}}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>Complete history record</DialogTitle><DialogDescription>Original displayed text, read-only. Internal metadata and hidden reasoning are not exposed. Text is paginated to keep the chat responsive.</DialogDescription><pre className="whitespace-pre-wrap break-all text-xs">{history.record?.text}</pre>{history.record&&<div className="flex gap-2"><Button disabled={history.record.offset===0} onClick={()=>history.openRecord(history.record!.index,Math.max(0,history.record!.offset-32768))}>Previous text</Button><Button disabled={history.record.next===null} onClick={()=>history.openRecord(history.record!.index,history.record!.next??0)}>Next text</Button></div>}</DialogContent></Dialog>
 </div>;
}
