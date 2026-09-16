import { createHash } from 'node:crypto';
import type {
  ConnectorToolDetails,
  GmailFetchListConnectorDetails,
  GmailFetchMessageConnectorDetails,
  GmailFetchThreadConnectorDetails,
  GmailForwardConnectorDetails,
  GmailMessageSummary,
  GmailReplyConnectorDetails,
  GmailSendConnectorDetails,
  GoogleDriveFileSummary,
  GoogleDriveFindFileConnectorDetails,
  GoogleSheetsConnectorDetails,
  GoogleSheetsFileSummary,
  GoogleSheetsOperation,
} from './events.js';

const MAX_RECIPIENTS = 20;
const MAX_NOTE_LENGTH = 2_000;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 2_000;
const MAX_PREVIEW_LENGTH = 280;
const MAX_ERROR_LENGTH = 500;
const MAX_SEARCH_LENGTH = 500;
const MAX_DRIVE_QUERY_LENGTH = 4_000;
const MAX_MESSAGE_SUMMARIES = 4;
const MAX_DRIVE_FILES = 4;
const MAX_FILE_NAME_LENGTH = 500;
const MAX_SHEET_NAMES = 6;
const MAX_SHEET_FILES = 4;
const MAX_RANGE_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;

type UnknownRecord = Record<string, unknown>;
type GmailKind = Exclude<ConnectorToolDetails['kind'], 'google-drive-find-file' | 'google-sheets'>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function boundedMultilineString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function recipientsFrom(...values: unknown[]): string[] | undefined {
  const recipients: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];
    for (const candidate of candidates) {
      const recipient = boundedString(candidate, 320);
      if (recipient && !recipients.includes(recipient)) recipients.push(recipient);
      if (recipients.length >= MAX_RECIPIENTS) return recipients;
    }
  }
  return recipients.length ? recipients : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** MCP clients wrap results differently. Walk only known wrapper fields;
 * every value copied from the discovered object is still explicitly allowed. */
