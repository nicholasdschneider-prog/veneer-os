// Mocked, isolated UI checks. Never connects a microphone or sends a customer message.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {VoiceCallPanel} from '/src/components/VoiceCallPanel.tsx';
import {DecisionChoices} from '/src/components/DecisionChoices.tsx';
import '/src/styles.css';
const h=React.createElement;
window.actions=[];
function Fixture(){
 const [active,setActive]=React.useState(false);
 const [muted,setMuted]=React.useState(false);
 const [choice,setChoice]=React.useState('');
 return h('main',{style:{maxWidth:576,margin:'auto',padding:'390px 12px 12px'}},
 h('h1',null,'Still queue order 100122091 into Auto-Ship?'),
 choice ? h('p',{role:'status'},'Recorded: '+choice+' · Execution tracked separately') : h(DecisionChoices,{disabled:false, choices:[{id:'yes',label:'Yes — queue Auto-Ship',action:'approve'},{id:'hold',label:'Hold order',action:'defer'},{id:'no',label:'Reject proposal',action:'reject'}],onChoose:id=>{window.actions.push(id);setChoice(id)}}),
 h('div',{className:'fixed left-1/2 top-4 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2'},h(VoiceCallPanel,{name:'Avery',botId:'fixture',status:active?'Listening':'Ready when you are',active,connected:active,muted,level:active?.65:0,ready:true,history:[{id:1,role:'user',text:'What do you need from me?'},{id:2,role:'assistant',text:'The order is ready to queue. The customer has confirmed the address. Please choose whether to queue Auto-Ship or hold the order. No shipment has been queued yet.'}],onStart:()=>{window.actions.push('start');setActive(true)},onMute:()=>setMuted(!muted),onEnd:()=>{window.actions.push('end');setActive(false)},onStandby:()=>{window.actions.push('standby');setActive(false)}})));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
const vite = await createServer({
 root:new URL('../web',import.meta.url).pathname,
 server:{host:'127.0.0.1',port:3298,strictPort:true,preTransformRequests:false},
 plugins:[{name:'fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{
 res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');
 res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));
 });}}],
});
await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/decision-voice/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
try {
 for(const width of [320,375,414,768,1440]){
 const page=await browser.newPage({viewport:{width,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3298/__fixture');
 await page.getByRole('button',{name:'Start voice',exact:true}).click();
 await page.getByRole('button',{name:'Mute microphone',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Unmute microphone'}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Unmute microphone'}).click();
 await page.screenshot({path:output+`compact-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Show transcript'}).click();
 assert.equal(await page.getByRole('button',{name:'Show transcript'}).getAttribute('aria-expanded'),'true');
 await page.getByText('What do you need from me?').waitFor();
 await page.mouse.move(0,990);
 await page.screenshot({path:output+`transcript-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Collapse transcript'}).click();
 await page.getByRole('button',{name:'Voice settings'}).click();
 await page.getByRole('button',{name:'Standby · microphone off'}).click();
 await page.getByRole('button',{name:'Start voice',exact:true}).waitFor();
 await page.getByRole('button',{name:'Voice settings'}).click();
 await page.getByRole('button',{name:'Hold order',exact:false}).focus();
 await page.keyboard.press('Enter');
 assert.deepEqual(await page.evaluate(()=>window.actions),['start','standby','hold']);
 await page.getByText('Recorded: hold').waitFor();
 await page.getByRole('button',{name:'Close and end voice'}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 await page.close();
 }
 console.log('Voice controls, transcript, keyboard decision, and overflow passed at 320/375/414/768/1440px. No live call or customer action.');
}finally{await browser.close();await vite.close();}
