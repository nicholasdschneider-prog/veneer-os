// Real synthesized PCM through LiveKit/OpenAI; only in-memory fixture decisions exist.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {AudioFrame} from '@livekit/rtc-node';
export async function runHotlineSmoke({source,service,db,directory,getSamples}) {
 let silence; const delay=ms=>new Promise(r=>setTimeout(r,ms));let stage='connect';
 const selected=()=>db.prepare('SELECT selected_id FROM question_line_state WHERE user_id=1').get()?.selected_id;
 const state=id=>db.prepare('SELECT state FROM bot_decisions WHERE id=?').get(id)?.state;
 const wait=async(fn)=>{const end=Date.now()+55000;while(!fn()){if(Date.now()>end||service.status(1)?.state==='failed')throw new Error('Timeout');await delay(100);} };
 const ready=async()=>{await wait(()=>service.status(1)?.state==='listening');await delay(1500);};
 const speak=async(text)=>{await ready();clearInterval(silence);const wav=path.join(directory,'hotline.wav');execFileSync('/usr/bin/say',['-o',wav,'--file-format=WAVE','--data-format=LEI16@24000',text],{stdio:'ignore'});const b=readFileSync(wav);let pcm;for(let o=12;o+8<=b.length;){const n=b.readUInt32LE(o+4);if(b.toString('ascii',o,o+4)==='data'){pcm=b.subarray(o+8,o+8+n);break;}o+=8+n+(n%2);}if(!pcm)throw new Error('No audio');for(let o=0;o<pcm.length;o+=960){const data=new Int16Array(480);for(let i=0;i<480&&o+i*2+1<pcm.length;i++)data[i]=pcm.readInt16LE(o+i*2);await source.captureFrame(new AudioFrame(data,24000,1,480));}await source.waitForPlayout();silence=setInterval(()=>{void source.captureFrame(AudioFrame.create(24000,1,480)).catch(()=>{});},20);};
 try {
  await wait(()=>getSamples()>0);stage='select first';await speak('Let us answer my questions. Start with Atlas and the first draft.');await wait(()=>selected()==='hotline-a1');
  stage='show evidence';await speak('Show me the evidence for this question.');await wait(()=>db.prepare('SELECT show_evidence FROM question_line_state WHERE user_id=1').get()?.show_evidence===1);
  stage='spoken choice';await speak('I choose Use draft for this question. Please record that answer.');await wait(()=>state('hotline-a1')==='decided');await wait(()=>selected()==='hotline-b1');
  stage='follow-up';await speak('Before I answer Robin, ask Robin to double check the internal draft and report back here. This is only a question, not approval.');await wait(()=>db.prepare("SELECT count(*) n FROM bot_decision_threads WHERE decision_id='hotline-b1'").get().n>0);assert.equal(state('hotline-b1'),'needs_input');
  stage='skip';await speak('Skip Robin for now and bring me the next question.');await wait(()=>selected()==='hotline-a2');assert.equal(state('hotline-b1'),'needs_input');
  assert.equal(state('hotline-a2'),'needs_input');stage='pick bot';await speak('Go back to Robin and show me that question.');await wait(()=>selected()==='hotline-b1');
  assert.equal(state('hotline-a2'),'needs_input');stage='remind';await speak('Remind me about Robin’s question in one hour. Leave it unanswered.');await wait(()=>db.prepare("SELECT until_ms FROM question_line_positions WHERE decision_id='hotline-b1'").get()?.until_ms>Date.now());assert.equal(state('hotline-b1'),'needs_input');
  stage='end';await speak('That is enough for now. End the hotline call.');await wait(()=>service.status(1)===null);
  assert.equal(state('hotline-a2'),'needs_input');console.log(JSON.stringify({passed:true,mode:'hotline-real-audio',checks:['received audio','transcribed instructions','selected exact bot','show evidence','spoken choice recorded','next bot','follow-up without approval','skip without defer','pick bot','timed reminder','spoken hangup preserves unanswered']}));return true;
 }catch {console.log(JSON.stringify({passed:false,mode:'hotline-real-audio',stage,selected:selected(),states:['hotline-a1','hotline-b1','hotline-a2'].map(id=>({id,state:state(id)})),transcript:db.prepare('SELECT role,text FROM voice_entries ORDER BY id').all()}));return false;}finally{clearInterval(silence);}
}