function resultRecord(value: unknown, depth = 0): UnknownRecord | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return parsed === undefined ? null : resultRecord(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = resultRecord(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;

  const looksLikeEnvelope =
    'data' in record || 'successful' in record || 'error' in record ||
    'display_url' in record || 'messages' in record || 'files' in record;
  if (looksLikeEnvelope) return record;

  for (const key of ['structuredContent', 'result', 'content', 'text']) {
    if (!(key in record)) continue;
    const found = resultRecord(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function gmailToolAction(toolName: string): string | undefined {
  const parts = toolName.split('__');
  const server = parts[1]?.toLowerCase() ?? '';
  const rawTool = parts.slice(2).join('__').toLowerCase();
  const gmailServer = server === 'gmail' || server.startsWith('gmail-') || server.startsWith('gmail_');
  if (gmailServer) return rawTool;
  if (server === 'codex_apps' && (rawTool.startsWith('gmail_') || rawTool.startsWith('gmail.'))) {
    return rawTool.slice(6);
  }
  return undefined;
}

function gmailActionKind(toolName: string): GmailKind | undefined {
  const action = gmailToolAction(toolName);
  if (!action) return undefined;
  if (action.includes('forward') && (action.includes('message') || action.includes('email'))) return 'gmail-forward';
  if (action.includes('reply') && (action.includes('thread') || action.includes('email') || action.includes('message'))) return 'gmail-reply';
  if (action.includes('fetch') && action.includes('thread')) return 'gmail-fetch-thread';
  if (action.includes('fetch') && action.includes('message') && action.includes('thread_id')) return 'gmail-fetch-thread';
  if (action.includes('fetch') && action.includes('message') && action.includes('message_id')) return 'gmail-fetch-message';
  if (action.includes('fetch') && (action.includes('email') || action.includes('message'))) return 'gmail-fetch-list';
  if (action.includes('send') && action.includes('email') && !action.includes('draft')) return 'gmail-send';
  return undefined;
}

function googleDriveToolAction(toolName: string): string | undefined {
  const parts = toolName.split('__');
  const server = parts[1]?.toLowerCase() ?? '';
  const rawTool = parts.slice(2).join('__').toLowerCase();
  const driveServer =
    server === 'googledrive' || server.startsWith('googledrive-') || server.startsWith('googledrive_') ||
    server === 'google-drive' || server.startsWith('google-drive-') || server.startsWith('google-drive_') ||
    server === 'google_drive' || server.startsWith('google_drive-') || server.startsWith('google_drive_');
  if (driveServer) return rawTool;
  if (server !== 'codex_apps') return undefined;
  for (const prefix of ['googledrive_', 'googledrive.', 'google_drive_', 'google_drive.']) {
    if (rawTool.startsWith(prefix)) return rawTool.slice(prefix.length);
  }
  return undefined;
}

function isGoogleDriveFindFile(toolName: string): boolean {
  const action = googleDriveToolAction(toolName);
  return Boolean(action && (
    action === 'find_file' || action === 'find_files' ||
    action === 'search_file' || action === 'search_files' ||
    action === 'googledrive_find_file'
  ));
}

function gmailUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const DRIVE_LINK_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'sheets.google.com',
  'slides.google.com',
  'forms.google.com',
]);

function googleDriveUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password && DRIVE_LINK_HOSTS.has(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function errorText(value: unknown): string | undefined {
  const direct = boundedString(value, MAX_ERROR_LENGTH);
  if (direct) return direct;
  const record = asRecord(value);
  return boundedString(record?.message, MAX_ERROR_LENGTH);
}

function correlationRef(value: unknown): string | undefined {
  const id = boundedString(value, 500);
  if (!id) return undefined;
  if (/^gmail-[0-9a-f]{20}$/.test(id)) return id;
  return `gmail-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function searchSummary(value: unknown): string | undefined {
  const query = boundedString(value, MAX_SEARCH_LENGTH);
  if (!query) return 'Recent email';
  const tokens = query.match(/-?[\w-]+:(?:"[^"]*"|\S+)|\S+/g) ?? [];
  const parts = tokens.map((token) => {
    const excluded = token.startsWith('-');
    const normalized = excluded ? token.slice(1) : token;
    const separator = normalized.indexOf(':');
    if (separator < 0) return `Matching “${unquote(normalized)}”`;
    const key = normalized.slice(0, separator).toLowerCase();
    const raw = unquote(normalized.slice(separator + 1));
    const prefix = excluded ? 'Excluding ' : '';
    if (key === 'in') return `${prefix}${raw === 'inbox' ? 'Inbox' : raw}`;
    if (key === 'from') return `${prefix}From ${raw}`;
    if (key === 'to') return `${prefix}To ${raw}`;
    if (key === 'subject') return `${prefix}Subject “${raw}”`;
    if (key === 'label') return `${prefix}Label ${raw}`;
    if (key === 'newer_than') return `${prefix}Newer than ${raw}`;
    if (key === 'older_than') return `${prefix}Older than ${raw}`;
    if (key === 'after') return `${prefix}After ${raw}`;
    if (key === 'before') return `${prefix}Before ${raw}`;
    if (key === 'is' || key === 'has') return `${prefix}${key === 'is' ? 'Is' : 'Has'} ${raw}`;
    return `${prefix}${normalized}`;
  });
  return boundedString(parts.join(' · '), MAX_SEARCH_LENGTH);
}

function quotedDriveValue(value: string): string {
  return value.replace(/\\(['\\])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function googleDriveSearchSummary(value: unknown, insideFolder: boolean, orderByValue?: unknown): string {
  const query = boundedString(value, MAX_DRIVE_QUERY_LENGTH);
  const orderBy = boundedString(orderByValue, 200)?.toLowerCase();
  const parts: string[] = [];
  if (orderBy?.includes('modifiedtime desc')) parts.push('Recently modified');
  else if (orderBy?.includes('modifiedtime')) parts.push('Oldest modified first');
  else if (orderBy?.includes('createdtime desc')) parts.push('Recently created');
  else if (orderBy?.includes('createdtime')) parts.push('Oldest created first');
  const queryTargetsParent = Boolean(query && /(['"])(.*?)\1\s+in\s+parents\b/i.test(query));
  if (insideFolder || queryTargetsParent) parts.push('Inside selected folder');
  if (query) {
    const nameMatches = [...query.matchAll(/\bname\s*(=|contains)\s*(['"])(.*?)\2/gi)];
    if (nameMatches.length > 1) {
      parts.push(`${nameMatches.length} file names`);
    } else if (nameMatches[0]) {
      const name = quotedDriveValue(nameMatches[0][3] ?? '');
      if (name) parts.push(nameMatches[0][1] === '=' ? `Name is “${name}”` : `Name contains “${name}”`);
    }
    const fullTextMatch = query.match(/\bfullText\s+contains\s*(['"])(.*?)\1/i);
    if (fullTextMatch) {
      const text = quotedDriveValue(fullTextMatch[2] ?? '');
      if (text) parts.push(`Content contains “${text}”`);
    }
    const mimeMatch = query.match(/\bmimeType\s*=\s*(['"])(.*?)\1/i);
    if (mimeMatch) {
      const fileType = driveFileType(mimeMatch[2]);
      if (fileType) parts.push(`Type ${fileType}`);
    }
    if (/\bmimeType\s*!=\s*(['"])application\/vnd\.google-apps\.folder\1/i.test(query)) {
      parts.push('Files only');
    }
    if (/\bstarred\s*=\s*true\b/i.test(query)) parts.push('Starred');
    if (/\btrashed\s*=\s*false\b/i.test(query)) parts.push('Not in trash');
    if (/\btrashed\s*=\s*true\b/i.test(query)) parts.push('In trash');
  }
  return boundedString(parts.join(' · '), MAX_SEARCH_LENGTH) ?? 'Drive files';
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return boundedString(value, 80);
}

const DRIVE_FILE_TYPES = new Set([
  'Google Doc', 'Google Sheet', 'Google Slides', 'Google Form', 'Google Drawing',
  'Google Site', 'Folder', 'Shortcut', 'PDF', 'DXF', 'Image', 'Video', 'Audio',
  'Text file', 'Archive', 'File',
]);

function driveFileType(value: unknown): string | undefined {
  const mime = boundedString(value, 200)?.toLowerCase();
  if (!mime) return undefined;
  const exact: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Form',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/vnd.google-apps.site': 'Google Site',
    'application/vnd.google-apps.folder': 'Folder',
    'application/vnd.google-apps.shortcut': 'Shortcut',
    'application/pdf': 'PDF',
    'application/dxf': 'DXF',
    'application/zip': 'Archive',
    'application/x-zip-compressed': 'Archive',
  };
  if (exact[mime]) return exact[mime];
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('text/')) return 'Text file';
  return 'File';
}

function safeDriveFileType(value: unknown): string | undefined {
  const type = boundedString(value, 80);
  return type && DRIVE_FILE_TYPES.has(type) ? type : undefined;
}

function googleDriveFileSummary(value: unknown): GoogleDriveFileSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = boundedString(record.name, MAX_FILE_NAME_LENGTH);
  const fileType = safeDriveFileType(record.fileType) ?? driveFileType(record.mimeType ?? record.mime_type);
  const modifiedAt = timestamp(record.modifiedAt ?? record.modifiedTime ?? record.modified_time);
  const driveUrl = googleDriveUrl(record.driveUrl ?? record.webViewLink ?? record.web_view_link ?? record.display_url);
  if (!name && !fileType && !modifiedAt && !driveUrl) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(fileType ? { fileType } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
    ...(driveUrl ? { driveUrl } : {}),
  };
}

function googleDriveFileSummaries(value: unknown): GoogleDriveFileSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value
    .map(googleDriveFileSummary)
    .filter((file): file is GoogleDriveFileSummary => Boolean(file))
    .slice(0, MAX_DRIVE_FILES);
  return files.length ? files : undefined;
}

function decodeHtmlEntities(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const named: Record<string, string> = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const numeric = code[1]?.toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function messageSummary(value: unknown): GmailMessageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const preview = asRecord(record.preview);
  const messageRef = correlationRef(record.messageRef ?? record.messageId ?? record.message_id ?? record.id);
  const threadRef = correlationRef(record.threadRef ?? record.threadId ?? record.thread_id);
  const subject = boundedString(record.subject ?? preview?.subject, MAX_SUBJECT_LENGTH);
  const sender = boundedString(record.sender ?? record.from, 500);
  const receivedAt = timestamp(record.messageTimestamp ?? record.internalDate ?? record.received_at);
  const previewText = boundedString(
    decodeHtmlEntities(typeof record.preview === 'string' ? record.preview : preview?.body ?? record.snippet),
    MAX_PREVIEW_LENGTH,
  );
  if (!messageRef && !threadRef && !subject && !sender && !receivedAt && !previewText) return undefined;
  return {
    ...(messageRef ? { messageRef } : {}),
    ...(threadRef ? { threadRef } : {}),
    ...(subject ? { subject } : {}),
    ...(sender ? { sender } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    ...(previewText ? { preview: previewText } : {}),
  };
}

function messageSummaries(value: unknown): GmailMessageSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summaries = value
    .map(messageSummary)
    .filter((summary): summary is GmailMessageSummary => Boolean(summary))
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
    .slice(0, MAX_MESSAGE_SUMMARIES);
  return summaries.length ? summaries : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : undefined;
}

function resultStatus(envelope: UnknownRecord, data: UnknownRecord) {
  const successful = typeof envelope.successful === 'boolean'
    ? envelope.successful
    : typeof data.successful === 'boolean'
      ? data.successful
      : undefined;
  const error = errorText(envelope.error ?? data.error);
  const url = gmailUrl(data.display_url ?? data.displayUrl ?? data.url);
  return {
    ...(successful === undefined ? {} : { successful }),
    ...(error ? { error } : {}),
    ...(url ? { gmailUrl: url } : {}),
  };
}

const SHEETS_OPERATIONS: Record<string, GoogleSheetsOperation> = {
  get_spreadsheet_info: 'info',
  get_sheet_names: 'info',
  values_get: 'read',
  batch_get: 'read',
  get_spreadsheet_by_data_filter: 'read',
  spreadsheets_values_batch_get_by_data_filter: 'read',
  values_update: 'write',
  update_values_batch: 'write',
  batch_update_values_by_data_filter: 'write',
  upsert_rows: 'write',
  find_replace: 'write',
  spreadsheets_values_append: 'append',
  create_spreadsheet_row: 'append',
  clear_values: 'clear',
  spreadsheets_values_batch_clear: 'clear',
  batch_clear_values_by_data_filter: 'clear',
  search_spreadsheets: 'search',
  create_google_sheet1: 'create',
  lookup_spreadsheet_row: 'lookup',
  aggregate_column_data: 'lookup',
};

const SHEETS_OPERATION_NAMES = new Set<string>([
  'info', 'read', 'write', 'append', 'clear', 'search', 'create', 'lookup', 'other',
]);

/** Install slugs differ per user, so accept any Sheets-looking MCP server name.
 * Codex flattens every connector onto one server, so only there is the tool's
 * own googlesheets_ prefix trusted to identify the connector. */
function googleSheetsToolAction(toolName: string): string | undefined {
  const parts = toolName.split('__');
  const server = parts[1]?.toLowerCase() ?? '';
  const rawTool = parts.slice(2).join('__').toLowerCase();
  if (!rawTool) return undefined;
  const sheetsServer = ['googlesheets', 'google-sheets', 'google_sheets'].some((name) =>
    server === name || server.startsWith(`${name}-`) || server.startsWith(`${name}_`));
  if (sheetsServer) {
    for (const prefix of ['googlesheets_', 'google_sheets_']) {
      if (rawTool.startsWith(prefix)) return rawTool.slice(prefix.length);
    }
    return rawTool;
  }
  if (server !== 'codex_apps') return undefined;
  for (const prefix of ['googlesheets_', 'googlesheets.', 'google_sheets_', 'google_sheets.']) {
    if (rawTool.startsWith(prefix)) return rawTool.slice(prefix.length);
  }
  return undefined;
}

function googleSheetsOperation(action: string): GoogleSheetsOperation {
  return SHEETS_OPERATIONS[action] ?? 'other';
}

function humanizedAction(action: string): string | undefined {
  const words = action.split(/[-_.]+/).filter(Boolean).join(' ').toLowerCase();
  if (!words) return undefined;
  return boundedString(words.charAt(0).toUpperCase() + words.slice(1), 120);
}

function googleSheetsUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2_048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** A spreadsheet id never reaches the viewer as its own field. It only travels
 * inside a validated docs.google.com link the person can actually open. */
function spreadsheetUrlFromId(value: unknown): string | undefined {
  const id = boundedString(value, 200);
  if (!id || !/^[A-Za-z0-9_-]{5,200}$/.test(id)) return undefined;
  return googleSheetsUrl(`https://docs.google.com/spreadsheets/d/${id}/edit`);
}

function sheetNameList(...values: unknown[]): { sheetNames?: string[]; hasMoreSheets?: true } {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const names: string[] = [];
    for (const entry of value) {
      // One past the cap is enough: it only has to prove more sheets exist.
      if (names.length > MAX_SHEET_NAMES) break;
      const record = asRecord(entry);
      const source = record
        ? asRecord(record.properties)?.title ?? record.title ?? record.name
        : entry;
      const name = boundedString(source, MAX_TITLE_LENGTH);
      if (name && !names.includes(name)) names.push(name);
    }
    if (!names.length) continue;
    return {
      sheetNames: names.slice(0, MAX_SHEET_NAMES),
      ...(names.length > MAX_SHEET_NAMES ? { hasMoreSheets: true as const } : {}),
    };
  }
  return {};
}

function googleSheetsFileSummary(value: unknown): GoogleSheetsFileSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = boundedString(
    record.name ?? record.title ?? asRecord(record.properties)?.title,
    MAX_FILE_NAME_LENGTH,
  );
  const url = googleSheetsUrl(
    record.url ?? record.spreadsheetUrl ?? record.spreadsheet_url ?? record.webViewLink ?? record.web_view_link,
  ) ?? spreadsheetUrlFromId(record.spreadsheetId ?? record.spreadsheet_id ?? record.id);
  const modifiedAt = timestamp(record.modifiedAt ?? record.modifiedTime ?? record.modified_time);
  if (!name && !url && !modifiedAt) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
}

function googleSheetsFileSummaries(value: unknown): GoogleSheetsFileSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value
    .map(googleSheetsFileSummary)
    .filter((file): file is GoogleSheetsFileSummary => Boolean(file))
    .slice(0, MAX_SHEET_FILES);
  return files.length ? files : undefined;
}

