import {it,expect} from 'vitest';
import {HistoryPages,HISTORY_BYTES,HISTORY_EVENTS,historyRecordText} from '../src/runtime/historyPages.js';
import type {ConversationEvent} from '../src/runtime/events.js';
import {reduceEvents,emptyTranscript} from '../../web/src/lib/transcript.js';
const turns=(n:number):ConversationEvent[]=>Array.from({length:n},(_,i)=>[
 {type:'turn_started',turnId:`t${i}`,role:'user',text:`Question ${i}`,at:new Date(Date.now()-n*1000+i*1000).toISOString(),via:'web'},
 {type:'tool_started',toolId:`tool${i}`,toolName:'fixture',inputPreview:'input'},
 {type:'tool_finished',toolId:`tool${i}`,ok:true,resultPreview:'Result '.repeat(100)},
 {type:'text_final',turnId:`t${i}`,markdown:'Answer '.repeat(100),at:new Date().toISOString()},
 {type:'turn_done',turnId:`t${i}`}]).flat() as ConversationEvent[];
it('bounds a huge day and retrieves every exact event with stable cursors despite appended activity',()=>{
 const store=new HistoryPages();try{
 const source=turns(2000),all=new Map<number,ConversationEvent>();let page=store.open('chat',source,42);
 expect(page.history.hasOlder).toBe(true);expect(page.history.streamRevision).toBe(42);
 const token=page.history.token;
 source.push(...turns(5)); // immutable opened generation
 let pages=0;
 while(true){
 expect(page.events.length).toBeLessThanOrEqual(HISTORY_EVENTS);
 expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(HISTORY_BYTES+4096);
 for(const e of page.events)all.set(Number((e as Record<string,unknown>).historyIndex),e);
 if(!page.history.hasOlder)break;
 const before=page.history.before;page=store.page('chat',token,before);expect(page.history.before).toBeLessThan(before);pages++;
 }
 expect(all.size).toBe(10000);expect(pages).toBeGreaterThan(20);
 const assembled=[...all].sort(([a],[b])=>a-b).map(([,e])=>e);
 const actual=reduceEvents(emptyTranscript(),assembled as never),original=reduceEvents(emptyTranscript(),source.slice(0,10000) as never);
 expect(actual).toEqual(original);
 expect(()=>store.page('foreign',token,1)).toThrow();
 expect(()=>store.page('chat',token,100000)).toThrow();
 }finally{store.close();}
});
it('keeps tool dependencies, exposes oversized originals without unbounded page payload',()=>{
 const store=new HistoryPages();try{
 const events=turns(100);events.push({type:'text_final',turnId:'huge',markdown:'巨大'.repeat(100000)});
 const page=store.open('chat',events);
 expect(page.history.oversized).toContain(500);
 expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(HISTORY_BYTES+4096);
 expect(store.record('chat',page.history.token,500)).toMatchObject({markdown:'巨大'.repeat(100000)});
 const reduced=reduceEvents(emptyTranscript(),page.events as never);
 expect(reduced.items.filter(i=>i.kind==='tool').every(i=>i.kind==='tool'&&!i.running)).toBe(true);
 }finally{store.close();}
});
it('loads a useful recent window even for old untimestamped/equal-timestamp history',()=>{
 const store=new HistoryPages();try{
 const source=turns(1000).map(e=>({...e,at:'2000-01-01T00:00:00Z'}));
 const page=store.open('chat',source);expect(page.events.length).toBeGreaterThan(20);expect(page.history.hasOlder).toBe(true);
 const noDates=store.open('no-dates',turns(1000).map(e=>({...e,at:undefined})));expect(noDates.events.length).toBeLessThanOrEqual(HISTORY_EVENTS);
 }finally{store.close();}
});

it('large-record viewing never exposes raw tool input or hidden reasoning',()=>{
 expect(historyRecordText({type:'tool_started',toolName:'fixture',inputPreview:'visible',input:{secret:'never-display'}} as never)).toContain('visible');
 expect(historyRecordText({type:'tool_started',inputPreview:'visible',input:{secret:'never-display'}} as never)).not.toContain('never-display');
 expect(historyRecordText({type:'thinking_delta',text:'private reasoning'} as never)).not.toContain('private reasoning');
});
