import type { ReactNode } from 'react';
import {
  ConnectionReceipt,
  type ConnectionReceiptField,
  type ConnectionReceiptStatus,
} from './ConnectionReceipt';

export type GmailReceiptStatus = ConnectionReceiptStatus;
export type GmailReceiptField = ConnectionReceiptField;

export function GmailConnectionReceipt({
  title,
  description,
  status,
  fields,
  gmailUrl,
  children,
  className,
}: {
  title: string;
  description: string;
  status: GmailReceiptStatus;
  fields: GmailReceiptField[];
  gmailUrl?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <ConnectionReceipt
      title={title}
      description={description}
      status={status}
      fields={fields}
      actionHref={gmailUrl}
      actionLabel={gmailUrl ? 'Open in Gmail' : undefined}
      className={className}
    >
      {children}
    </ConnectionReceipt>
  );
}
