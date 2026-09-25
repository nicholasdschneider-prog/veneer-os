// Synthetic speech, in-memory ticket, no customer connection or actual send.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AudioFrame } from '@livekit/rtc-node';

export async function runReplySmoke({ source, service, db, directory, callId, decisionId, getSamples }) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = () => service.status(1)?.state;
  const decision = () => db.prepare('SELECT version,state,proposal_json,answer_json FROM bot_decisions WHERE id=?').get(decisionId);
  const waitFor = async condition => {
    const deadline = Date.now() + 45000;
    while (!condition()) {
      if (Date.now() > deadline || state() === 'failed') throw new Error('Reply fixture condition not reached');
      await delay(100);
    }
  };
  let silence;
  const speak = async text => {
    clearInterval(silence);
    const wav = path.join(directory, 'reply.wav');
    execFileSync('/usr/bin/say', ['-o',wav,'--file-format=WAVE','--data-format=LEI16@24000',text], {stdio:'ignore'});
    const buffer = readFileSync(wav);
    let pcm;
    for (let offset=12; offset+8<=buffer.length;) {
      const size=buffer.readUInt32LE(offset+4);
      if (buffer.toString('ascii',offset,offset+4)==='data') { pcm=buffer.subarray(offset+8,offset+8+size); break; }
      offset+=8+size+(size%2);
    }
    if (!pcm) throw new Error('Missing fixture audio');
    for (let offset=0;offset<pcm.length;offset+=960) {
      const data=new Int16Array(480);
      for (let i=0;i<480 && offset+i*2+1<pcm.length;i++) data[i]=pcm.readInt16LE(offset+i*2);
      await source.captureFrame(new AudioFrame(data,24000,1,480));
    }
    await source.waitForPlayout();
    silence=setInterval(()=>{void source.captureFrame(AudioFrame.create(24000,1,480)).catch(()=>{});},20);
  };
  try {
    await waitFor(()=>getSamples()>0 && state()==='listening');
    await speak('Change the proposed customer reply to exactly: Please send a clear photo of the product label. Thank you. Save that wording and read it back. Do not approve or send yet.');
    await waitFor(()=>decision().version===2 && state()==='listening');
    const revised=decision();
    assert.equal(revised.state,'needs_input');
    assert.equal(revised.answer_json,null);
    assert.equal(JSON.parse(revised.proposal_json).message_delivery.payload.body,'Please send a clear photo of the product label. Thank you.');
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_wakeups').get().n,0);
    await speak('Yes, I approve sending that revised reply, for this case only. Record my approval now.');
    await waitFor(()=>decision().state==='decided' && state()==='listening');
    service.end(1,callId);
    assert.equal(JSON.parse(decision().answer_json).action,'approve');
    assert.equal(decision().version,2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM bot_decision_events WHERE kind='answered'").get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_wakeups').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM voice_dispatches').get().n,0);
    console.log(JSON.stringify({passed:true,mode:'reply-edit',spokenEdit:true,separateSpokenApproval:true,approvedVersion:2,oneDurableWakeAfterHangup:true,customerSends:0}));
    return true;
  } finally { clearInterval(silence); }
}
