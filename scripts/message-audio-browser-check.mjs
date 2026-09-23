// Isolated player verification with fixture audio; no production records or paid speech calls.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {MessageAudioProvider,useMessageListen} from '/src/components/MessageAudioPlayer.tsx';
import '/src/styles.css';
const h=React.createElement;
function Fixture(){ const listen=useMessageListen(); const [route,setRoute]=React.useState('Chat');
return h('main',{style:{padding:'340px 16px 16px'}},h('h1',null,route),h('button',{onClick:()=>listen({chat:'fixture',turn:'turn',at:'now'})},'Listen fixture'),h('button',{onClick:()=>setRoute('VeneerBots')},'Navigate'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(MessageAudioProvider,null,h(Fixture)));`;
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3296,strictPort:true,preTransformRequests:false},plugins:[{name:'fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));});}}]});
await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/message-audio/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
try {
 for(const width of [390,1440]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.mediaHandlers={};
    const original=navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler=(action,handler)=>{window.mediaHandlers[action]=handler;original(action,handler);};
  });
  let fail=true;
  await page.route('**/api/bot-communication/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/listen'))return route.fulfill({json:{id:'fixture',parts:2}});
   if(fail)return route.fulfill({status:503,json:{error:'Audio unavailable. Try again.'}});
   return route.fulfill({json:{url:'/fixture-audio.wav'}});
  });
  await page.route('**/fixture-audio.wav',route=>{
   const length=8000*2*60,wav=Buffer.alloc(44+length);wav.write('RIFF');wav.writeUInt32LE(36+length,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(length,40);
   const range=route.request().headers()['range']?.match(/^bytes=(\d+)-(\d*)$/);
   if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;return route.fulfill({status:206,contentType:'audio/wav',headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${wav.length}`},body:wav.subarray(start,end+1)});}
   return route.fulfill({contentType:'audio/wav',headers:{'accept-ranges':'bytes'},body:wav});
  });
  await page.goto('http://127.0.0.1:3296/__fixture');
  await page.getByRole('button',{name:'Listen fixture'}).click();
  await page.getByText('Audio unavailable. Try again.').waitFor();
  fail=false;await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=2);
  await page.waitForFunction(()=>{const a=document.querySelector('audio');return a && a.duration===60 && a.seekable.length && a.seekable.end(0)>=30;});
  await page.evaluate(()=>{const a=document.querySelector('audio');a.pause();a.currentTime=30;});
  await page.waitForFunction(()=>Math.abs(document.querySelector('audio').currentTime-30)<1);
  await page.getByRole('button',{name:'Back 15s'}).click();
  assert.ok(Math.abs(await page.locator('audio').evaluate(a=>a.currentTime)-15)<1);
  await page.getByRole('combobox',{name:'Playback speed'}).selectOption('1.5');
  assert.equal(await page.locator('audio').evaluate(a=>a.playbackRate),1.5);
  await page.evaluate(()=>window.mediaHandlers.seekbackward({action:'seekbackward',seekOffset:5}));
  assert.ok(Math.abs(await page.locator('audio').evaluate(a=>a.currentTime)-10)<1);
  await page.evaluate(()=>window.mediaHandlers.seekforward({action:'seekforward',seekOffset:5}));
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  assert.equal(await page.locator('audio').count(),1);
  await page.getByRole('button',{name:'Close message player'}).click();
  await page.getByRole('button',{name:'Listen fixture'}).click();
  await page.waitForFunction(()=>document.querySelector('audio')?.currentTime>=14);
  await page.locator('audio').evaluate(a=>a.pause());
  await page.getByRole('combobox',{name:'Audio section'}).selectOption('1');
  await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=2);
  assert.equal(await page.getByRole('combobox',{name:'Audio section'}).inputValue(),'1');
  await page.evaluate(()=>{const a=document.querySelector('audio');a.pause();a.currentTime=20;a.dispatchEvent(new Event('timeupdate'));});
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('veneer-listen:fixture')).part),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===390)await page.screenshot({path:output+'mobile.png'});
  await page.evaluate(()=>window.dispatchEvent(new Event('veneer-live-voice-opening')));
  assert.equal(await page.locator('audio').count(),0);
  assert.equal(await page.evaluate(()=>window.mediaHandlers.play),null);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Message audio browser checks passed: desktop/mobile, failure/retry, seek, speed, navigation, resume, sections, live-voice handoff, no overflow. Physical iPhone background/headphone behavior is not verified.');
} finally {await browser.close();await vite.close();}
