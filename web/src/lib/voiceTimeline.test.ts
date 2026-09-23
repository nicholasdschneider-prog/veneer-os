import { describe, it, expect } from 'vitest';
import { voiceTimeline, mergeVoiceSessions, type VoiceSession } from './voiceTimeline';
import type { ChatItem } from './transcript';
const at=(n:number)=>new Date(n*60000).toISOString();
const message=(key:string,n?:number):ChatItem=>({kind:'assistant',key,markdown:key,...(n===undefined?{}:{at:at(n)})});
const call=(id:string,n:number):VoiceSession=>({id,started_ms:n*60000,connected_ms:n*60000,duration_ms:60000,outcome:'completed'});
const keys=(items:ChatItem[],calls:VoiceSession[],frozen=items.length)=>voiceTimeline(items,frozen,calls).entries.flatMap(e=>e.kind==='static'?e.items.map(i=>i.key):e.kind==='voice'?[e.key]:[e.item.key]);
describe('chronological voice cards',()=>{
 it('splits frozen history around calls rather than appending old calls to its bottom',()=>{
  expect(keys([message('morning',500),message('noon',720),message('afternoon',960)],[call('late',948),call('early',557)])).toEqual(['morning','voice-early','noon','voice-late','afternoon']);
 });
 it('preserves live boundary and chronological insertion when history freezes',()=>{
  const messages=[message('old',1),message('new',5)];
  expect(keys(messages,[call('middle',3)],1)).toEqual(keys(messages,[call('middle',3)],2));
  expect(voiceTimeline(messages,1,[call('middle',3)]).entries.at(-1)?.kind).toBe('live');
 });
 it('orders equal-time calls deterministically before the equal-time message and deduplicates polling',()=>{
  const merged=mergeVoiceSessions([call('b',3),call('a',3)],[{...call('b',3),duration_ms:90000}]);
  expect(merged).toHaveLength(2);expect(merged.find(c=>c.id==='b')?.duration_ms).toBe(90000);
  expect(keys([message('m',3)],merged)).toEqual(['voice-a','voice-b','m']);
 });
 it('keeps untimed activity and nonmonotonic transcript rows in original order',()=>{
  expect(keys([message('first',5),message('untimed'),message('earlier',2),message('last',8)],[call('c',6)])).toEqual(['first','untimed','earlier','voice-c','last']);
 });
 it('labels missing message-time fallback and never fabricates timestamps',()=>{
  const items=[message('legacy'),{...message('invalid'),at:'invalid'}];
  const result=voiceTimeline(items,2,[call('c',6)]);
  expect(result.hasMessageTimes).toBe(false);expect(keys(items,[call('c',6)])).toEqual(['voice-c','legacy','invalid']);
  expect(items[0]).not.toHaveProperty('at');
 });
 it('places older pages at the beginning and newer completed calls before future text',()=>{
  const calls=mergeVoiceSessions([call('latest',8)],[call('old',1)]);
  expect(keys([message('m',4),message('new',9)],calls)).toEqual(['voice-old','m','voice-latest','new']);
 });
 it('keeps mounted mermaid and image messages interactive with stable keys across insertions',()=>{
  const items=[{...message('diagram',4),markdown:'```mermaid\ngraph TD;A-->B\n```'},{...message('image',9),markdown:'![photo](/fixture.png)'}] as ChatItem[];
  const before=voiceTimeline(items,2,[]).entries,after=voiceTimeline(items,2,[call('c',6)]).entries;
  expect(after.map(e=>e.kind)).toEqual(['live-mermaid','voice','live-image']);
  expect(after.filter(e=>e.kind!=='voice').map(e=>e.key)).toEqual(before.map(e=>e.key));
 });
});
