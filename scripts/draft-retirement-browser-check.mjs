// Isolated draft UI fixture; no real customer or source requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const source=`import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';import {BotCommunication} from '/src/components/BotCommunication.tsx';import '/src/styles.css';ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-2xl p-3'},React.createElement(BotCommunication,{conversationId:'fixture',mode:'drafts'})));`;
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3299,strictPort:true,preTransformRequests:false},plugins:[{name:'routine-fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));});}}]});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/draft-retirement/screenshots/',import.meta.url).pathname;await mkdir(output,{recursive:true});
try{
for(const width of [320,375,414,768,1440])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;assert.equal(route.request().method(),'GET');if(p.endsWith('/routine-status'))return route.fulfill({json:{message:'Routine sending is not enabled: a trusted source connection and category eligibility verifier are still required.'}});if(p.endsWith('/chats/fixture'))return route.fulfill({json:{briefings:[],drafts:[{id:'fixture-draft',version:1,decision_id:null,state:'discarded',retirement:{reason:'Answered independently',evidence:'Independent fixture SENT receipt; not this draft delivery',created_at:'2026-09-23 18:00:00'},stale:false,payload:{channel:'email',account:'fixture@example.test',recipients:['customer@example.test'],subject:'Fixture information request',body:'Which model do you have?',customer:'Fixture customer',ticket:'FIXTURE',attachments:[],context:''}}]}});return route.fulfill({status:404,json:{error:'fixture'}});});
 await page.goto('http://127.0.0.1:3299/__fixture');await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
 await page.getByText('Retired without delivery',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 await page.screenshot({path:output+`draft-${width}-${theme}.png`,fullPage:true});await page.close();console.log('PASS',width,theme);
}
}finally{await browser.close();await vite.close();}
