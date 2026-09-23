import express from 'express';
import type {AppContext} from '../context.js';
import {z} from 'zod';
import {createAutoshipVerifierResolver} from '../identity/autoshipVerifier.js';
import {returnExceptionService,type ReturnServiceIdentity} from './returnException.js';
import {BotError} from './service.js';
// Dedicated identity, configuration and path; never reuse AutoShip's audience/client.
export function returnExceptionRoutes(ctx:AppContext,resolveOverride?:(req:express.Request)=>Promise<ReturnServiceIdentity|null>){
 const r=express.Router(),s=returnExceptionService(ctx.db);
 const config=ctx.config;
 const dedicated=Boolean(config.returnVerifierCfAud&&config.returnVerifierClientId&&config.returnVerifierCfAud!==config.cfAud&&config.returnVerifierCfAud!==config.autoshipVerifierCfAud&&config.returnVerifierClientId!==config.autoshipVerifierClientId);
 const resolver=createAutoshipVerifierResolver({...config,autoshipVerifierCfAud:dedicated?(config.returnVerifierCfAud??null):null,autoshipVerifierClientId:dedicated?(config.returnVerifierClientId??null):null},{log:{warn:()=>{}}});
 r.use(express.json({limit:'512kb'}));
 r.use((req,res,next)=>{res.set('Cache-Control','no-store');void (resolveOverride?resolveOverride(req):resolver(req).then(id=>id?{clientId:id.clientId,audience:config.returnVerifierCfAud!}:null)).then(identity=>{if(!identity){res.status(401).json({error:'Dedicated return verifier identity required'});return;}res.locals.returnIdentity=identity;next();}).catch(()=>res.status(401).json({error:'Verifier identity rejected'}));});
 const run=(fn:(req:express.Request,identity:ReturnServiceIdentity)=>unknown)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{try{res.json(fn(req,res.locals.returnIdentity));}catch(e){if(e instanceof BotError)res.status(e.status).json({error:e.message});else if(e instanceof z.ZodError)res.status(400).json({error:'Invalid return contract fields'});else next(e);}};
 r.post('/mappings',run((req,id)=>s.map(id,req.body)));
 r.post('/claims',run((req,id)=>s.claim(id,req.body)));
 r.get('/claims/:key',run((req,id)=>s.reconcile(id,req.params.key!)));
 r.post('/acknowledgments',run((req,id)=>s.acknowledge(id,req.body)));
 r.use((_req,res)=>res.status(405).json({error:'Unsupported return verifier operation'}));
 return r;
}
