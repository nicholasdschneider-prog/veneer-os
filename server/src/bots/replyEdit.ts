import { BotError, type Proposal } from './service.js';

/** Explicit draft markers are a display/edit format, never imported send authority. */
export function withEditedReply(proposal: Proposal, body: string): Proposal {
  if (!body.trim() || body.length > 12000) throw new BotError(400, 'Reply must contain text and be at most 12,000 characters');
  const next=structuredClone(proposal);
  const matches=[...next.blocked_action.matchAll(/\bEXACT DRAFT:\s*/gi)];
  const marker=matches.length===1?matches[0]:undefined;
  const legacy=marker?next.blocked_action.slice(marker.index!+marker[0].length):null;
  if(next.message_delivery){
    const original=next.message_delivery.payload.body;
    next.message_delivery.payload.body=body;
    // Synchronize only an exact duplicate. Different legacy text stays explicitly separate.
    if(marker && legacy===original)next.blocked_action=next.blocked_action.slice(0,marker.index!+marker[0].length)+body;
  }else if(marker && legacy){
    next.blocked_action=next.blocked_action.slice(0,marker.index!+marker[0].length)+body;
  }else throw new BotError(409,'No unambiguous editable customer reply in this proposal');
  delete next.review_summary;
  return next;
}
