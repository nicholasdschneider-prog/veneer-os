import type { AgentMessageToolDetails } from './types';

export interface AgentMessageActivityItem {
  running: boolean;
  ok: boolean;
  agentMessageDetails?: AgentMessageToolDetails;
}

function targetName(item: AgentMessageActivityItem): string | null {
  return item.agentMessageDetails?.targetChat?.agentName?.trim() || null;
}

/** A label is returned only when Veneer has an authenticated local receipt or
 * the send is visibly in flight. Remote and legacy calls keep their existing
 * generic tool label rather than implying delivery. */
export function agentMessageActivityLabel(item: AgentMessageActivityItem): string | null {
  const name = targetName(item);
  if (!name) return null;
  if (item.running) return `Messaging ${name}…`;
  if (!item.ok) return `Message to ${name} failed`;
  switch (item.agentMessageDetails?.disposition) {
    case 'queued':
      return `Queued for ${name}`;
    case 'duplicate':
      return `Already messaged ${name}`;
    case 'running':
    case 'steered':
    case 'delivered':
      return `Messaged ${name}`;
    default:
      return null;
  }
}

export function agentMessageGroupLabel(items: AgentMessageActivityItem[]): string | null {
  const visible = items.filter((item) => agentMessageActivityLabel(item));
  if (!visible.length) return null;
  const targets = new Set(visible.flatMap((item) => {
    const name = targetName(item);
    return name ? [name] : [];
  }));
  const allDelivered = visible.every((item) =>
    !item.running
    && item.ok
    && (item.agentMessageDetails?.disposition === 'running'
      || item.agentMessageDetails?.disposition === 'steered'
      || item.agentMessageDetails?.disposition === 'delivered'
      || item.agentMessageDetails?.disposition === 'duplicate'),
  );
  if (targets.size > 1 && allDelivered) return `Messaged ${targets.size} agents`;
  return agentMessageActivityLabel(visible.at(-1)!);
}

export function agentMessageTargetHash(details: AgentMessageToolDetails): string | null {
  const target = details.targetChat;
  if (!target) return null;
  const params = new URLSearchParams();
  const exact = details.disposition !== 'queued'
    && typeof details.messageId === 'number'
    && Number.isSafeInteger(details.messageId)
    && details.messageId > 0;
  if (exact) params.set('message', String(details.messageId));
  const query = params.toString();
  return `#/chat/${encodeURIComponent(target.id)}${query ? `?${query}` : ''}`;
}

export function agentMessageFocusKey(value: string | null | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? `u-message-${id}` : null;
}
