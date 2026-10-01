import { decisionLabel, type BotDecision, type BotProposal } from './bots';

/** Separate only an explicit draft label. Never summarize or reinterpret approval conditions. */
export function decisionCopy(proposal: BotProposal) {
  const markers = [...proposal.blocked_action.matchAll(/\bEXACT DRAFT:\s*/gi)];
  const marker = markers.length === 1 ? markers[0] : undefined;
  const draft = marker ? proposal.blocked_action.slice(marker.index! + marker[0].length) : '';
  return {
    proposedAction: proposal.recommendation,
    limits: proposal.consequence,
    draft: draft || null,
    instructions: draft && marker ? proposal.blocked_action.slice(0, marker.index).trim() : proposal.blocked_action,
  };
}

type DecisionStatus = Pick<BotDecision, 'state' | 'answer'> & { stale?: { resolved?: boolean } | null };
export function decisionSection(d: DecisionStatus) {
  // Settled somewhere else: out of the answer queue at once, kept in history.
  if (d.state === 'needs_input') return d.stale?.resolved ? 'history' : 'input';
  if (d.state === 'verified_completed') return 'history';
  if (d.state === 'blocked' || d.state === 'failed') return 'attention';
  if (d.state === 'decided') {
    if (d.answer?.action === 'reject' || d.answer?.action === 'withdraw') return 'history';
    if (d.answer?.action === 'defer') return 'deferred';
  }
  return 'execution';
}

export function decisionStatusLabel(d: DecisionStatus & { stale?: { detail: string; resolved?: boolean } | null }): string {
  if (d.state === 'needs_input' && d.stale) return d.stale.resolved ? 'Settled elsewhere · No answer needed' : 'Stale · Bot is refreshing this question';
  if (d.state === 'decided' && d.answer?.action === 'withdraw') return 'Withdrawn · No execution authorized';
  if (d.answer?.automatic) return d.state === 'verified_completed' ? 'Automatic · Done under your standing rule' : 'Automatic · Approved under your standing rule';
  if (d.state === 'verified_completed') return 'Scoped task complete';
  if (d.state === 'running') return 'Executing this task';
  if (d.state === 'action_pending') return 'Queued for execution';
  if (d.state === 'decided') {
    return ({ approve: 'Approved · Awaiting execution', reject: 'Rejected · No execution authorized',
      withdraw: 'Withdrawn · No execution authorized', defer: 'Deferred · Awaiting follow-up', custom: 'Answered in your words · Bot follows up' } as Record<string, string>)[d.answer?.action ?? ''] ?? 'Decision recorded · Awaiting follow-up';
  }
  return decisionLabel(d.state);
}

/** SQLite timestamps are UTC; display in the viewer's local time, with seconds. */
export function discussionTimestamp(value: string): string {
  const normalized = value.replace(' ', 'T');
  const date = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : normalized + 'Z');
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date);
}

/** How long ago the case moved on, for the stale banner. */
export function staleSummary(stale: { reason: string; since: string; detail: string }, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(stale.since)) / 60000));
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
  const what = stale.reason === 'customer_replied' ? 'customer replied' : stale.reason === 'ticket_created' ? 'new ticket on this case' : stale.reason === 'status_changed' ? 'case status changed' : stale.reason === 'evidence_changed' ? 'evidence changed'
    : stale.reason === 'order_fulfilled' ? 'order shipped' : stale.reason === 'order_cancelled' ? 'order cancelled' : stale.reason === 'order_closed' ? 'order closed' : 'case closed';
  return `${stale.reason.startsWith('order_') || stale.reason === 'ticket_closed' ? 'Settled elsewhere' : 'Stale'}: ${what} ${ago}`;
}

/** Presentation only. Never interpret spend, authorization or a proposed refund as history. */
export function decisionTitle(proposal: BotProposal): string {
  return proposal.review_summary?.action_title || (proposal.message_delivery || decisionCopy(proposal).draft
    ? 'Review the proposed customer reply' : 'Review the recommended action');
}
