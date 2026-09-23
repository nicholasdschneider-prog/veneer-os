import {it,expect} from 'vitest';
import {csDraftState} from '../src/bots/csDraftState.js';
const draft={state:'draft',receipt:null,claim_key:null,authorized_by:null};
const context={retired:false,routine:false,delegated:false,stale:false};
it('never treats an unbound differing William draft as the original approval',()=>{
 expect(csDraftState(draft,context)).toMatchObject({state:'blocked',execute:false});
 expect(csDraftState(draft,{...context,decision:{id:'original',version:1,state:'blocked',answer:'approve'}})).toMatchObject({state:'blocked',label:'Business decision approved · message unbound',execute:false});
});
it.each(['reject','defer','withdraw'])('preserves %s without creating another question',answer=>{
 expect(csDraftState(draft,{...context,decision:{id:'d',version:1,state:'decided',answer}}).state).toBe('held');
});
it('shows a human question only with explicit unanswered native state',()=>{
 expect(csDraftState(draft,{...context,decision:{id:'d',version:1,state:'needs_input',answer:null}}).state).toBe('needs_decision');
});
it.each(['queued','sending','uncertain','sent','discarded'])('distinguishes %s without fabricated receipt',state=>{
 const expected={queued:'queued',sending:'sending',uncertain:'unknown',sent:'unknown',discarded:'retired'}[state];
 expect(csDraftState({...draft,state},context).state).toBe(expected);
});
it('requires receipt for sent, retains retirement, never grants execute',()=>{
 expect(csDraftState({...draft,state:'sent',receipt:'provider1'},context)).toMatchObject({state:'sent',execute:false});
 expect(csDraftState(draft,{...context,retired:true}).state).toBe('retired');
 expect(csDraftState(draft,{...context,routine:true})).toMatchObject({state:'blocked',label:'Routine-authorized · technically blocked'});
});
