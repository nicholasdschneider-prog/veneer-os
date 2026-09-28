import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type {Config} from '../config.js';
export type TimingIdentity={kind:'purchase_timing_verifier';clientId:string;audience:string};
export function timingConfiguration(config:Config) {
 const audience=config.purchaseTimingCfAud,clientId=config.purchaseTimingClientId;
 const otherAud=[config.cfAud,config.returnVerifierCfAud,config.routineVerifierCfAud,config.autoshipVerifierCfAud,config.autoshipCandidateCfAud];
 const otherClient=[config.returnVerifierClientId,config.routineVerifierClientId,config.autoshipVerifierClientId,config.autoshipCandidateClientId];
 return config.identity==='cloudflare' && config.cfTeamDomain && audience && clientId && !otherAud.includes(audience) && !otherClient.includes(clientId) ? {audience,clientId} : null;
}
export function purchaseTimingResolver(config:Config,verifyOverride?:(token:string,audience:string)=>Promise<JWTPayload>) {
 const identity=timingConfiguration(config);
 if(!identity)return async(_req:IncomingMessage):Promise<TimingIdentity|null>=>null;
 let team=config.cfTeamDomain!.trim().replace(/\/+$/,'');
 if(!/^https?:\/\//i.test(team))team=`https://${team.includes('.')?team:team+'.cloudflareaccess.com'}`;
 const jwks=createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
 const verify=verifyOverride??(async(token:string,audience:string)=>(await jwtVerify(token,jwks,{issuer:team,audience,algorithms:['RS256']})).payload);
 return async(req:IncomingMessage):Promise<TimingIdentity|null>=>{
  const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||!token.trim())return null;
  try{const p=await verify(token,identity.audience);if(p.email!==undefined || p.common_name!==identity.clientId)return null;return {kind:'purchase_timing_verifier',...identity};}catch{return null;}
 };
}
