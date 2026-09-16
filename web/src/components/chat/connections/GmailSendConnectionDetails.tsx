import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailSendConnectorDetails } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function gmailSendState(item: ToolChatItem, details: GmailSendConnectorDetails): {
  title: string;
  status: GmailReceiptStatus;
  description: string;
} {
  if (item.running) {
    return {
      title: 'Sending email',
      status: { kind: 'working', label: 'Sending' },
      description: 'Gmail is sending this message.',
    };
  }
  if (!item.ok || details.successful === false) {
    return {
      title: 'Email not sent',
      status: { kind: 'error', label: 'Failed' },
      description: details.error ?? 'Gmail did not send this message.',
    };
  }
  return {
    title: 'Sent email',
    status: { kind: 'success', label: 'Sent' },
    description: 'Gmail accepted and sent this message.',
  };
}

export function GmailSendConnectionDetails({ item, className }: { item: ToolChatItem; className?: string }) {
  const details = item.connectorDetails as GmailSendConnectorDetails;
  const state = gmailSendState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.recipients?.length) fields.push({ label: 'To', value: details.recipients.join(', ') });
  if (details.subject) fields.push({ label: 'Subject', value: details.subject });
  if (details.body) fields.push({ label: 'Message', value: details.body, multiline: true });

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
