import {performance} from 'node:perf_hooks';
import {reduceEvents,emptyTranscript} from '../web/src/lib/transcript.js';
const events=Array.from({length:10000},(_,i)=>[{type:'turn_started',turnId:`t${i}`,text:'Synthetic user question '.repeat(12),at:new Date(1700000000000+i*1000).toISOString()},{type:'text_final',turnId:`t${i}`,markdown:'Synthetic answer with context. '.repeat(100),at:new Date(1700000000000+i*1000+500).toISOString()},{type:'turn_done',turnId:`t${i}`}]).flat();
const start=performance.now();const result=reduceEvents(emptyTranscript(),events);
console.log(JSON.stringify({fixtureTurns:10000,events:events.length,bytes:Buffer.byteLength(JSON.stringify(events)),items:result.items.length,reduceMs:performance.now()-start}));
