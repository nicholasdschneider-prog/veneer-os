import { describe, it, expect } from 'vitest';
import { communicationTime, voiceTimeline, mergeVoiceSessions, type VoiceSession } from './voiceTimeline';
import type { ChatItem } from './transcript';
const at=(n:number)=>new Date(n*60000).toISOString();
const message=(key:string,n?:number):ChatItem=>({kind:'assistant',key,markdown:key,...(n===undefined?{}:{at:at(n)})});
const call=(id:string,n:number):VoiceSession=>({id,started_ms:n*60000,connected_ms:n*60000,duration_ms:60000,outcome:'completed'});
const keys=(items:ChatItem[],calls:VoiceSession[],frozen=items.length)=>voiceTimeline(items,frozen,calls).entries.flatMap(e=>e.kind==='static'?e.items.map(i=>i.key):(e.kind==='voice'||e.kind==='reply'||e.kind==='card')?[e.key]:[e.item.key]);
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

describe('result replies in the main timeline', () => {
  const reply = (id:string,n:number,seq:number) => ({id,seq,thread_id:'thread',anchor:JSON.stringify({turn:'turn',at:at(1)}),source_text:'Original',text:id,actor_name:'Person',actor_conversation_id:null,bot_name:'Bot',created_at:at(n).replace('T',' ').replace('.000Z',''),unread:1});
  it('interleaves old and new replies with messages and calls without moving transcript rows', () => {
    const items=[message('original',1),message('later',5),message('latest',10)];
    const result=voiceTimeline(items,2,[call('call',4)],[reply('human',3,1),reply('bot',7,2)]);
    expect(result.entries.flatMap(e=>e.kind==='static'?e.items.map(i=>i.key):[e.key])).toEqual(['original','reply-human','voice-call','later','reply-bot','latest']);
    expect(result.entries.at(-1)?.kind).toBe('live');
  });
  it('keeps same-second replies in durable sequence order across freezes', () => {
    const items=[message('original',1),message('later',5)];
    const replies=[reply('z',3,1),reply('a',3,2)];
    for(const frozen of [0,1,2]) expect(voiceTimeline(items,frozen,[],replies).entries.filter(e=>e.kind==='reply').map(e=>e.key)).toEqual(['reply-z','reply-a']);
  });
});


describe('outgoing message cards in the main timeline', () => {
  const rowKeys = (items: ChatItem[], frozen: number, drafts: {id:string;created_at:string}[]) =>
    voiceTimeline(items, frozen, [], [], drafts.map(d => ({id:d.id,time:communicationTime(d.created_at)})))
      .entries.flatMap(e => e.kind === 'static' ? e.items.map(i => i.key) : [e.key]);
  it('keeps draft and sent cards between their original neighbors as new replies arrive', () => {
    const original = {id:'sms',created_at:'1970-01-01 00:03:00',state:'draft',version:1};
    const updated = {...original,state:'sent',version:2,updated_at:at(12)};
    const messages = [message('before',1),message('after',5)];
    expect(rowKeys(messages,2,[original])).toEqual(['before','draft-sms','after']);
    for (const frozen of [0,2,3]) {
      expect(rowKeys([...messages,message('new-reply',15)],frozen,[updated]))
        .toEqual(['before','draft-sms','after','new-reply']);
    }
  });
  it('keeps chronological positions when older transcript history loads and polling returns newest first', () => {
    const drafts = [{id:'newer',created_at:at(8)},{id:'older',created_at:at(3)}];
    expect(rowKeys([message('old',1),message('middle',5),message('new',10)],3,drafts))
      .toEqual(['old','draft-older','middle','draft-newer','new']);
    expect(rowKeys([message('middle',5),message('new',10)],1,drafts.filter(d=>communicationTime(d.created_at)>=5*60000)))
      .toEqual(['middle','draft-newer','new']);
  });
  it('interprets saved SQLite times as UTC and accepts timestamps with an explicit zone', () => {
    expect(communicationTime('2026-09-25 14:36:12')).toBe(Date.parse('2026-09-25T14:36:12Z'));
    expect(communicationTime('2026-09-25T10:36:12-04:00')).toBe(Date.parse('2026-09-25T14:36:12Z'));
  });
});