/** Only the shape of returned values crosses the seam, never the cells. */
function valueDimensions(value: unknown): { rowCount?: number; columnCount?: number } {
  if (!Array.isArray(value)) return {};
  const rowCount = safeCount(value.length);
  let columns = 0;
  for (const row of value) if (Array.isArray(row)) columns = Math.max(columns, row.length);
  const columnCount = safeCount(columns);
  return {
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(columnCount ? { columnCount } : {}),
  };
}

function googleSheetsBase(action: string): GoogleSheetsConnectorDetails {
  const operation = googleSheetsOperation(action);
  const label = operation === 'other' ? humanizedAction(action) : undefined;
  return { kind: 'google-sheets', operation, ...(label ? { actionLabel: label } : {}) };
}

function googleSheetsInputDetails(action: string, input: unknown): GoogleSheetsConnectorDetails {
  const base = googleSheetsBase(action);
  const record = asRecord(input);
  if (!record) return base;

  const spreadsheetUrl = googleSheetsUrl(record.spreadsheet_url ?? record.spreadsheetUrl)
    ?? spreadsheetUrlFromId(record.spreadsheet_id ?? record.spreadsheetId);
  const sheetName = boundedString(
    record.sheet_name ?? record.sheetName ?? record.worksheet_name,
    MAX_TITLE_LENGTH,
  );
  const cell = boundedString(record.first_cell_location ?? record.firstCellLocation, MAX_RANGE_LENGTH);
  const explicitRange = boundedString(
    record.range ?? record.range_name ?? (Array.isArray(record.ranges) ? record.ranges[0] : undefined),
    MAX_RANGE_LENGTH,
  );
  const range = explicitRange
    ?? (sheetName && cell ? boundedString(`${sheetName}!${cell}`, MAX_RANGE_LENGTH) : cell);
  const title = boundedString(record.title ?? record.spreadsheet_name ?? record.name, MAX_TITLE_LENGTH);
  const search = boundedString(record.query ?? record.search_query ?? record.q, MAX_SEARCH_LENGTH);

  return {
    ...base,
    ...(title ? { spreadsheetTitle: title } : {}),
    ...(spreadsheetUrl ? { spreadsheetUrl } : {}),
    ...(!range && sheetName ? { sheetNames: [sheetName] } : {}),
    ...(range ? { range } : {}),
    ...(search ? { searchSummary: search } : {}),
  };
}

