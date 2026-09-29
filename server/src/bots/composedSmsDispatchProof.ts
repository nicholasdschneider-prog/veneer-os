import {verifyAuthority,bindingHash,type ComposeAuthority} from './composedSmsContract.js';
import {verifyCorrectionDispatch,correctionBindingHash,type CorrectionDispatchAuthority} from './composedSmsCorrectionContract.js';
export type DispatchAuthority=ComposeAuthority|CorrectionDispatchAuthority;
export const isCorrection=(a:DispatchAuthority):a is CorrectionDispatchAuthority=>'proofKind' in a;
export const verifyDispatch=(raw:unknown):DispatchAuthority=>raw&&typeof raw==='object'&&'proofKind' in raw?verifyCorrectionDispatch(raw):verifyAuthority(raw);
export const dispatchBindingHash=(r:Parameters<typeof bindingHash>[0],a:DispatchAuthority)=>isCorrection(a)?correctionBindingHash(r,a):bindingHash(r,a);
