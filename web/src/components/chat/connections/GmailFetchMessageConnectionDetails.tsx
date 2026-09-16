import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailFetchMessageConnectorDetails } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function messageState(item: ToolChatItem, details: GmailFetchMessageConnectorDetails): {
  title: string;
  description: string;
  status: GmailReceiptStatus;
} {
  if (item.running) return {
    title: 'Loading message',
    description: 'Gmail is loading this message.',
    status: { kind: 'working', label: 'Loading' },
  };
  if (!item.ok || details.successful === false) return {
    title: 'Message not loaded',
    description: details.error ?? 'Gmail could not load this message.',
    status: { kind: 'error', label: 'Failed' },
  };
  return {
    title: 'Loaded message',
    description: 'Gmail loaded the message context.',
    status: { kind: 'success', label: 'Loaded' },
  };
}

export function GmailFetchMessageConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GmailFetchMessageConnectorDetails;
  const state = messageState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.subject) fields.push({ label: 'Subject', value: details.subject });
  if (details.sender) fields.push({ label: 'From', value: details.sender });
  const receivedAt = formatTimestamp(details.receivedAt);
  if (receivedAt) fields.push({ label: 'Received', value: receivedAt });
  if (details.preview) fields.push({ label: 'Preview', value: details.preview, multiline: true });

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
