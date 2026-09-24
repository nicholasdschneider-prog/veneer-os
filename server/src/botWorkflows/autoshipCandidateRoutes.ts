import express from 'express';
import {z} from 'zod';
import type {AppContext} from '../context.js';
import type {Config} from '../config.js';
import {createAutoshipVerifierResolver} from '../identity/autoshipVerifier.js';
import {BotError} from '../bots/service.js';
import {autoshipCandidates,type CandidateIdentity} from './autoshipCandidates.js';
export function configuredCandidateIdentity(c:Config):CandidateIdentity|null{
 const audience=c.autoshipCandidateCfAud,clientId=c.autoshipCandidateClientId;
 if(!audience||!clientId||[c.cfAud,c.autoshipVerifierCfAud,c.returnVerifierCfAud,c.routineVerifierCfAud].includes(audience)||[c.autoshipVerifierClientId,c.returnVerifierClientId,c.routineVerifierClientId].includes(clientId))return null;
 return {audience,clientId};
}
export function autoshipCandidateRoutes(ctx:AppContext,override?:(req:express.Request)=>Promise<CandidateIdentity|null>){
 const r=express.Router(),identity=configuredCandidateIdentity(ctx.config),s=autoshipCandidates(ctx.db);
 const resolve=createAutoshipVerifierResolver({...ctx.config,autoshipVerifierCfAud:identity?.audience ?? null,autoshipVerifierClientId:identity?.clientId ?? null},{log:{warn:()=>{}}});
 r.use((req,res,next)=>{res.set('Cache-Control','no-store');void(override?override(req):resolve(req).then(id=>id?identity:null)).then(id=>{if(!id){res.status(401).json({error:'Dedicated candidate identity required'});return;}res.locals.identity=id;next();}).catch(()=>res.status(401).json({error:'Candidate identity rejected'}));});
 r.use(express.json({limit:'16kb'}));
 const run=(fn:(req:express.Request,id:CandidateIdentity)=>unknown)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{try{res.json(fn(req,res.locals.identity));}catch(e){if(e instanceof BotError)res.status(e.status).json({error:e.message});else if(e instanceof z.ZodError)res.status(400).json({error:'Invalid candidate contract'});else next(e);}};
 r.post('/events',run((req,id)=>s.accept(id,req.body)));
 r.get('/sources/:source/events/:event',run((req,id)=>s.reconcile(id,req.params.source!,req.params.event!)));
 r.use((_req,res)=>res.status(405).json({error:'Unsupported candidate operation'}));return r;
}
