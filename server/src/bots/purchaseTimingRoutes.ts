import express from 'express';
import {z} from 'zod';
import type {AppContext} from '../context.js';
import {purchaseTimingResolver,type TimingIdentity} from '../identity/purchaseTimingVerifier.js';
import {purchaseTimingService,TimingError} from './purchaseTiming.js';
import {BotError} from './service.js';
import {timingKey,timingCaptureResponseSchema,timingVerifyResponseSchema,timingClaimResponseSchema,timingExecutionResponseSchema} from './purchaseTimingSchema.js';
function run(fn:(req:express.Request,res:express.Response)=>unknown):express.RequestHandler {
 return (req,res,next)=>{try{res.json(fn(req,res));}catch(e){
  if(e instanceof TimingError)res.status(e.status).json({schema_version:'veneer-purchase-timing-error/v1',code:e.code,error:e.message,execute:false});
  else if(e instanceof BotError)res.status(e.status).json({schema_version:'veneer-purchase-timing-error/v1',code:'NATIVE_ACCESS_OR_STATE',error:e.message,execute:false});
  else if(e instanceof z.ZodError)res.status(400).json({schema_version:'veneer-purchase-timing-error/v1',code:'INVALID_FIELDS',error:'Invalid purchase-timing contract fields',execute:false});
  else next(e);
 }};
}
export function purchaseTimingVerifierRoutes(ctx:AppContext,override?:(req:express.Request)=>Promise<TimingIdentity|null>){
 const r=express.Router(),s=purchaseTimingService(ctx.db,ctx.config),resolve=override??purchaseTimingResolver(ctx.config);
 r.use(express.json({limit:'256kb'}));
 r.use((req,res,next)=>{res.set('Cache-Control','no-store');void resolve(req).then(identity=>{if(!identity){res.status(401).json({schema_version:'veneer-purchase-timing-error/v1',code:'IDENTITY_REJECTED',error:'Dedicated purchase-timing service identity required',execute:false});return;}res.locals.timingIdentity=identity;next();}).catch(()=>res.status(401).json({schema_version:'veneer-purchase-timing-error/v1',code:'IDENTITY_REJECTED',error:'Service identity rejected',execute:false}));});
 r.post('/captures',run((req,res)=>timingCaptureResponseSchema.parse(s.capture(res.locals.timingIdentity,req.body))));
 r.get('/trusts/:trust/captures/:key',run((req,res)=>timingCaptureResponseSchema.parse(s.captureStatus(res.locals.timingIdentity,timingKey.parse(req.params.trust),timingKey.parse(req.params.key)))));
 r.post('/verify',run((req,res)=>timingVerifyResponseSchema.parse(s.verify(res.locals.timingIdentity,req.body))));
 r.post('/claims',run((req,res)=>timingClaimResponseSchema.parse(s.claim(res.locals.timingIdentity,req.body))));
 r.get('/trusts/:trust/claims/:key',run((req,res)=>timingClaimResponseSchema.parse(s.reconcile(res.locals.timingIdentity,timingKey.parse(req.params.trust),timingKey.parse(req.params.key)))));
 r.post('/execution-checks',run((req,res)=>timingExecutionResponseSchema.parse(s.executionCheck(res.locals.timingIdentity,req.body))));
 r.use((_req,res)=>res.status(405).json({schema_version:'veneer-purchase-timing-error/v1',code:'METHOD_NOT_ALLOWED',error:'Unsupported timing verifier operation',execute:false}));
 r.use(((error, _req, res, _next)=>{
  const status=typeof error?.status==='number' && [400,413].includes(error.status)?error.status:500;
  res.status(status).json({schema_version:'veneer-purchase-timing-error/v1',code:status===500?'INTERNAL_UNKNOWN':'INVALID_FIELDS',error:status===500?'Result uncertain; reconcile the same intent read-only':'Invalid JSON request',execute:false});
 }) as express.ErrorRequestHandler);
 return r;
}
/** Mounted only after the existing authenticated human API middleware. */
export function purchaseTimingSetupRoutes(ctx:AppContext){
 const r=express.Router(),s=purchaseTimingService(ctx.db,ctx.config);
 const actor=(req:express.Request)=>({user:req.user!,conversationId:req.agentExecutionConversationId??req.agentConversationId});
 r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 r.get('/',run(req=>s.setupOptions(actor(req))));
 r.post('/review',run(req=>s.setupReview(actor(req),req.body)));
 r.post('/confirm',run(req=>s.enroll(actor(req),req.body)));
 r.get('/registrations/:key',run(req=>s.setupStatus(actor(req),req.params.key!)));
 r.post('/trusts/:id/revoke',run(req=>{const p=z.object({reason:z.string().min(1).max(1000)}).strict().parse(req.body);return s.revoke(actor(req),req.params.id!,p.reason);}));
 return r;
}
