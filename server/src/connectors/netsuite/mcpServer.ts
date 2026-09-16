import readline from 'node:readline';
import { suiteql, nsFetch, toCsv } from './nsClient.js';

/**
 * NetSuite connector MCP server (stdio). Exposes read-only NetSuite access to an
 * agent as two tools — a SuiteQL query and a REST GET. Hand-rolled JSON-RPC over
 * stdio, matching the wire style of mcp/agentToolsServer.ts (no MCP SDK).
 *
 * Spawned per turn by the toolbox materializer from the NetSuite connector's
 * `buildMcp` (connectors/catalog.ts), which passes the account credentials in
 * env. This process talks to NetSuite directly. Structured timing diagnostics
 * go to stderr; stdout remains MCP JSON-RPC only.
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const TOOLS: ToolDef[] = [
  {
    name: 'suiteql',
    description:
      'Run a read-only SuiteQL query against NetSuite and return the rows. SuiteQL is ' +
      "NetSuite's SQL dialect (SELECT only) over records such as transaction, item, customer, " +
      'vendor, salesorder, purchaseorder, and their columns. Use it for lookups and reports. ' +
      'For a simple direct lookup, call this tool immediately; no shell, file, notebook, or report setup is needed first. ' +
      'Returns JSON rows by default; pass format:"csv" for CSV you can save as a file.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SuiteQL SELECT statement.' },
        limit: { type: 'number', description: 'Max rows to return (default 1000, hard cap 5000).' },
        format: { type: 'string', enum: ['json', 'csv'], description: 'Output format (default json).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get',
    description:
      'GET a NetSuite REST resource by path — e.g. "record/v1/salesorder/12345" or ' +
      '"record/v1/customer?limit=5". Read-only; returns the JSON response.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative REST path after /services/rest/ (e.g. "record/v1/customer/123").',
        },
      },
      required: ['path'],
    },
  },
];

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === 'suiteql') {
      const query = String(args.query ?? '').trim();
      if (!query) return fail('suiteql needs a query.');
      const maxRows = Math.min(Math.max(Number(args.limit) || 1000, 1), 5000);
      const rows = await suiteql(query, { maxRows, pageSize: Math.min(maxRows, 1000) });
      if (String(args.format ?? 'json') === 'csv') {
        return ok(rows.length ? toCsv(rows) : 'No rows.');
      }
      return ok(`${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`);
    }
    if (name === 'get') {
      const path = String(args.path ?? '').trim();
      if (!path) return fail('get needs a path.');
      const data = await nsFetch(path);
      return ok(JSON.stringify(data, null, 2));
    }
    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail((err as Error).message);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'veneer-pro-netsuite', version: '1.0.0' },
        },
      });
      break;
    case 'notifications/initialized':
      break; // notification — no response
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      void callTool(name, args).then((result) => send({ jsonrpc: '2.0', id: msg.id, result }));
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});
