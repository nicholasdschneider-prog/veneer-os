import readline from 'node:readline';
import { resolveCurrentAgentToken } from '../runtime/agentTokenFile.js';
import { runProjectDopplerCli } from '../secrets/projectDopplerCli.js';

const token = process.env.VP_AGENT_TOKEN ?? '';
const tokenFile = process.env.VP_AGENT_TOKEN_FILE ?? '';
const conversationId = process.env.VP_CONVERSATION_ID ?? '';
const baseUrl = process.env.VP_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3100';
const projectDopplerBin = process.env.VP_PROJECT_DOPPLER_BIN ?? '';
const apiConnected = process.env.VP_DOPPLER_API_CONNECTED === '1';
const workspaceDir = process.env.VP_WORKSPACE_DIR ?? process.cwd();

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  ...(projectDopplerBin
    ? [{
        name: 'run_cli',
        description:
          'Run the full Doppler CLI with this machine’s authenticated user profile. Pass arguments as separate array items, without the leading "doppler". This tool has access to every Doppler project available to that profile. Never print a secret value in chat.',
        inputSchema: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Doppler CLI arguments, for example ["projects", "--json"].',
            },
          },
          required: ['args'],
        },
      } satisfies ToolDef]
    : []),
  {
    name: 'status',
    description:
      'Check whether this client Veneer is connected to Doppler and report only non-secret project/config and health metadata.',
    inputSchema: { type: 'object', properties: {} },
  },
  ...(apiConnected
    ? [
        {
          name: 'list_secret_names',
          description:
            'List secret names in this client’s connected Doppler config. Values are never returned. Call this before guessing a name.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_secret',
          description:
            'Read one secret value from this client’s Doppler config. This is sensitive and requires human approval. Never repeat the value in chat; use it only for the requested operation.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact SCREAMING_SNAKE_CASE secret name.' },
            },
            required: ['name'],
          },
        },
        {
          name: 'set_secret',
          description:
            'Create or replace one secret in this client’s Doppler config. This changes external state and requires human approval.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'SCREAMING_SNAKE_CASE secret name.' },
              value: { type: 'string', description: 'Secret value. It is never logged or echoed by Veneer.' },
            },
            required: ['name', 'value'],
          },
        },
        {
          name: 'delete_secret',
          description:
            'Delete one secret from this client’s Doppler config. This is irreversible: confirm with the user before calling. Requires human approval.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact SCREAMING_SNAKE_CASE secret name.' },
            },
            required: ['name'],
          },
        },
      ] satisfies ToolDef[]
    : []),
];

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function authenticatedToken(): string {
  return resolveCurrentAgentToken(token, conversationId, tokenFile);
}

async function callApi(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'X-VP-Agent-Token': authenticatedToken(),
      'content-type': 'application/json',
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.ok === false) {
    throw new Error(typeof body.error === 'string' ? body.error : `Doppler request failed (${response.status}).`);
  }
  return body;
}

async function callTool(name: string, args: Record<string, unknown>) {
  try {
    if (name === 'run_cli' && projectDopplerBin) {
      const cliArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const result = await runProjectDopplerCli(projectDopplerBin, cliArgs, workspaceDir);
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text', text: output || `Doppler exited ${result.code}.` }],
        ...(result.code === 0 ? {} : { isError: true }),
      };
    }
    if (name === 'status') {
      const { connection } = await callApi('/api/admin/doppler');
      const c = (connection ?? {}) as Record<string, unknown>;
      const runtime = (c.runtime ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            type: 'text',
            text: c.connected
              ? `Connected to ${String(c.project ?? '?')}/${String(c.config ?? '?')}. Runtime is ${runtime.healthy ? 'healthy' : 'degraded'}.`
              : projectDopplerBin
                ? 'Full Doppler CLI access is available through this machine’s authenticated user profile.'
                : 'Doppler is not connected on this Veneer instance.',
          },
        ],
      };
    }
    if (name === 'list_secret_names') {
      const { names } = await callApi('/api/doppler/secrets');
      const list = Array.isArray(names) ? names.map(String) : [];
      return {
        content: [{ type: 'text', text: list.length ? list.join('\n') : 'No user-managed secrets are configured.' }],
      };
    }
    if (name === 'read_secret') {
      const secretName = String(args.name ?? '').trim().toUpperCase();
      const body = await callApi(`/api/doppler/secrets/${encodeURIComponent(secretName)}`);
      return {
        content: [
          {
            type: 'text',
            text: `Secret ${String(body.name ?? secretName)}:\n${String(body.value ?? '')}\n\nDo not repeat this value in chat.`,
          },
        ],
      };
    }
    if (name === 'set_secret') {
      const secretName = String(args.name ?? '').trim().toUpperCase();
      await callApi(`/api/doppler/secrets/${encodeURIComponent(secretName)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: String(args.value ?? '') }),
      });
      return { content: [{ type: 'text', text: `Saved ${secretName} in the connected Doppler config.` }] };
    }
    if (name === 'delete_secret') {
      const secretName = String(args.name ?? '').trim().toUpperCase();
      await callApi(`/api/doppler/secrets/${encodeURIComponent(secretName)}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Deleted ${secretName} from the connected Doppler config.` }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'veneer-pro-doppler', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '');
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    void callTool(name, args).then((result) => send({ jsonrpc: '2.0', id: message.id, result }));
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
