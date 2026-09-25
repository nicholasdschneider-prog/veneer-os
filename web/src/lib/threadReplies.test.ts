import { isResultReplyDelivery } from './threadReplies';
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


it('suppresses only internal result deliveries, leaving the canonical reply and ordinary messages visible', () => {
  const text = 'Hey, can you pick this back up for me?\n\nA human replied in message thread 20958f1b-7c52-4d91-98de-9fc9b5ae38ff. Use read_message_thread to read the original result and replies';
  expect(isResultReplyDelivery({text,origin:{kind:'wakeup',from:'Bot',to:'Bot'}})).toBe(true);
  expect(isResultReplyDelivery({text})).toBe(false);
  expect(isResultReplyDelivery({text:'Check inventory tomorrow',origin:{kind:'wakeup',from:'Bot',to:'Bot'}})).toBe(false);
  expect(isResultReplyDelivery({text:'Actual human reply',origin:{kind:'result_reply',from:'Human',to:'Bot'}})).toBe(true);
});
