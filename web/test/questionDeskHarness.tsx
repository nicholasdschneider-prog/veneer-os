/** Isolated browser fixture. Every request is intercepted; no live customer data or effects. */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QuestionDesk, useQuestionDesk } from '../src/components/QuestionDesk';
import { VoiceProvider } from '../src/components/VoiceProvider';
import { MessageAudioProvider } from '../src/components/MessageAudioPlayer';
import '../src/styles.css';

const make=(id:string,bot:string,question:string)=>({id,conversation_id:bot,version:1,state:'needs_input',can_answer:true,can_handle:false,bot_name:bot,assignee_name:'Test owner',created_at:'2026-10-01 10:00:00',updated_at:'2026-10-01 10:00:00',answer:null,dismissed:false,proposal:{question,recommendation:'Use the reviewed internal draft.',consequence:'Internal fixture only.',blocked_action:'Internal review',blocks_scope:'task',assignee_id:1,team:'',deadline:null,evidence:[],choices:[{id:'yes',label:'Use the draft',description:'Record this internal review answer.',action:'approve',recommended:true},{id:'no',label:'Keep waiting',action:'defer'}],review_summary:{action_title:question,request:question,background:['This is an isolated browser test.']},evidence_items:[{kind:'image',label:'Internal QA sheet',retained:{path:'fixture.svg'},source:{system:'fixture'}},{kind:'message',label:'Original request',text:'Please use the draft when it is ready.',source:{system:'fixture'}},{kind:'record',label:'Review status',text:'Draft ready',source:{system:'fixture'}}]}});
let decisions=[make('a1','Atlas','Can I use the first draft?'),make('b1','Robin','Can I proceed with the second draft?'),make('a2','Atlas','Which draft should I keep?')];
let selectedId:string|null=null,revision=0;let sleeping:any[]=[];let fail=false;const messages:Record<string,any[]>={};
const snapshot=()=>({decisions:decisions.filter(d=>d.state==='needs_input'&&!sleeping.some(s=>s.id===d.id)),sleeping,selectedId:decisions.some(d=>d.id===selectedId&&d.state==='needs_input')?selectedId:null,revision});
const requests:any[]=[];
(window as any).fixture={requests,fail:(value:boolean)=>{fail=value;},answerElsewhere:()=>{const d=decisions.find(d=>d.id===selectedId);if(d)d.state='decided';window.dispatchEvent(new Event('chat-decisions-changed'));},revise:()=>{const d=decisions.find(d=>d.id===selectedId);if(d){d.version++;d.proposal.question='Revised question';d.proposal.review_summary.action_title='Revised question';d.proposal.review_summary.request='Revised question';}}};
window.fetch=async(input,init)=>{
 const path=String(input);requests.push({path,method:init?.method??'GET'});const body=init?.body?JSON.parse(String(init.body)):{};
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(fail && path.startsWith('/api/question-line'))return json({error:'Fixture offline'},503);
 if(path==='/api/me')return json({ok:true,user:{id:1,displayName:'Test owner',role:'owner'}});
 if(path==='/api/question-line'){
  if(init?.method==='POST') {if(body.revision!==revision)return json({error:'Changed'},409);revision++;if(body.action==='select')selectedId=body.decisionId;else{if(body.action==='remind')sleeping.push({...decisions.find(d=>d.id===selectedId),until:body.until});else if(body.action==='back'){const index=decisions.findIndex(d=>d.id===selectedId);decisions.push(...decisions.splice(index,1));}selectedId=null;}}
  return json(snapshot());
 }
 const match=path.match(/^\/api\/bots\/decisions\/([^/?]+)(?:\/(.*))?$/);
 if(match){const d=decisions.find(d=>d.id===match[1]);if(!d)return json({error:'Not found'},404);if(!match[2])return json({decision:d,messages:messages[d.id]??[],events:[]});if(match[2]==='choice'){if(body.expected_version!==d.version)return json({error:'Proposal changed'},409);d.state='decided';return json({decision:d});}if(match[2]==='thread'){(messages[d.id]??=[]).push({id:crypto.randomUUID(),actor_name:'Test owner',actor_conversation_id:null,text:body.text,created_at:'2026-10-01 14:00:00'});return json({decision:d});}if(match[2]==='handoffs')return json({handoffs:[]});return json({targets:[]});}
 if(path.startsWith('/api/bots?'))return json({bots:[],decisions,teams:[]});
 if(path.startsWith('/api/live-voice'))return json({configuration:{ready:false,missing:['Fixture audio disabled'],invalidUrl:false},bot:path.includes('bot=')?{name:'Atlas',canMessage:true}:null,history:[],decisions:[],blockers:[],chats:[],call:null});
 if(path.includes('/side-chats'))return json({sideChats:[]});
 if(path.includes('/bot-communication'))return json({drafts:[],briefings:[],threads:[]});
 if(path.includes('/bot-workflows/bots/'))return json({notifications:false,routines:[]});
 if(path.includes('/models'))return json({models:[],providers:[]});
 if(path.startsWith('/api/conversations/'))return json({conversation:{id:'Atlas',assistantName:'Atlas',provider:'codex',model:null,thinking:null,approvalMode:'default'},events:[]});
 if(path.includes('organization'))return json({groups:[],memberships:[]});
 if(path.includes('team-rooms'))return json({rooms:[]});
 if(path.includes('huddles'))return json({huddles:[]});
 return json({bots:[],decisions:[],teams:[],groups:[],models:[],targets:[]});
};
function Work(){const [page,setPage]=useState('Project workspace');const desk=useQuestionDesk();return <main data-testid="work" className="h-full overflow-auto bg-background p-6 text-foreground"><h1 className="text-2xl">{page}</h1><p className="py-4">An isolated workspace for realistic question-desk checks.</p><button type="button" className="rounded border p-3" onClick={()=>{setPage('Order investigation');window.location.hash='/fixture-orders';}}>Investigate an order</button><button type="button" className="m-2 rounded border p-3" onClick={()=>desk.adoptSide({parentId:'Atlas',agentName:'Atlas',sideParam:'new'})}>Open side chat</button><label className="block py-4">Workspace notes<textarea aria-label="Workspace notes" className="block rounded border bg-background p-3" /></label><div className="h-[1600px]">Scroll stays in this workspace.</div></main>;}
createRoot(document.getElementById('root')!).render(<VoiceProvider><MessageAudioProvider><QuestionDesk><Work/></QuestionDesk></MessageAudioProvider></VoiceProvider>);