function googleSheetsResultDetails(action: string, result: unknown): GoogleSheetsConnectorDetails {
  const base = googleSheetsBase(action);
  const envelope = resultRecord(result);
  if (!envelope) return base;
  const data = asRecord(envelope.data) ?? envelope;
  const successful = typeof envelope.successful === 'boolean'
    ? envelope.successful
    : typeof data.successful === 'boolean'
      ? data.successful
      : undefined;
  const error = errorText(envelope.error ?? data.error);

  const spreadsheet = asRecord(data.spreadsheet);
  const properties = asRecord(data.properties) ?? asRecord(spreadsheet?.properties);
  const title = boundedString(
    properties?.title ?? data.title ?? data.spreadsheetTitle ?? data.spreadsheet_title,
    MAX_TITLE_LENGTH,
  );
  const url = googleSheetsUrl(
    data.spreadsheetUrl ?? data.spreadsheet_url ?? spreadsheet?.spreadsheetUrl ?? data.url,
  ) ?? spreadsheetUrlFromId(data.spreadsheetId ?? data.spreadsheet_id);
  const sheets = sheetNameList(
    data.sheets ?? spreadsheet?.sheets,
    data.sheetNames,
    data.sheet_names,
    data.sheet_titles,
  );

  const updates = asRecord(data.updates);
  const updatedCells = safeCount(
    data.updatedCells ?? data.updated_cells ?? updates?.updatedCells ?? data.totalUpdatedCells,
  );
  const updatedRows = safeCount(
    data.updatedRows ?? data.updated_rows ?? updates?.updatedRows ?? data.totalUpdatedRows,
  );

  const valueRange = asRecord(Array.isArray(data.valueRanges) ? data.valueRanges[0] : undefined);
  const range = boundedString(
    data.range ?? data.updatedRange ?? updates?.updatedRange ?? valueRange?.range,
    MAX_RANGE_LENGTH,
  );
  const dimensions = valueDimensions(Array.isArray(data.values) ? data.values : valueRange?.values);

  // Only a search returns spreadsheets. Every other action's arrays hold row
  // data, whose fields would otherwise be read as file names, i.e. cell values.
  const rawFiles = base.operation === 'search'
    ? [data.spreadsheets, data.files].find((candidate): candidate is unknown[] => Array.isArray(candidate))
    : undefined;
  const files = googleSheetsFileSummaries(rawFiles);
  const rawRows = [data.matching_rows, data.matches, data.rows, data.records]
    .find((candidate): candidate is unknown[] => Array.isArray(candidate));
  const resultCount = safeCount(rawFiles?.length ?? rawRows?.length);
  const hasMore = base.operation === 'search' &&
    (typeof data.nextPageToken === 'string' || typeof data.next_page_token === 'string');

  return {
    ...base,
    ...(successful === undefined ? {} : { successful }),
    ...(error ? { error } : {}),
    ...(title ? { spreadsheetTitle: title } : {}),
    ...(url ? { spreadsheetUrl: url } : {}),
    ...sheets,
    ...(range ? { range } : {}),
    ...dimensions,
    ...(updatedCells === undefined ? {} : { updatedCells }),
    ...(updatedRows === undefined ? {} : { updatedRows }),
    ...(resultCount === undefined ? {} : { resultCount }),
    ...(hasMore ? { hasMore: true } : {}),
    ...(files ? { files } : {}),
  };
}

