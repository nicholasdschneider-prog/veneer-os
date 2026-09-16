import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { ConnectorGlyph } from '@/lib/connectorIcons';
import type { ToolChatItem } from '@/lib/activityRuns';
import { cn } from '@/lib/utils';
import { GenericConnectionDetails } from './GenericConnectionDetails';
import { GmailConnectionDetails } from './GmailConnectionDetails';
import { GmailFetchListConnectionDetails } from './GmailFetchListConnectionDetails';
import { GmailFetchMessageConnectionDetails } from './GmailFetchMessageConnectionDetails';
import { GmailFetchThreadConnectionDetails } from './GmailFetchThreadConnectionDetails';
import { GmailReplyConnectionDetails } from './GmailReplyConnectionDetails';
import { GmailSendConnectionDetails } from './GmailSendConnectionDetails';
import { GoogleDriveFindFileConnectionDetails } from './GoogleDriveFindFileConnectionDetails';
import { GoogleSheetsConnectionDetails } from './GoogleSheetsConnectionDetails';

type DetailRenderer = ComponentType<{ item: ToolChatItem }>;

const DETAIL_RENDERERS: Record<string, DetailRenderer> = {
  'gmail-forward': GmailConnectionDetails,
  'gmail-send': GmailSendConnectionDetails,
  'gmail-fetch-list': GmailFetchListConnectionDetails,
  'gmail-fetch-message': GmailFetchMessageConnectionDetails,
  'gmail-fetch-thread': GmailFetchThreadConnectionDetails,
  'gmail-reply': GmailReplyConnectionDetails,
  'google-drive-find-file': GoogleDriveFindFileConnectionDetails,
  'google-sheets': GoogleSheetsConnectionDetails,
};

const SHEETS_STATUS_LABELS: Record<string, string> = {
  info: 'Loaded',
  read: 'Read',
  write: 'Updated',
  append: 'Appended',
  clear: 'Cleared',
  search: 'Found',
  create: 'Created',
  lookup: 'Found',
  other: 'Completed',
};

const SHEETS_ACTION_LABELS: Record<string, string> = {
  info: 'Get spreadsheet info',
  read: 'Read values',
  write: 'Update values',
  append: 'Append rows',
  clear: 'Clear values',
  search: 'Find spreadsheets',
  create: 'Create spreadsheet',
  lookup: 'Look up rows',
};

function statusFor(item: ToolChatItem) {
  if (item.running) {
    return {
      label: 'Working',
      icon: <LoaderCircle className="size-4 shrink-0 animate-spin stroke-brand" aria-hidden="true" />,
    };
  }
  if (!item.ok || item.connectorDetails?.successful === false) {
    return {
      label: 'Failed',
      icon: <X className="size-4 shrink-0 stroke-destructive" aria-hidden="true" />,
    };
  }
  if (
    item.connectorDetails?.kind === 'gmail-forward' ||
    item.connectorDetails?.kind === 'gmail-send' ||
    item.connectorDetails?.kind === 'gmail-reply'
  ) {
    return {
      label: 'Sent',
      icon: <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />,
    };
  }
  if (item.connectorDetails?.kind === 'gmail-fetch-list') {
    return {
      label: 'Fetched',
      icon: <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />,
    };
  }
  if (item.connectorDetails?.kind === 'gmail-fetch-thread' || item.connectorDetails?.kind === 'gmail-fetch-message') {
    return {
      label: 'Loaded',
      icon: <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />,
    };
  }
  if (item.connectorDetails?.kind === 'google-sheets') {
    return {
      label: SHEETS_STATUS_LABELS[item.connectorDetails.operation] ?? 'Completed',
      icon: <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />,
    };
  }
  if (item.connectorDetails?.kind === 'google-drive-find-file') {
    return {
      label: 'Found',
      icon: <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />,
    };
  }
  return {
    label: 'Completed',
    icon: <Check className="size-4 shrink-0 stroke-muted-foreground" aria-hidden="true" />,
  };
}

function actionLabel(item: ToolChatItem): string {
  if (item.connectorDetails?.kind === 'gmail-forward') return 'Forward message';
  if (item.connectorDetails?.kind === 'gmail-send') return 'Send email';
  if (item.connectorDetails?.kind === 'gmail-fetch-list') return 'Fetch emails';
  if (item.connectorDetails?.kind === 'gmail-fetch-message') return 'Fetch message';
  if (item.connectorDetails?.kind === 'gmail-fetch-thread') return 'Fetch thread';
  if (item.connectorDetails?.kind === 'gmail-reply') return 'Reply to thread';
  if (item.connectorDetails?.kind === 'google-drive-find-file') return 'Find files';
  if (item.connectorDetails?.kind === 'google-sheets') {
    return SHEETS_ACTION_LABELS[item.connectorDetails.operation]
      ?? item.connectorDetails.actionLabel
      ?? item.actionLabel;
  }
  return item.actionLabel;
}

export function ConnectionToolRow({ item }: { item: ToolChatItem }) {
  const source = item.source!;
  const status = statusFor(item);
  const Details = item.connectorDetails ? DETAIL_RENDERERS[item.connectorDetails.kind] ?? GenericConnectionDetails : GenericConnectionDetails;

  return (
    <details className="group/connection">
      <summary className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9 [&::-webkit-details-marker]:hidden">
        <ConnectorGlyph slug={source.slug} name={source.name} className="size-5 shrink-0 dark:brightness-125" />
        <p className={cn('min-w-0 flex-1 truncate', item.running && 'shimmer')}>
          <span className="font-medium text-foreground">{source.name}</span>
          <span className="text-muted-foreground"> · {actionLabel(item)}</span>
        </p>
        <div className={cn('flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground', status.label === 'Failed' && 'text-destructive')}>
          {status.icon}
          <span className="max-sm:sr-only">{status.label}</span>
        </div>
        <ChevronDown className="size-4 shrink-0 stroke-muted-foreground transition-transform group-open/connection:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-1 ml-7 text-base sm:text-sm">
        <Details item={item} />
      </div>
    </details>
  );
}
