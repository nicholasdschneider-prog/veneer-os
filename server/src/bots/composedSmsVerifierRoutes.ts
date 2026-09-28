import express from 'express';
import {z} from 'zod';
import type {AppContext} from '../context.js';
import {createAutoshipVerifierResolver} from '../identity/autoshipVerifier.js';
import {readSecretValue} from '../secrets/readSecret.js';
import {boundedResolverGet} from './approvedCaseResolver.js';
import {composedSmsReader} from './composedSmsReader.js';
import {composedSmsService} from './composedSms.js';
import {composedSmsVerifier,type ComposeVerifierIO} from './composedSmsVerifier.js';
import {loadComposeServiceRegistry,bearerMatches,checkComposeRegistration,boundaryUnavailable,type ComposeRegistration} from './composedSmsTrust.js';
import {BotError} from './service.js';
import {canonicalSha256} from './canonical.js';
import {uuid} from './composedSmsContract.js';
export function composeVerifierIO(ctx:AppContext):ComposeVerifierIO{
 const native=composedSmsService(ctx.db,composedSmsReader(ctx));
 const registration=(id:string)=>{const rows=loadComposeServiceRegistry(ctx.config.composeServiceRegistryFile).registrations.filter(r=>r.registrationId===id);if(rows.length!==1)return boundaryUnavailable();return rows[0]!;};
 return {registration,now:Date.now,nativeCurrent:native.serviceCurrent,async readback(r,a){
  const before=checkComposeRegistration(ctx.db,registration(r.registrationId),Date.now());if(before!==canonicalSha256(r))throw new BotError(403,'Readback custody changed');
  const secret=(await readSecretValue({db:ctx.db,projectDopplerCli:ctx.projectDopplerCli??null},r.readbackCredential)).value;
  if(checkComposeRegistration(ctx.db,registration(r.registrationId),Date.now())!==before)throw new BotError(403,'Readback custody changed');
  const value=await boundedResolverGet(`${r.sourceOrigin}/api/cs/composed-sms/actions/${a.nativeActionId}`,secret,AbortSignal.timeout(10000));
  if(checkComposeRegistration(ctx.db,registration(r.registrationId),Date.now())!==before)throw new BotError(403,'Readback custody changed');return value;
 }};
}
export function composedSmsVerifierRoutes(ctx:AppContext,overrides?:{io:ComposeVerifierIO;cf:(req:express.Request,r:ComposeRegistration)=>Promise<boolean>}){
 const router=express.Router(),io=overrides?.io??composeVerifierIO(ctx),service=composedSmsVerifier(ctx.db,io);
 router.use(express.json({limit:'16kb'}));router.use((req,res,next)=>{res.set('Cache-Control','no-store');void(async()=>{
  const selector=uuid.parse(req.headers['x-compose-registration-id']),r=io.registration(selector);checkComposeRegistration(ctx.db,r,io.now());
  const c=ctx.config;
  if([c.cfAud,c.autoshipVerifierCfAud,c.returnVerifierCfAud,c.routineVerifierCfAud,c.purchaseTimingCfAud,c.autoshipCandidateCfAud].includes(r.nativeAudience)||[c.autoshipVerifierClientId,c.returnVerifierClientId,c.routineVerifierClientId,c.purchaseTimingClientId,c.autoshipCandidateClientId].includes(r.cfClientId))return boundaryUnavailable();
  const cf=overrides?.cf??(async(req:express.Request,r:ComposeRegistration)=>!!await createAutoshipVerifierResolver({...c,autoshipVerifierCfAud:r.nativeAudience,autoshipVerifierClientId:r.cfClientId},{log:{warn:()=>{}}})(req));
  if(!bearerMatches(req.headers.authorization,r)||!await cf(req,r))throw new BotError(401,'Dedicated composed SMS service identity required');
  res.locals.registrationId=selector;next();
 })().catch(next);});
 const run=(f:(req:express.Request,id:string)=>unknown)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{void Promise.resolve().then(()=>f(req,res.locals.registrationId)).then(v=>res.json(v)).catch(next);};
 router.get('/authorities/:id',run((req,id)=>{const q=z.object({revision:z.literal('1'),actionId:uuid}).strict().parse(req.query);return service.authority(id,uuid.parse(req.params.id),Number(q.revision),q.actionId);}));
 router.post('/dispatch-associations',run((req,id)=>{z.object({}).strict().parse(req.query);return service.associate(id,req.body);}));
 router.get('/dispatch-associations/:id',run((req,id)=>{z.object({}).strict().parse(req.query);return service.association(id,uuid.parse(req.params.id));}));
 router.get('/actions/:id/association',run((req,id)=>{z.object({}).strict().parse(req.query);return service.association(id,uuid.parse(req.params.id),true);}));
 router.use((_req,res)=>res.status(405).json({error:'Unsupported composed SMS verifier operation'}));
 router.use((e:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(e instanceof BotError?e.status:e instanceof z.ZodError?400:500).json({error:e instanceof BotError?e.message:e instanceof z.ZodError?'Invalid composed SMS service contract':'Composed SMS verification failed'});});
 return router;
}
