import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailFetchThreadConnectorDetails } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function threadState(item: ToolChatItem, details: GmailFetchThreadConnectorDetails): {
  title: string;
  description: string;
  status: GmailReceiptStatus;
} {
  if (item.running) return {
    title: 'Loading conversation',
    description: 'Gmail is loading this conversation.',
    status: { kind: 'working', label: 'Loading' },
  };
  if (!item.ok || details.successful === false) return {
    title: 'Conversation not loaded',
    description: details.error ?? 'Gmail could not load this conversation.',
    status: { kind: 'error', label: 'Failed' },
  };
  return {
    title: 'Loaded conversation',
    description: 'Gmail loaded the conversation context.',
    status: { kind: 'success', label: 'Loaded' },
  };
}

export function GmailFetchThreadConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GmailFetchThreadConnectorDetails;
  const state = threadState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.subject) fields.push({ label: 'Subject', value: details.subject });
  if (details.latestSender) fields.push({ label: 'Latest from', value: details.latestSender });
  if (details.messageCount !== undefined) fields.push({ label: 'Messages', value: details.messageCount.toLocaleString() });
  const latestAt = formatTimestamp(details.latestAt);
  if (latestAt) fields.push({ label: 'Updated', value: latestAt });

  return (
    <GmailConnectionReceipt
      title={state.title}
      description={state.description}
      status={state.status}
      fields={fields}
      gmailUrl={details.gmailUrl}
    />
  );
}
