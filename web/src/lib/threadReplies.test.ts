import {describe, expect, it} from 'vitest';
import {mergeThreadReplies, replyTime, type ThreadReply} from './threadReplies';
const reply=(id:string,seq:number):ThreadReply=>({id,seq,thread_id:'thread',anchor:'{}',source_text:'Original',text:id,actor_name:'Person',actor_conversation_id:null,bot_name:'Bot',created_at:'2026-09-24 14:05:00',unread:0});
describe('reply feed reconciliation',()=>{
  it('deduplicates readback and polling while retaining older pages and unrelated replies',()=>{
    const current=[reply('older',1),reply('sent',3)];
    const updated=mergeThreadReplies(current,[reply('other-thread',2),{...reply('sent',3),bot_name:'Actual name'}]);
    expect(updated.map(r=>r.id)).toEqual(['older','other-thread','sent']);
    expect(updated[2]?.bot_name).toBe('Actual name');
    expect(current).toHaveLength(2);
    expect(mergeThreadReplies(updated,[])).toBe(updated);
  });
  it('interprets database timestamps as UTC regardless of browser locale',()=>{
    expect(replyTime(reply('one',1))).toBe(Date.parse('2026-09-24T14:05:00Z'));
  });
});
