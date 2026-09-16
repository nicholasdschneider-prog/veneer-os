import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailForwardConnectorDetails } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function gmailState(item: ToolChatItem, details: GmailForwardConnectorDetails): {
  title: string;
  status: GmailReceiptStatus;
  description: string;
} {
  if (item.running) {
    return {
      title: 'Forwarding message',
      status: { kind: 'working', label: 'Sending' },
      description: 'Gmail is sending this forward.',
    };
  }
  if (!item.ok || details.successful === false) {
    return {
      title: 'Message not forwarded',
      status: { kind: 'error', label: 'Failed' },
      description: details.error ?? 'Gmail did not complete this forward.',
    };
  }
  return {
    title: 'Forwarded message',
    status: { kind: 'success', label: 'Sent' },
    description: 'Gmail accepted and sent the forwarded message.',
  };
}

export function GmailConnectionDetails({ item, className }: { item: ToolChatItem; className?: string }) {
  const details = item.connectorDetails as GmailForwardConnectorDetails;
  const state = gmailState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.recipients?.length) fields.push({ label: 'To', value: details.recipients.join(', ') });
  if (details.sourceSubject) fields.push({ label: 'Subject', value: details.sourceSubject });
  if (details.sourceSender) fields.push({ label: 'From', value: details.sourceSender });
  if (details.note) fields.push({ label: 'Added note', value: details.note, multiline: true });

  return (
    <GmailConnectionReceipt
      title={state.title}
      description={state.description}
      status={state.status}
      fields={fields}
      gmailUrl={details.gmailUrl}
      className={className}
    />
  );
}
