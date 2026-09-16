import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailReplyConnectorDetails } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function replyState(item: ToolChatItem, details: GmailReplyConnectorDetails): {
  title: string;
  description: string;
  status: GmailReceiptStatus;
} {
  if (item.running) return {
    title: 'Sending reply',
    description: 'Gmail is sending this reply.',
    status: { kind: 'working', label: 'Sending' },
  };
  if (!item.ok || details.successful === false) return {
    title: 'Reply not sent',
    description: details.error ?? 'Gmail could not send this reply.',
    status: { kind: 'error', label: 'Failed' },
  };
  return {
    title: 'Sent reply',
    description: 'Gmail accepted and sent this reply.',
    status: { kind: 'success', label: 'Sent' },
  };
}

export function GmailReplyConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GmailReplyConnectorDetails;
  const state = replyState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.recipients?.length) fields.push({ label: 'To', value: details.recipients.join(', ') });
  if (details.subject) fields.push({ label: 'Subject', value: details.subject });
  if (details.body) fields.push({ label: 'Reply', value: details.body, multiline: true });

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
