import { ExternalLink } from 'lucide-react';
import type { ToolChatItem } from '@/lib/activityRuns';
import type { GoogleDriveFileSummary, GoogleDriveFindFileConnectorDetails } from '@/lib/types';
import {
  ConnectionReceipt,
  type ConnectionReceiptField,
  type ConnectionReceiptStatus,
} from './ConnectionReceipt';

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function fileMeta(file: GoogleDriveFileSummary): string | undefined {
  return [file.fileType, formatTimestamp(file.modifiedAt)].filter(Boolean).join(' · ') || undefined;
}

function findState(item: ToolChatItem, details: GoogleDriveFindFileConnectorDetails): {
  title: string;
  description: string;
  status: ConnectionReceiptStatus;
} {
  if (item.running) return {
    title: 'Finding files',
    description: 'Google Drive is searching for matching files.',
    status: { kind: 'working', label: 'Searching' },
  };
  if (!item.ok || details.successful === false) return {
    title: 'Search failed',
    description: 'Google Drive could not complete this search.',
    status: { kind: 'error', label: 'Failed' },
  };
  const count = details.resultCount;
  if (count === 0) return {
    title: 'No files found',
    description: 'No files matched this search.',
    status: { kind: 'success', label: '0 found' },
  };
  return {
    title: count === undefined ? 'Found files' : `Found ${count} ${count === 1 ? 'file' : 'files'}`,
    description: 'Google Drive completed this search.',
    status: { kind: 'success', label: count === undefined ? 'Found' : `${count} found` },
  };
}

export function GoogleDriveFindFileConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GoogleDriveFindFileConnectorDetails;
  const state = findState(item, details);
  const fields: ConnectionReceiptField[] = details.searchSummary
    ? [{ label: 'Search', value: details.searchSummary }]
    : [];

  return (
    <ConnectionReceipt
      title={state.title}
      description={state.description}
      status={state.status}
      fields={fields}
    >
      {details.files?.length ? (
        <div className="grid gap-2.5">
          <p className="font-medium text-foreground">Files</p>
          <ul role="list" className="divide-y divide-foreground/5">
            {details.files.map((file, index) => (
              <li key={`${file.name ?? 'file'}-${index}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0">
                {file.driveUrl ? (
                  <a
                    href={file.driveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-12 min-w-0 items-start gap-1.5 rounded-md font-medium text-foreground underline decoration-foreground/25 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9"
                  >
                    <span className="min-w-0 break-words">{file.name ?? 'Open file'}</span>
                    <ExternalLink className="size-4 h-lh shrink-0 stroke-muted-foreground" aria-hidden="true" />
                  </a>
                ) : (
                  <p className="min-w-0 break-words font-medium text-foreground">{file.name ?? 'File'}</p>
                )}
                {fileMeta(file) ? <p className="min-w-0 break-words text-muted-foreground">{fileMeta(file)}</p> : null}
              </li>
            ))}
          </ul>
          {details.hasMore ? <p className="text-pretty text-muted-foreground">More matching files are available.</p> : null}
        </div>
      ) : undefined}
    </ConnectionReceipt>
  );
}
