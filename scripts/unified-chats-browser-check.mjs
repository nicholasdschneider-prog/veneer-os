// Isolated fixtures: no real people, providers, or connected business actions.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {BotConversationRail} from '/src/components/BotConversationRail.tsx';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import {NavShell} from '/src/components/NavBar.tsx';
import {EmployeeWorkspace} from '/src/screens/EmployeeWorkspace.tsx';
import '/src/styles.css';
const h=React.createElement;function Fixture(){const [hash,setHash]=React.useState('#/bots');const restricted=new URLSearchParams(location.search).has('restricted');if(restricted)return h(EmployeeWorkspace,{hash,onNavigate:setHash,email:'fixture@example.test',onToast:()=>{}});return h(NavShell,{current:'bots',canManage:true,signedInEmail:'fixture@example.test',onNavigate:setHash},hash.startsWith('#/messages/')?h(TeamMessages,{roomId:hash.split('/')[2].split('?')[0],fromBots:true,onNavigate:setHash}):h('div',{className:'mx-auto h-full max-w-3xl'},h(BotConversationRail,{onNavigate:setHash})));}ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
const vite = await createServer({ root: new URL('../web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 3299, strictPort: true, preTransformRequests: false }, plugins: [{name:'fixture',configureServer(s){s.middlewares.use('/__fixture',async(req,res)=>{res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');res.end(req.url?.includes('entry')?source:await s.transformIndexHtml('/__fixture','<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));});}}] });
await vite.listen();
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
const output = new URL('../docs/reports/unified-chats/', import.meta.url).pathname;
await mkdir(output,{recursive:true});
const people = [{key:'user:1',name:'Nick',kind:'human'},{key:'user:2',name:'Mackenzie',kind:'human'}];
const clara = {key:'bot:clara',name:'Clara',kind:'bot'};
try {
 for (const width of [320,390,768,1280]) for (const restricted of [false,true]) {
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce',colorScheme:width===390?'dark':'light'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  let invited=null, inviteCalls=0, dmSeen=false, huddleCalls=0;
  const messages=[{id:'m1',seq:1,author_key:'user:2',author_name:'Mackenzie',text:'Nick, what is this charge on the card?',created_at:'2026-09-23 12:00:00',mentions:[],attachments:[]},{id:'m2',seq:2,author_key:'user:1',author_name:'Nick',text:'Software subscriptions.',created_at:'2026-09-23 12:01:00',mentions:[],attachments:[]}];
  const dm={id:'dm',team_id:'team',kind:'dm',name:'Direct message',members:people,updated_at:'2026-09-23',unread:7,self_key:'user:1',revision:1,last_seq:2,can_manage:true,can_send:true,messages,next:null,last_message:{text:'Software subscriptions.'}};
  const mixed={...dm,id:'mixed',kind:'group',name:'Operations',members:[...people,clara],unread:8};
  await page.addInitScript(()=>localStorage.setItem('veneer:selected-business','team'));
  await page.route('**/api/**',async route=>{
   const req=route.request(),u=new URL(req.url());let body={};
   if(u.pathname==='/api/bots')body={bots:[{conversation_id:'clara',name:'Clara',title:'Accounting',state:'idle',questions:0,unread:true,updated_at:'2026-09-23',membership:{subteam:'Finance',role:'specialist'}}],teams:[{id:'team',name:'Fixture business'}],decisions:[]};
   else if(u.pathname==='/api/huddles'){huddleCalls++;body={huddles:[]};}
   else if(u.pathname==='/api/team-rooms/directory')body={self_key:'user:1',teams:[{id:'team',name:'Fixture business',can_create:true,people,bots:[clara]}]};
   else if(u.pathname==='/api/team-rooms' && req.method()==='GET')body={rooms:[{...dm,unread:dmSeen?0:7},mixed,...(invited?[invited]:[])]};
   else if(u.pathname==='/api/team-rooms' && req.method()==='POST'){assert.equal(req.postDataJSON().kind,'dm');body={room:dm};}
   else if(u.pathname==='/api/team-rooms/dm')body={room:dm};
   else if(u.pathname==='/api/team-rooms/invited')body={room:invited};
   else if(u.pathname.endsWith('/seen')){if(u.pathname.includes('/dm/'))dmSeen=true;body={ok:true};}
   else if(u.pathname==='/api/team-rooms/dm/invite'){
    inviteCalls++;const p=req.postDataJSON();assert.equal(p.bot_key,'bot:clara');assert.equal(p.context,'Reviewed: software charge, no private history.');assert.equal(p.text,'@Clara what details do you need to categorize this?');
    invited={...mixed,id:'invited',name:'Nick, Mackenzie, Clara',unread:0,messages:[{...messages[0],text:p.context},{...messages[1],text:p.text}],last_seq:2};body={room:invited};
   } else return route.fulfill({status:404,json:{error:'Fixture endpoint unavailable'}});
   await route.fulfill({json:body});
  });
  await page.goto('http://127.0.0.1:3299/__fixture'+(restricted?'?restricted=1':''));
  await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),width===390?'dark':'light');
  const rail=page.getByRole('complementary',{name:'Chats'});
  await rail.getByRole('button',{name:/Mackenzie/}).waitFor();
  await rail.getByRole('button',{name:/Operations/}).waitFor();
  assert.equal(await rail.getByRole('button',{name:/Operations/}).count(),1);
  await page.locator('[aria-label="2 unread people conversations, 1 unread bot conversations"]:visible').first().waitFor();
  assert.equal(await page.getByRole('button',{name:'Messages',exact:true}).count(),0);
  await rail.getByRole('button',{name:/^People/}).click();
  assert.equal(await rail.getByRole('button',{name:/Mackenzie/}).count(),0);
  await page.reload();
  await rail.getByRole('button',{name:/^People/}).waitFor();
  assert.equal(await rail.getByRole('button',{name:/Mackenzie/}).count(),0);
  await rail.getByRole('button',{name:/^People/}).click();
  await rail.getByRole('button',{name:/Mackenzie/}).waitFor();
  await page.screenshot({path:output+`list-${width}-${restricted?'employee':'owner'}.png`});
  await rail.getByRole('button',{name:'New conversation'}).click();
  await page.getByRole('button',{name:'Add Mackenzie (person)',exact:true}).click();
  await page.getByRole('button',{name:'Open chat',exact:true}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('@Cla');
  await page.getByRole('button',{name:'@Clara · Start a group',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('textbox').nth(0).fill('Reviewed: software charge, no private history.');
  await page.getByRole('dialog').getByRole('textbox').nth(1).fill('@Clara what details do you need to categorize this?');
  await page.waitForTimeout(300);
  await page.screenshot({path:output+`invite-${width}-${restricted?'employee':'owner'}.png`});
  await page.getByRole('button',{name:'Create group and send request'}).click();
  await page.getByRole('button',{name:/Nick, Mackenzie, Clara.*members/}).waitFor();
  assert.equal(inviteCalls,1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Back to Chats',exact:true}).click();
  await rail.getByRole('button',{name:/^Group Mackenzie /}).waitFor();
  assert.deepEqual(errors,[]);
  if(restricted)assert.equal(huddleCalls,0);
  console.log('PASS',width,restricted?'employee':'owner');await page.close();
 }
}finally{await browser.close();await vite.close();}
