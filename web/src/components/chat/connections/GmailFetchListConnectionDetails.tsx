import type { ToolChatItem } from '@/lib/activityRuns';
import type { GmailFetchListConnectorDetails, GmailMessageSummary } from '@/lib/types';
import { GmailConnectionReceipt, type GmailReceiptField, type GmailReceiptStatus } from './GmailConnectionReceipt';

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function messageMeta(message: GmailMessageSummary): string | undefined {
  return [message.sender, formatTimestamp(message.receivedAt)].filter(Boolean).join(' · ') || undefined;
}

function fetchState(item: ToolChatItem, details: GmailFetchListConnectorDetails): {
  title: string;
  description: string;
  status: GmailReceiptStatus;
} {
  if (item.running) {
    return {
      title: 'Fetching email',
      description: 'Gmail is searching for matching messages.',
      status: { kind: 'working', label: 'Searching' },
    };
  }
  if (!item.ok || details.successful === false) {
    return {
      title: 'Email not fetched',
      description: details.error ?? 'Gmail could not complete this search.',
      status: { kind: 'error', label: 'Failed' },
    };
  }
  const count = details.resultCount;
  return {
    title: count === undefined ? 'Fetched email' : `Found ${count} ${count === 1 ? 'message' : 'messages'}`,
    description: count === 0 ? 'No messages matched this search.' : 'Gmail completed this search.',
    status: { kind: 'success', label: count === undefined ? 'Fetched' : `${count} found` },
  };
}

export function GmailFetchListConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GmailFetchListConnectorDetails;
  const state = fetchState(item, details);
  const fields: GmailReceiptField[] = [];
  if (details.searchSummary) fields.push({ label: 'Search', value: details.searchSummary });
  if (details.resultEstimate !== undefined && details.resultEstimate > (details.resultCount ?? 0)) {
    fields.push({ label: 'Available', value: `${details.resultEstimate.toLocaleString()} estimated` });
  }

  return (
    <GmailConnectionReceipt
      title={state.title}
      description={state.description}
      status={state.status}
      fields={fields}
    >
      {details.messages?.length ? (
        <div className="grid gap-2.5">
          <p className="font-medium text-foreground">Messages</p>
          <ul role="list" className="divide-y divide-foreground/5">
            {details.messages.map((message, index) => (
              <li key={`${message.messageRef ?? message.subject ?? 'message'}-${index}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0">
                <p className="min-w-0 truncate font-medium text-foreground">{message.subject ?? 'No subject'}</p>
                {messageMeta(message) ? <p className="min-w-0 truncate text-muted-foreground">{messageMeta(message)}</p> : null}
                {message.preview ? <p className="line-clamp-2 text-pretty text-muted-foreground">{message.preview}</p> : null}
              </li>
            ))}
          </ul>
          {details.hasMore ? <p className="text-muted-foreground">More matching messages are available.</p> : null}
        </div>
      ) : undefined}
    </GmailConnectionReceipt>
  );
}
