import {
  getRingCentralAccount,
  getRingCentralCall,
  getRingCentralCurrentExtension,
  getRingCentralRecording,
  listRingCentralCalls,
  listRingCentralExtensions,
  listRingCentralPhoneNumbers,
} from './client.js';

export interface RingCentralToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const pagingProperties = {
  page: { type: 'integer', minimum: 1, maximum: 100, description: 'Result page, default 1.' },
  perPage: { type: 'integer', minimum: 1, maximum: 200, description: 'Results per page, default 50.' },
};

export const RINGCENTRAL_TOOLS: readonly RingCentralToolDefinition[] = Object.freeze([
  {
    name: 'get_account',
    description: 'Read basic identity and service metadata for the connected RingCentral account.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_current_extension',
    description: 'Read the identity and settings metadata for the authenticated RingCentral extension.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_extensions',
    description: 'List RingCentral account extensions with bounded pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        ...pagingProperties,
        status: { type: 'string', enum: ['Enabled', 'Disabled', 'NotActivated'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_phone_numbers',
    description: 'List company phone-number metadata with bounded pagination.',
    inputSchema: { type: 'object', properties: pagingProperties, additionalProperties: false },
  },
  {
    name: 'list_calls',
    description: 'Read a bounded company call-log window. Defaults to the last 7 days and never spans more than 90 days.',
    inputSchema: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', format: 'date-time', description: 'Inclusive ISO timestamp. Defaults to 7 days before dateTo.' },
        dateTo: { type: 'string', format: 'date-time', description: 'Exclusive ISO timestamp. Defaults to now.' },
        direction: { type: 'string', enum: ['Inbound', 'Outbound'] },
        recordingOnly: { type: 'boolean', description: 'When true, return only calls with recordings.' },
        phoneNumber: { type: 'string', minLength: 3, maxLength: 40 },
        page: pagingProperties.page,
        perPage: { type: 'integer', minimum: 1, maximum: 100, description: 'Results per page, default 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_call',
    description: 'Read details for one RingCentral call-log record by its exact ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_recording',
    description: 'Read metadata for one RingCentral recording. Audio content and media download links are never returned.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const TOOL_ARGUMENTS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  get_account: new Set<string>(),
  get_current_extension: new Set<string>(),
  list_extensions: new Set(['page', 'perPage', 'status']),
  list_phone_numbers: new Set(['page', 'perPage']),
  list_calls: new Set(['dateFrom', 'dateTo', 'direction', 'recordingOnly', 'phoneNumber', 'page', 'perPage']),
  get_call: new Set(['id']),
  get_recording: new Set(['id']),
});

function validateToolArguments(name: string, args: Record<string, unknown>): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid RingCentral tool arguments.');
  const allowed = TOOL_ARGUMENTS[name];
  if (!allowed || Object.keys(args).some((key) => !allowed.has(key))) throw new Error('Invalid RingCentral tool arguments.');
  for (const key of ['page', 'perPage'] as const) {
    if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isInteger(args[key]))) {
      throw new Error('Invalid RingCentral tool arguments.');
    }
  }
  for (const key of ['dateFrom', 'dateTo', 'phoneNumber'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw new Error('Invalid RingCentral tool arguments.');
  }
  if (args.recordingOnly !== undefined && typeof args.recordingOnly !== 'boolean') throw new Error('Invalid RingCentral tool arguments.');
  if (args.direction !== undefined && args.direction !== 'Inbound' && args.direction !== 'Outbound') throw new Error('Invalid RingCentral tool arguments.');
  if (args.status !== undefined && !['Enabled', 'Disabled', 'NotActivated'].includes(String(args.status))) throw new Error('Invalid RingCentral tool arguments.');
  if ((name === 'get_call' || name === 'get_recording') && typeof args.id !== 'string') throw new Error('Invalid RingCentral tool arguments.');
}

export async function callRingCentralTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    validateToolArguments(name, args);
    switch (name) {
      case 'get_account': return ok(await getRingCentralAccount());
      case 'get_current_extension': return ok(await getRingCentralCurrentExtension());
      case 'list_extensions': return ok(await listRingCentralExtensions(args as Parameters<typeof listRingCentralExtensions>[0]));
      case 'list_phone_numbers': return ok(await listRingCentralPhoneNumbers(args as Parameters<typeof listRingCentralPhoneNumbers>[0]));
      case 'list_calls': return ok(await listRingCentralCalls(args as Parameters<typeof listRingCentralCalls>[0]));
      case 'get_call': return ok(await getRingCentralCall(String(args.id ?? '')));
      case 'get_recording': return ok(await getRingCentralRecording(String(args.id ?? '')));
      default: return fail('Unknown RingCentral tool.');
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'RingCentral read failed unexpectedly.');
  }
}