/** Re-allowlist details read from historical normalized transcripts. Older
 * rows may predate the privacy boundary and contain raw IDs, labels, or logs.
 * Nothing survives this function unless it is an explicitly bounded field. */
export function sanitizeConnectorDetails(value: unknown): ConnectorToolDetails | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kind = record.kind;
  if (kind === 'google-drive-find-file') {
    const successful = typeof record.successful === 'boolean' ? record.successful : undefined;
    const search = boundedString(record.searchSummary, MAX_SEARCH_LENGTH);
    const resultCount = safeCount(record.resultCount);
    const files = googleDriveFileSummaries(record.files);
    return {
      kind,
      ...(successful === undefined ? {} : { successful }),
      ...(search ? { searchSummary: search } : {}),
      ...(resultCount === undefined ? {} : { resultCount }),
      ...(record.hasMore === true ? { hasMore: true } : {}),
      ...(files ? { files } : {}),
    } satisfies GoogleDriveFindFileConnectorDetails;
  }
  if (kind === 'google-sheets') {
    const operation = typeof record.operation === 'string' && SHEETS_OPERATION_NAMES.has(record.operation)
      ? record.operation as GoogleSheetsOperation
      : 'other';
    const successful = typeof record.successful === 'boolean' ? record.successful : undefined;
    const sheetsError = errorText(record.error);
    const label = boundedString(record.actionLabel, 120);
    const title = boundedString(record.spreadsheetTitle, MAX_TITLE_LENGTH);
    const url = googleSheetsUrl(record.spreadsheetUrl);
    const sheets = sheetNameList(record.sheetNames);
    const range = boundedString(record.range, MAX_RANGE_LENGTH);
    const rowCount = safeCount(record.rowCount);
    const columnCount = safeCount(record.columnCount);
    const updatedCells = safeCount(record.updatedCells);
    const updatedRows = safeCount(record.updatedRows);
    const search = boundedString(record.searchSummary, MAX_SEARCH_LENGTH);
    const resultCount = safeCount(record.resultCount);
    const files = operation === 'search' ? googleSheetsFileSummaries(record.files) : undefined;
    return {
      kind,
      operation,
      ...(successful === undefined ? {} : { successful }),
      ...(sheetsError ? { error: sheetsError } : {}),
      ...(label ? { actionLabel: label } : {}),
      ...(title ? { spreadsheetTitle: title } : {}),
      ...(url ? { spreadsheetUrl: url } : {}),
      ...sheets,
      ...(record.hasMoreSheets === true ? { hasMoreSheets: true } : {}),
      ...(range ? { range } : {}),
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(columnCount === undefined ? {} : { columnCount }),
      ...(updatedCells === undefined ? {} : { updatedCells }),
      ...(updatedRows === undefined ? {} : { updatedRows }),
      ...(search ? { searchSummary: search } : {}),
      ...(resultCount === undefined ? {} : { resultCount }),
      ...(record.hasMore === true && operation === 'search' ? { hasMore: true } : {}),
      ...(files ? { files } : {}),
    } satisfies GoogleSheetsConnectorDetails;
  }
  if (
    kind !== 'gmail-send' && kind !== 'gmail-forward' && kind !== 'gmail-fetch-list' &&
    kind !== 'gmail-fetch-thread' && kind !== 'gmail-fetch-message' && kind !== 'gmail-reply'
  ) return undefined;

  const successful = typeof record.successful === 'boolean' ? record.successful : undefined;
  const error = errorText(record.error);
  const safeUrl = gmailUrl(record.gmailUrl);
  const status = {
    ...(successful === undefined ? {} : { successful }),
    ...(error ? { error } : {}),
    ...(safeUrl ? { gmailUrl: safeUrl } : {}),
  };
  const recipients = recipientsFrom(record.recipients);

  if (kind === 'gmail-send') {
    const subject = boundedString(record.subject, MAX_SUBJECT_LENGTH);
    const body = boundedMultilineString(record.body, MAX_BODY_LENGTH);
    return {
      kind,
      ...status,
      ...(recipients ? { recipients } : {}),
      ...(subject ? { subject } : {}),
      ...(body ? { body } : {}),
    } satisfies GmailSendConnectorDetails;
  }

  if (kind === 'gmail-forward') {
    const messageRef = correlationRef(record.messageRef ?? record.messageId ?? record.message_id);
    const note = boundedMultilineString(record.note, MAX_NOTE_LENGTH);
    const sourceSubject = boundedString(record.sourceSubject, MAX_SUBJECT_LENGTH);
    const sourceSender = boundedString(record.sourceSender, 500);
    return {
      kind,
      ...status,
      ...(messageRef ? { messageRef } : {}),
      ...(recipients ? { recipients } : {}),
      ...(note ? { note } : {}),
      ...(sourceSubject ? { sourceSubject } : {}),
      ...(sourceSender ? { sourceSender } : {}),
    } satisfies GmailForwardConnectorDetails;
  }

  const messages = messageSummaries(record.messages);
  if (kind === 'gmail-fetch-list') {
    const search = boundedString(record.searchSummary, MAX_SEARCH_LENGTH);
    const resultCount = safeCount(record.resultCount);
    const resultEstimate = safeCount(record.resultEstimate);
    return {
      kind,
      ...status,
      ...(search ? { searchSummary: search } : {}),
      ...(resultCount === undefined ? {} : { resultCount }),
      ...(resultEstimate === undefined ? {} : { resultEstimate }),
      ...(record.hasMore === true ? { hasMore: true } : {}),
      ...(messages ? { messages } : {}),
    } satisfies GmailFetchListConnectorDetails;
  }

  const threadRef = correlationRef(record.threadRef ?? record.threadId ?? record.thread_id);
  if (kind === 'gmail-fetch-thread') {
    const subject = boundedString(record.subject, MAX_SUBJECT_LENGTH);
    const latestSender = boundedString(record.latestSender, 500);
    const latestAt = timestamp(record.latestAt);
    const messageCount = safeCount(record.messageCount);
    return {
      kind,
      ...status,
      ...(threadRef ? { threadRef } : {}),
      ...(subject ? { subject } : {}),
      ...(latestSender ? { latestSender } : {}),
      ...(latestAt ? { latestAt } : {}),
      ...(messageCount === undefined ? {} : { messageCount }),
      ...(messages ? { messages } : {}),
    } satisfies GmailFetchThreadConnectorDetails;
  }

  if (kind === 'gmail-fetch-message') {
    const messageRef = correlationRef(record.messageRef ?? record.messageId ?? record.message_id);
    const subject = boundedString(record.subject, MAX_SUBJECT_LENGTH);
    const sender = boundedString(record.sender, 500);
    const receivedAt = timestamp(record.receivedAt);
    const preview = boundedString(decodeHtmlEntities(record.preview), MAX_PREVIEW_LENGTH);
    return {
      kind,
      ...status,
      ...(messageRef ? { messageRef } : {}),
      ...(threadRef ? { threadRef } : {}),
      ...(subject ? { subject } : {}),
      ...(sender ? { sender } : {}),
      ...(receivedAt ? { receivedAt } : {}),
      ...(preview ? { preview } : {}),
    } satisfies GmailFetchMessageConnectorDetails;
  }

  const subject = boundedString(record.subject, MAX_SUBJECT_LENGTH);
  const body = boundedMultilineString(record.body, MAX_BODY_LENGTH);
  return {
    kind,
    ...status,
    ...(threadRef ? { threadRef } : {}),
    ...(recipients ? { recipients } : {}),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
  } satisfies GmailReplyConnectorDetails;
}

