import { ExternalLink } from 'lucide-react';
import type { ToolChatItem } from '@/lib/activityRuns';
import type {
  GoogleSheetsConnectorDetails,
  GoogleSheetsFileSummary,
  GoogleSheetsOperation,
} from '@/lib/types';
import {
  ConnectionReceipt,
  type ConnectionReceiptField,
  type ConnectionReceiptStatus,
} from './ConnectionReceipt';

const RUNNING: Record<GoogleSheetsOperation, { title: string; label: string }> = {
  info: { title: 'Loading spreadsheet', label: 'Loading…' },
  read: { title: 'Reading values', label: 'Reading…' },
  write: { title: 'Updating values', label: 'Updating…' },
  append: { title: 'Appending rows', label: 'Appending…' },
  clear: { title: 'Clearing values', label: 'Clearing…' },
  search: { title: 'Finding spreadsheets', label: 'Searching…' },
  create: { title: 'Creating spreadsheet', label: 'Creating…' },
  lookup: { title: 'Looking up rows', label: 'Looking up…' },
  other: { title: 'Working in Google Sheets', label: 'Working…' },
};

const DONE_LABELS: Record<GoogleSheetsOperation, string> = {
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

function formatTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function successTitle(details: GoogleSheetsConnectorDetails): string {
  const title = details.spreadsheetTitle;
  const range = details.range;
  if (details.operation === 'info') {
    const sheets = details.sheetNames?.length;
    const base = title ? `Loaded ${title}` : 'Loaded spreadsheet';
    return sheets ? `${base} · ${plural(sheets, 'sheet')}` : base;
  }
  if (details.operation === 'read') {
    if (range && title) return `Read ${range} from ${title}`;
    if (range) return `Read ${range}`;
    if (title) return `Read values from ${title}`;
    return 'Read values';
  }
  if (details.operation === 'write') {
    const cells = details.updatedCells;
    const scope = title ? ` in ${title}` : '';
    if (cells !== undefined) return `Updated ${plural(cells, 'cell')}${scope}`;
    if (range) return `Updated ${range}${scope}`;
    return title ? `Updated ${title}` : 'Updated values';
  }
  if (details.operation === 'append') {
    const rows = details.updatedRows;
    const scope = title ? ` to ${title}` : '';
    return rows === undefined ? `Appended rows${scope}` : `Appended ${plural(rows, 'row')}${scope}`;
  }
  if (details.operation === 'clear') {
    const scope = title ? ` in ${title}` : '';
    return range ? `Cleared ${range}${scope}` : `Cleared values${scope}`;
  }
  if (details.operation === 'search') {
    const count = details.resultCount;
    if (count === 0) return 'No spreadsheets found';
    return count === undefined ? 'Found spreadsheets' : `Found ${plural(count, 'spreadsheet')}`;
  }
  if (details.operation === 'create') return title ? `Created ${title}` : 'Created spreadsheet';
  if (details.operation === 'lookup') {
    const count = details.resultCount;
    if (count === 0) return 'No matching rows';
    const scope = title ? ` in ${title}` : '';
    return count === undefined ? `Found matching rows${scope}` : `Found ${plural(count, 'row')}${scope}`;
  }
  return details.actionLabel ?? 'Completed action';
}

function sheetsState(item: ToolChatItem, details: GoogleSheetsConnectorDetails): {
  title: string;
  description: string;
  status: ConnectionReceiptStatus;
} {
  const running = RUNNING[details.operation] ?? RUNNING.other;
  if (item.running) return {
    title: running.title,
    description: 'Google Sheets is working on this action.',
    status: { kind: 'working', label: running.label },
  };
  if (!item.ok || details.successful === false) return {
    title: 'Action failed',
    description: details.error ?? 'Google Sheets could not complete this action.',
    status: { kind: 'error', label: 'Failed' },
  };
  const count = details.resultCount;
  const label = details.operation === 'search' || details.operation === 'lookup'
    ? count === undefined ? DONE_LABELS[details.operation] : `${count} found`
    : DONE_LABELS[details.operation] ?? 'Completed';
  return {
    title: successTitle(details),
    description: 'Google Sheets completed this action.',
    status: { kind: 'success', label },
  };
}

function fileMeta(file: GoogleSheetsFileSummary): string | undefined {
  return formatTimestamp(file.modifiedAt);
}

function receiptFields(details: GoogleSheetsConnectorDetails): ConnectionReceiptField[] {
  const fields: ConnectionReceiptField[] = [];
  if (details.searchSummary) fields.push({ label: 'Search', value: details.searchSummary });
  if (details.range) fields.push({ label: 'Range', value: details.range });
  if (details.rowCount !== undefined || details.columnCount !== undefined) {
    const parts: string[] = [];
    if (details.rowCount !== undefined) parts.push(plural(details.rowCount, 'row'));
    if (details.columnCount !== undefined) parts.push(plural(details.columnCount, 'column'));
    fields.push({ label: 'Returned', value: parts.join(' × ') });
  }
  if (details.updatedCells !== undefined || details.updatedRows !== undefined) {
    const parts: string[] = [];
    if (details.updatedCells !== undefined) parts.push(plural(details.updatedCells, 'cell'));
    if (details.updatedRows !== undefined) parts.push(plural(details.updatedRows, 'row'));
    fields.push({ label: 'Changed', value: parts.join(' · ') });
  }
  return fields;
}

export function GoogleSheetsConnectionDetails({ item }: { item: ToolChatItem }) {
  const details = item.connectorDetails as GoogleSheetsConnectorDetails;
  const state = sheetsState(item, details);
  const sheetNames = details.sheetNames;
  const files = details.files;

  return (
    <ConnectionReceipt
      title={state.title}
      description={state.description}
      status={state.status}
      fields={receiptFields(details)}
      actionHref={details.spreadsheetUrl}
      actionLabel={details.spreadsheetUrl ? 'Open in Google Sheets' : undefined}
    >
      {sheetNames?.length || files?.length ? (
        <div className="grid gap-2.5">
          {sheetNames?.length ? (
            <div className="grid gap-1.5">
              <p className="font-medium text-foreground">Sheets</p>
              <ul role="list" className="flex flex-wrap gap-1.5">
                {sheetNames.map((name, index) => (
                  <li
                    key={`${name}-${index}`}
                    className="min-w-0 rounded-full bg-background/70 px-2 py-0.5 text-muted-foreground ring-1 ring-foreground/5 dark:ring-white/5"
                  >
                    <span className="break-words">{name}</span>
                  </li>
                ))}
              </ul>
              {details.hasMoreSheets ? <p className="text-pretty text-muted-foreground">More sheets are in this spreadsheet.</p> : null}
            </div>
          ) : null}
          {files?.length ? (
            <div className="grid gap-1.5">
              <p className="font-medium text-foreground">Spreadsheets</p>
              <ul role="list" className="divide-y divide-foreground/5">
                {files.map((file, index) => (
                  <li key={`${file.name ?? 'spreadsheet'}-${index}`} className="grid gap-0.5 py-2 first:pt-0 last:pb-0">
                    {file.url ? (
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-h-12 min-w-0 items-start gap-1.5 rounded-md font-medium text-foreground underline decoration-foreground/25 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9"
                      >
                        <span className="min-w-0 break-words">{file.name ?? 'Open spreadsheet'}</span>
                        <ExternalLink className="size-4 h-lh shrink-0 stroke-muted-foreground" aria-hidden="true" />
                      </a>
                    ) : (
                      <p className="min-w-0 break-words font-medium text-foreground">{file.name ?? 'Spreadsheet'}</p>
                    )}
                    {fileMeta(file) ? <p className="min-w-0 break-words text-muted-foreground">{fileMeta(file)}</p> : null}
                  </li>
                ))}
              </ul>
              {details.hasMore ? <p className="text-pretty text-muted-foreground">More matching spreadsheets are available.</p> : null}
            </div>
          ) : null}
        </div>
      ) : undefined}
    </ConnectionReceipt>
  );
}
