import { decisionLabel, type BotDecision } from './bots';

type DecisionStatus = Pick<BotDecision, 'state' | 'answer'>;
export function decisionSection(d: DecisionStatus) {
  if (d.state === 'needs_input') return 'input';
  if (d.state === 'verified_completed') return 'history';
  if (d.state === 'blocked' || d.state === 'failed') return 'attention';
  if (d.state === 'decided') {
    if (d.answer?.action === 'reject' || d.answer?.action === 'withdraw') return 'history';
    if (d.answer?.action === 'defer') return 'deferred';
  }
  return 'execution';
}

export function decisionStatusLabel(d: DecisionStatus): string {
  if (d.state === 'verified_completed') return 'Scoped task complete';
  if (d.state === 'running') return 'Executing this task';
  if (d.state === 'action_pending') return 'Queued for execution';
  if (d.state === 'decided') {
    return ({ approve: 'Approved · Awaiting execution', reject: 'Rejected · No execution authorized',
      withdraw: 'Withdrawn · No execution authorized', defer: 'Deferred · Awaiting follow-up' } as Record<string, string>)[d.answer?.action ?? ''] ?? 'Decision recorded · Awaiting follow-up';
  }
  return decisionLabel(d.state);
}