export function connectorInputDetails(toolName: string, input: unknown): ConnectorToolDetails | undefined {
  if (isGoogleDriveFindFile(toolName)) {
    const record = asRecord(input);
    if (!record) return { kind: 'google-drive-find-file' };
    return {
      kind: 'google-drive-find-file',
      searchSummary: googleDriveSearchSummary(
        record.q ?? record.query ?? record.search_query,
        typeof (record.folder_id ?? record.folderId) === 'string',
        record.orderBy ?? record.order_by,
      ),
    } satisfies GoogleDriveFindFileConnectorDetails;
  }
  const sheetsAction = googleSheetsToolAction(toolName);
  if (sheetsAction) return googleSheetsInputDetails(sheetsAction, input);
  const kind = gmailActionKind(toolName);
  if (!kind) return undefined;
  const record = asRecord(input);
  if (!record) return { kind } as ConnectorToolDetails;

  const recipients = recipientsFrom(
    record.recipients,
    record.recipient_emails,
    record.recipient_email,
    record.to,
    record.extra_recipients,
  );
  if (kind === 'gmail-send') {
    const subject = boundedString(record.subject, MAX_SUBJECT_LENGTH);
    const body = boundedMultilineString(record.body ?? record.message_body, MAX_BODY_LENGTH);
    return {
      kind,
      ...(recipients ? { recipients } : {}),
      ...(subject ? { subject } : {}),
      ...(body ? { body } : {}),
    } satisfies GmailSendConnectorDetails;
  }
  if (kind === 'gmail-forward') {
    const messageRef = correlationRef(record.message_id ?? record.messageId);
    const note = boundedMultilineString(record.additional_text ?? record.note, MAX_NOTE_LENGTH);
    return {
      kind,
      ...(messageRef ? { messageRef } : {}),
      ...(recipients ? { recipients } : {}),
      ...(note ? { note } : {}),
    } satisfies GmailForwardConnectorDetails;
  }
  if (kind === 'gmail-fetch-list') {
    const summary = searchSummary(record.query ?? record.search_query);
    return {
      kind,
      ...(summary ? { searchSummary: summary } : {}),
    } satisfies GmailFetchListConnectorDetails;
  }
  const threadRef = correlationRef(record.thread_id ?? record.threadId);
  if (kind === 'gmail-fetch-thread') {
    return { kind, ...(threadRef ? { threadRef } : {}) } satisfies GmailFetchThreadConnectorDetails;
  }
  if (kind === 'gmail-fetch-message') {
    const messageRef = correlationRef(record.message_id ?? record.messageId);
    return {
      kind,
      ...(messageRef ? { messageRef } : {}),
      ...(threadRef ? { threadRef } : {}),
    } satisfies GmailFetchMessageConnectorDetails;
  }
  const body = boundedMultilineString(record.message_body ?? record.body ?? record.reply_body, MAX_BODY_LENGTH);
  return {
    kind,
    ...(threadRef ? { threadRef } : {}),
    ...(recipients ? { recipients } : {}),
    ...(body ? { body } : {}),
  } satisfies GmailReplyConnectorDetails;
}

