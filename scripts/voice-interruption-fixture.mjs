// Real media-only fixture. No recordings or provider diagnostics are retained.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AudioFrame } from '@livekit/rtc-node';

export async function runInterruptionSmoke({ source, service, db, directory, reference, getSamples, getAudibleSamples }) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = () => service.status(1)?.state;
  const waitFor = async (condition, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      if (Date.now() > deadline || state() === 'failed') throw new Error('Fixture condition not reached');
      await delay(20);
    }
  };
  const speak = async (text, onStart = () => {}) => {
    const wav = path.join(directory, 'interruption.wav');
    execFileSync('/usr/bin/say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@24000', text], { stdio:'ignore' });
    const buffer = readFileSync(wav);
    let pcm;
    for (let offset=12; offset+8<=buffer.length;) {
      const size=buffer.readUInt32LE(offset+4);
      if(buffer.toString('ascii',offset,offset+4)==='data') {pcm=buffer.subarray(offset+8,offset+8+size);break;}
      offset+=8+size+(size%2);
    }
    if (!pcm) throw new Error('Missing fixture audio');
    onStart();
    for(let offset=0;offset<pcm.length;offset+=960) {
      const data=new Int16Array(480);
      for(let i=0;i<480 && offset+i*2+1<pcm.length;i++) data[i]=pcm.readInt16LE(offset+i*2);
      await source.captureFrame(new AudioFrame(data,24000,1,480));
    }
    await source.waitForPlayout();
  };
  await waitFor(() => getSamples()>0);
  await waitFor(() => state()==='listening');
  await speak('For an audio test, count slowly from one to one hundred without stopping. Do not use tools or send any instructions.');
  let silence = setInterval(() => { void source.captureFrame(AudioFrame.create(24000,1,480)).catch(()=>{}); },20);
  try {
    await waitFor(() => state()==='speaking');
    clearInterval(silence);
    await source.waitForPlayout();
    const before=getAudibleSamples();
    let noiseStoppedSpeech=false;
    let seed=17;
    // Three seconds of low ambient hiss and two short, louder shaped bursts.
    // These approximate incidental noise; they are not recordings of human coughs.
    for(let frame=0;frame<150;frame++) {
      const data=new Int16Array(480);
      for(let i=0;i<480;i++) {
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        const t=(frame*480+i)/24000;
        const burst=(t>=0.5&&t<0.62)||(t>=1.5&&t<1.68);
        data[i]=Math.round(((seed/4294967296)*2-1)*(burst?7000:700));
      }
      await source.captureFrame(new AudioFrame(data,24000,1,480));
      noiseStoppedSpeech ||= state()!=='speaking';
    }
    await source.waitForPlayout();
    const noisePassed=!noiseStoppedSpeech && state()==='speaking' && getAudibleSamples()>before;
    let interruptionMs=null;
    let poll;
    try {
      await speak('Stop counting. Say interruption confirmed and tell me the delivery reference from the completed work in this thread. Do not start any work.', () => {
        const started=Date.now();
        poll=setInterval(()=> {if(interruptionMs===null && state()!=='speaking') interruptionMs=Date.now()-started;},10);
      });
    } finally {clearInterval(poll);}
    silence=setInterval(()=>{void source.captureFrame(AudioFrame.create(24000,1,480)).catch(()=>{});},20);
    await waitFor(()=> {
      const rows=db.prepare('SELECT role,text FROM voice_entries ORDER BY id').all();
      const lastUser=rows.findLastIndex(r=>r.role==='user');
      return lastUser>=0 && rows.slice(lastUser+1).some(r=>r.role==='assistant' && r.text.includes(reference));
    },30000);
    const noDispatch=db.prepare('SELECT count(*) AS n FROM voice_dispatches').get().n===0;
    const passed=noisePassed && interruptionMs!==null && interruptionMs<2500 && noDispatch;
    console.log(JSON.stringify({passed,mode:'interruptions',noisePassed,interruptionMs,referenceRecalled:true,noDispatch}));
    return passed;
  } finally {clearInterval(silence);}
}
