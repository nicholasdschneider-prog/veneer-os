// Isolated room UI fixtures; no live people, bot runs, or account requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
const {chromium} = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import '/src/styles.css';
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(TeamMessages,{roomId:'fixture',onNavigate:()=>{}}));`;
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true,preTransformRequests:false},plugins:[{name:'fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));});}}]});
await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 for(const width of [390,1280]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let state='queued';
  const room={id:'fixture',team_id:'team',kind:'group',name:'Grant, Nick, Ali',revision:1,last_seq:1,self_key:'user:1',can_send:true,can_manage:true,unread:0,updated_at:'2026-09-25',next:null,
   members:[{key:'user:1',name:'Nick',kind:'human'},{key:'user:2',name:'Ali',kind:'human'},{key:'bot:grant',name:'Grant',kind:'bot',available:true}],
   messages:[{id:'m1',seq:1,author_key:'user:1',author_name:'Nick',text:'@Grant answer Ali above',created_at:'2026-09-25 12:00:00',mentions:['bot:grant'],attachments:[]}]};
  await page.route('**/api/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/team-rooms/fixture')return route.fulfill({json:{room:{...room,bot_activity:[{bot_key:'bot:grant',name:'Grant',message_id:'m1',state}]}}});
   if(p.endsWith('/seen'))return route.fulfill({json:{ok:true}});
   if(p.endsWith('/directory'))return route.fulfill({json:{self_key:'user:1',teams:[]}});
   return route.fulfill({status:404,json:{error:'Fixture only'}});
  });
  await page.goto('http://127.0.0.1:3297/__fixture');
  await page.getByText('Addressed: Grant',{exact:true}).waitFor();
  await page.getByRole('status').getByText('Grant: Queued',{exact:true}).waitFor();
  state='working';await page.getByRole('status').getByText('Grant: Working…',{exact:true}).waitFor();
  state='failed';await page.getByRole('status').getByText('Grant: Stopped after an error',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('@Grant answer');
  await page.getByText('Choose a person or bot from the @ picker to address them.',{exact:false}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('PASS room status and mention feedback',width);await page.close();
 }
} finally {await browser.close();await vite.close();}
