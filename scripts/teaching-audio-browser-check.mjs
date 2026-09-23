// Isolated UI/media fixtures: no live accounts, browser actions, or provider requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const source=`import React from '/node_modules/.vite/deps/react.js';const {useState}=React;import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';import {Teach} from '/src/components/TeachTask.tsx';import '/src/styles.css';function App(){const [session,setSession]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const reload=async()=>{const r=await fetch('/api/fixture');setSession(await r.json());};const act=async(fn)=>{setBusy(true);try{await fn();await reload();}catch(e){setError(e.message);}finally{setBusy(false);}};return React.createElement('main',{className:'mx-auto h-dvh max-w-3xl overflow-y-auto p-4'},React.createElement('h1',{className:'mb-4 text-xl font-semibold'},'Teach Clara · fixture'),error&&React.createElement('p',{role:'alert'},error),React.createElement(Teach,{bot:{id:'clara-fixture',name:'Clara'},session,busy,act,reload}));}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));`;
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3299,strictPort:true,preTransformRequests:false},plugins:[{name:'teaching-fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));});}}]});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const output=new URL('../docs/reports/teaching-narration/',import.meta.url).pathname;await mkdir(output,{recursive:true});
try{
 for(const width of [320,375,414,768,1440])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:1100},permissions:['microphone'],reducedMotion:'reduce'});let session=null,clips=[],uploads=0,saved=false;const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('FIXTURE',e.message);});
  await page.route('**/veneer-browser?**',r=>r.fulfill({contentType:'text/html',body:'<p>Isolated browser-action fixture</p>'}));
  await page.route('**/api/**',async route=>{
   const r=route.request(),u=new URL(r.url()),p=u.pathname,method=r.method();
   const respond=body=>route.fulfill({json:body});
   if(p==='/api/fixture')return respond(session);
   if(p.endsWith('/bots/clara-fixture/teach')){session={id:'fixture-session',name:'Accounting report',state:'recording',started_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),steps_json:'[]',draft:'',skill_name:null,test_requested_at:null};return respond({session});}
   if(p.endsWith('/audio')&&method==='GET')return respond({clips});
   if(p.endsWith('/audio')&&method==='POST'){assert(r.postDataBuffer().length>0);uploads++;const c={id:`clip${uploads}`,offset_ms:Number(u.searchParams.get('offset')),duration_ms:Number(u.searchParams.get('duration')),transcript:null};clips.push(c);return respond({id:c.id});}
   if(p.endsWith('/transcribe')){clips.find(c=>p.includes('/'+c.id+'/')).transcript='I choose cleared payments because pending payments are not reconciled.';return respond({ok:true});}
   if(p.endsWith('/transcript')){clips.find(c=>p.includes('/'+c.id+'/')).transcript=r.postDataJSON().text;return respond({ok:true});}
   if(p.endsWith('/pause'))session.state='paused';
   else if(p.endsWith('/resume'))session.state='recording';
   else if(p.endsWith('/stop')){session.state='draft';session.draft='# Accounting report\n\n## Narration\n'+clips.map(c=>c.transcript).join('\n');}
   else if(p.endsWith('/save')){assert(r.postDataJSON().draft.includes('cleared payments'));session.state='saved';session.skill_name='accounting-report';saved=true;}
   else if(p.includes('/audio/'))return route.fulfill({status:200,contentType:'audio/webm',body:Buffer.from([0x1a,0x45,0xdf,0xa3])});
   else return route.fulfill({status:404,json:{error:'Not available in fixture'}});
   return respond({session});
  });
  await page.goto('http://127.0.0.1:3299/__fixture');await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
  await page.getByLabel('Task name',{exact:true}).fill('Accounting report');await page.getByLabel('Expected outcome').fill('Explain why I choose cleared payments');await page.getByLabel('Record microphone narration').check();await page.getByRole('button',{name:'Start demonstration'}).click();await page.getByText('● Microphone recording',{exact:true}).waitFor();
  await page.waitForTimeout(150);await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Resume',exact:true}).waitFor();assert.equal(uploads,1);
  await page.getByRole('button',{name:'Resume',exact:true}).click();await page.getByText('● Microphone recording',{exact:true}).waitFor();await page.waitForTimeout(150);await page.getByRole('button',{name:'Stop and review'}).click();await page.getByLabel('Review the skill').waitFor();assert.equal(uploads,2);assert.equal(await page.locator('audio[autoplay]').count(),0);assert((await page.getByLabel('Review the skill').inputValue()).includes('cleared payments'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.screenshot({path:output+`review-${width}-${theme}.png`,fullPage:true});await page.getByRole('button',{name:'Save reviewed skill'}).click();await page.getByText('Saved: accounting-report').waitFor();assert(saved);await page.close();console.log('PASS narration',width,theme);
 }
 // Permission denied: preserve the demonstration and allow explicit silent fallback.
 const page=await browser.newPage();await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};});let session=null;
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;if(p.endsWith('/teach')){session={id:'denied',name:'Silent',state:'recording',started_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),steps_json:'[]',draft:''};return r.fulfill({json:{session}});}if(p==='/api/fixture')return r.fulfill({json:session});return r.fulfill({json:{clips:[]}});});await page.route('**/veneer-browser?**',r=>r.fulfill({body:'fixture'}));await page.goto('http://127.0.0.1:3299/__fixture');await page.getByLabel('Task name',{exact:true}).fill('Silent');await page.getByLabel('Expected outcome').fill('Test fallback');await page.getByLabel('Record microphone narration').check();await page.getByRole('button',{name:'Start demonstration'}).click();await page.getByRole('alert').filter({hasText:'Microphone unavailable'}).waitFor();await page.getByRole('button',{name:'Continue without narration'}).click();assert(await page.getByRole('button',{name:'Stop and review'}).isVisible());await page.close();console.log('PASS denied permission fallback');
}finally{await browser.close();await vite.close();}
