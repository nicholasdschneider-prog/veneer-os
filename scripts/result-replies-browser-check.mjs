// Isolated full-chat regression: synthetic API/WebSocket data only.
// node --import tsx scripts/result-replies-browser-check.mjs /path/to/playwright-core/index.mjs
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
const {chromium} = await import(pathToFileURL(process.argv[2]).href);
const vite = await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3299,strictPort:true}});
await vite.listen();
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  for (const width of [390,1440]) {
    const page = await browser.newPage({viewport:{width,height:1000}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    const restricted=false,bots=[],sessions=[];
    let org={revision:0,groups:[],placements:{},fallback:'Unassigned'},fail=false,heldEarlier;
    const anchor = JSON.stringify({turn:'original',at:'2026-09-25T20:00:00Z'});
    const replies = ['First correction','Second correction','Final detail'].map((text,i)=>({
      id:`reply-${i}`,seq:i+1,thread_id:'thread',anchor,source_text:'Original fixture result',text,
      actor_name:'Alex',actor_conversation_id:null,bot_name:'Goldberg',created_at:`2026-09-25 20:00:0${i+1}`,unread:0,
    }));
      await page.route("**/api/**", async (route) => {
        const req = route.request(),
          p = new URL(req.url()).pathname;
        let body = {};
        if (p === "/api/me")
          body = {
            setupRequired: false,
            pending: false,
            user: {
              id: 1,
              email: "fixture@example.test",
              displayName: "Alex",
              role: restricted ? "member" : "owner",
              employeeWorkspace: restricted,
            },
          };
        else if (p === "/api/bots")
          body = {
            bots,
            teams: [{ id: "team", name: "Fixture Business" }],
            decisions: [],
          };
        else if (p === "/api/bots/organization") {
          if (req.method() === "POST") {
            if (fail) {
              fail = false;
              return route.fulfill({
                status: 409,
                json: { error: "Organization changed. Reload and try again." },
              });
            }
            const b = req.postDataJSON();
            assert.equal(b.expected_revision, org.revision);
            org = { ...b.definition, revision: org.revision + 1 };
          }
          body = org;
        } else if (p === "/api/navigation")
          body = { configured: false, navigation: { items: [] } };
        else if (p === "/api/page-brand") body = { brand: {} };
        else if (p === "/api/huddles") body = { huddles: [] };
        else if (p === "/api/team-rooms") body = { rooms: [] };
        else if (p === "/api/team-rooms/directory")
          body = { self_key: "user:1", teams: [] };
        else if (p === "/api/projects") body = { projects: [] };
        else if (
          p === "/api/conversations" ||
          p === "/api/recent-conversations"
        )
          body = { conversations: [] };
        else if (/^\/api\/conversations\/bot\d+$/.test(p)) {
          const id = p.split("/").at(-1);
          body = {
            conversation: {
              id,
              title: "Goldberg",
              isBot: true,
              visibility: "team",
              canSend: true,
              canManage: true,
              canChangeVisibility: true,
              creator: { id: 1, displayName: "Alex" },
              model: null,
              effort: null,
              approvalMode: null,
              effectiveApprovalMode: "default",
              fullAccess: false,
              channel: "web",
              assistantSlug: "assistant",
              assistantName: "Assistant",
              projectId: null,
              originConversationId: null,
              archived: false,
              pinOrder: null,
              contextTokens: null,
              status: "idle",
              activity: null,
              unread: false,
              hasPendingWakeup: false,
              automation: null,
              provider: "claude",
              assistantId: 1,
              workspaceDir: "/fixture",
              businessTeamId: "team",
              botName: "Goldberg",
              createdAt: "2026-09-23",
              updatedAt: "2026-09-23",
            },
          };
        } else if (p === "/api/assistants")
          body = {
            assistants: [{ id: 1, name: "Assistant", slug: "assistant" }],
          };
        else if (p === "/api/models") body = { models: [] };
        else if (p.endsWith("/replies")) body = {replies,hasMore:false};
        else if (p.includes("/threads")) body = { threads: [] };
        else if (p === '/api/live-voice/sessions') {
          const url = new URL(req.url());
          if(url.searchParams.get('bot')==='bot1') body={sessions:[]};
          else if(url.searchParams.has('before_ms')) { heldEarlier=route; return; }
          else body={sessions:sessions.slice(0,50)};
        }
        else if (p.startsWith('/api/live-voice/sessions/')) body={entries:[{id:1,role:'user',text:'Fixture narration, private to this caller.',createdAt:'2026-09-23T09:17:23Z'}],next:null};
        else if (p.includes("/bot-communication/chats/"))
          body = { drafts: [], briefings: [] };
        else if (p.includes("/connectors")) body = { connectors: [] };
        else if (p.includes("/model-prefs")) body = { prefs: {} };
        else
          return route.fulfill({
            status: 404,
            json: { error: "Not present in fixture" },
          });
        await route.fulfill({ json: body });
      });

    const events = [
      {type:'turn_started',turnId:'original',role:'user',text:'Original request',at:'2026-09-25T19:59:00Z',via:'web'},
      {type:'text_final',turnId:'original',markdown:'Original fixture result',at:'2026-09-25T20:00:00Z'},
      {type:'turn_done',turnId:'original'},
      {type:'turn_started',turnId:'current',role:'user',text:'Continue the work',at:'2026-09-25T20:00:00Z',via:'web'},
    ];
    const deliveries = replies.map((r,i)=>({id:i+1,text:r.text+'\n\n[Reply context] Internal delivery instructions',createdAt:r.created_at,origin:{kind:'result_reply',from:'Alex',to:'Goldberg'}}));
    const legacy={id:4,text:'Hey, can you pick this back up for me?\n\nA human replied in message thread 20958f1b-7c52-4d91-98de-9fc9b5ae38ff. Use read_message_thread to read the original result and replies',createdAt:'2026-09-25 20:00:04',origin:{kind:'wakeup',from:'Bot',to:'Bot'}};
    let socket;
    const snapshot = (messages,extra=[],status='working') => socket.send(JSON.stringify({kind:'snapshot',conversationId:'bot0',status,queue:{revision:Date.now(),messages,failedTurn:null},wakeups:[],events:[...events,...extra]}));
    await page.routeWebSocket('**/ws',ws=>{socket=ws;ws.onMessage(raw=>{if(JSON.parse(String(raw)).kind==='subscribe')snapshot([...deliveries,legacy]);});});
    await page.goto('http://127.0.0.1:3299/#/chat/bot0');
    await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
    for (const reply of replies) await page.getByText(reply.text,{exact:true}).waitFor();
    async function verify() {
      for (const reply of replies) assert.equal(await page.getByText(reply.text,{exact:true}).count(),1);
      const text=await page.locator('body').innerText();
      assert(!text.includes('Hey, can you pick this back up'));
      assert(!text.includes('Internal delivery instructions'));
      assert(!text.includes('read_message_thread'));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    await verify();
    snapshot(deliveries.map(row=>({...row,delivered:true})));
    await page.waitForTimeout(150); await verify();
    snapshot([], deliveries.map((row,i)=>({type:'turn_started',turnId:`steer-${i}`,role:'user',text:row.text,origin:row.origin,at:`2026-09-25T20:00:0${i+1}Z`,via:'web'})));
    await page.waitForTimeout(150); await verify();
    // Exercise the actual composer while its status is stale and both HTTP
    // requests are still pending. Normal rapid sends must never offer Send now.
    snapshot([],[],'idle');
    await page.waitForTimeout(100);
    const requests=[];
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/conversations/bot0/messages',async route=>{
      requests.push(route.request().postDataJSON().text);
      await gate;
      await route.fulfill({json:{status:'working',messageId:100+requests.length,disposition:'delivered',queue:{revision:Date.now(),messages:requests.map((text,i)=>({id:100+i,text,createdAt:new Date().toISOString(),delivered:true})),failedTurn:null}}});
    });
    const composer=page.getByRole('textbox',{name:'Message',exact:true});
    for(const text of ['Rapid ordinary one','Rapid ordinary two']) {
      await composer.fill(text);
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.getByText(text,{exact:true}).waitFor();
    }
    await page.waitForTimeout(100);
    assert.deepEqual(requests,['Rapid ordinary one','Rapid ordinary two']);
    assert.equal(await page.getByRole('button',{name:'Send now',exact:true}).count(),0);
    assert(!(await page.locator('body').innerText()).includes('Queued'));
    // The durable WebSocket receipts arrive while the POSTs still wait for
    // provider startup. Each send must still have exactly one visible bubble.
    snapshot(requests.map((text,i)=>({id:100+i,text,createdAt:new Date().toISOString(),delivered:true})),[],'working');
    await page.waitForTimeout(100);
    for(const text of requests) assert.equal(await page.getByText(text,{exact:true}).count(),1);
    release(); await page.waitForTimeout(150);
    for(const text of requests) assert.equal(await page.getByText(text,{exact:true}).count(),1);
    assert.deepEqual(errors,[]); await page.close();
  }
  console.log('Result reply browser checks passed: desktop/mobile, queued, steering, consumed history, one visible reply, no internal notification bubbles.');
} finally {await browser.close();await vite.close();}