export function connectorResultDetails(toolName: string, result: unknown): ConnectorToolDetails | undefined {
  if (isGoogleDriveFindFile(toolName)) {
    const envelope = resultRecord(result);
    if (!envelope) return { kind: 'google-drive-find-file' };
    const data = asRecord(envelope.data) ?? envelope;
    const successful = typeof envelope.successful === 'boolean'
      ? envelope.successful
      : typeof data.successful === 'boolean'
        ? data.successful
        : undefined;
    const rawFiles = data.files;
    const files = googleDriveFileSummaries(rawFiles);
    const resultCount = safeCount(Array.isArray(rawFiles) ? rawFiles.length : undefined);
    const hasMore = typeof data.nextPageToken === 'string' || typeof data.next_page_token === 'string';
    return {
      kind: 'google-drive-find-file',
      ...(successful === undefined ? {} : { successful }),
      ...(resultCount === undefined ? {} : { resultCount }),
      ...(hasMore ? { hasMore: true } : {}),
      ...(files ? { files } : {}),
    } satisfies GoogleDriveFindFileConnectorDetails;
  }
  const sheetsAction = googleSheetsToolAction(toolName);
  if (sheetsAction) return googleSheetsResultDetails(sheetsAction, result);
  const kind = gmailActionKind(toolName);
  if (!kind) return undefined;
  const envelope = resultRecord(result);
  if (!envelope) return { kind } as ConnectorToolDetails;
  const data = asRecord(envelope.data) ?? envelope;
  const status = resultStatus(envelope, data);

  if (kind === 'gmail-fetch-list') {
    const messages = messageSummaries(data.messages);
    const rawCount = Array.isArray(data.messages) ? data.messages.length : undefined;
    const resultCount = safeCount(rawCount);
    const resultEstimate = safeCount(data.resultSizeEstimate ?? data.result_size_estimate);
    const hasMore = typeof data.nextPageToken === 'string' || typeof data.next_page_token === 'string';
    return {
      kind,
      ...status,
      ...(resultCount === undefined ? {} : { resultCount }),
      ...(resultEstimate === undefined ? {} : { resultEstimate }),
      ...(hasMore ? { hasMore: true } : {}),
      ...(messages ? { messages } : {}),
    } satisfies GmailFetchListConnectorDetails;
  }

  if (kind === 'gmail-fetch-thread') {
    const messages = messageSummaries(data.messages);
    const latest = messages?.[0];
    const threadRef = correlationRef(data.threadId ?? data.thread_id) ?? latest?.threadRef;
    const messageCount = safeCount(Array.isArray(data.messages) ? data.messages.length : undefined);
    return {
      kind,
      ...status,
      ...(threadRef ? { threadRef } : {}),
      ...(latest?.subject ? { subject: latest.subject } : {}),
      ...(latest?.sender ? { latestSender: latest.sender } : {}),
      ...(latest?.receivedAt ? { latestAt: latest.receivedAt } : {}),
      ...(messageCount === undefined ? {} : { messageCount }),
      ...(messages ? { messages } : {}),
    } satisfies GmailFetchThreadConnectorDetails;
  }

  if (kind === 'gmail-fetch-message') {
    const message = messageSummary(data);
    return {
      kind,
      ...status,
      ...(message?.messageRef ? { messageRef: message.messageRef } : {}),
      ...(message?.threadRef ? { threadRef: message.threadRef } : {}),
      ...(message?.subject ? { subject: message.subject } : {}),
      ...(message?.sender ? { sender: message.sender } : {}),
      ...(message?.receivedAt ? { receivedAt: message.receivedAt } : {}),
      ...(message?.preview ? { preview: message.preview } : {}),
    } satisfies GmailFetchMessageConnectorDetails;
  }

  return { kind, ...status } as GmailForwardConnectorDetails | GmailSendConnectorDetails | GmailReplyConnectorDetails;
}
