import fs from 'node:fs';
import readline from 'node:readline';
import { runAgentBrowser, sharedDesktopUrl } from './agentBrowser.js';

const conversationId = process.env.VP_CONVERSATION_ID ?? '';
const workspaceDir = process.env.VP_WORKSPACE_DIR ?? process.cwd();
const returnImages = process.env.VP_AGENT_BROWSER_RETURN_IMAGES !== '0';
const desktopUrl = sharedDesktopUrl();

const TOOL = {
  name: 'run',
  description:
    'LOCAL DEV browser: run one command with the host\'s local Agent Browser, in a browser session isolated to this conversation. Use it for apps reachable only from this machine — localhost dev servers and other agent-machine-only URLs — and for the user\'s shared visible desktop Chrome (see `shared`), not for general web browsing. When the `veneer_browser` tools are available, use them for general web tasks. Pass CLI arguments as an array, e.g. ["open","https://example.com"], ["snapshot","-i"], ["click","@e1"], ["get","title"], ["screenshot","--full"], or ["close"]. Call once per command; the session persists. Screenshots are saved safely in the working folder and, when the current model supports image tool results, also returned inline. This does not require Bash.',
  inputSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Arguments after `agent-browser`, one string per CLI argument. Do not include the executable name.',
      },
      timeout_ms: {
        type: 'number',
        minimum: 1000,
        maximum: 120000,
        description: 'Optional command timeout in milliseconds (default 45000, maximum 120000).',
      },
      shared: {
        type: 'boolean',
        description:
          `Attach to the user's shared visible desktop Chrome instead of this chat's isolated headless browser. Use it when the user asks for the shared/visible browser, or when a watchable, take-over-able browser genuinely helps — e.g. a login the user must complete themselves, or work the user will want to see live. Routine background browsing should stay in the default isolated session. When you use shared mode, tell the user they can watch and take over at ${desktopUrl}.`,
      },
    },
    required: ['args'],
  },
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function callTool(args: Record<string, unknown>): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    const result = await runAgentBrowser(args.args, {
      conversationId,
      workspaceDir,
      timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
      shared: args.shared === true,
    });
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const content: Content[] = [{ type: 'text', text: text || `agent-browser exited ${result.exitCode}.` }];
    if (result.screenshotPath && result.exitCode === 0 && fs.existsSync(result.screenshotPath)) {
      const size = fs.statSync(result.screenshotPath).size;
      content[0] = {
        type: 'text',
        text: `${text || 'Screenshot captured.'}\nSaved to ${result.screenshotPath} (${size} bytes)`,
      };
      if (returnImages) {
        content.push({ type: 'image', data: fs.readFileSync(result.screenshotPath).toString('base64'), mimeType: 'image/png' });
      }
    }
    // In shared desktop mode, remind the user where they can watch and take over.
    // Skip on failures (nothing ran) and on close (they are detaching).
    const command = String((Array.isArray(args.args) ? args.args[0] : '') ?? '').toLowerCase();
    if (args.shared === true && result.exitCode === 0 && command !== 'close' && content[0]?.type === 'text') {
      content[0] = { type: 'text', text: `${content[0].text}\nLive view: ${desktopUrl}` };
    }
    return { content, ...(result.exitCode === 0 ? {} : { isError: true }) };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
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
        serverInfo: { name: 'veneer-pro-agent-browser', version: '1.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [TOOL] } });
  } else if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '');
    if (name !== TOOL.name) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
      });
      return;
    }
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    void callTool(args).then((result) => send({ jsonrpc: '2.0', id: message.id, result }));
  } else if (message.method !== 'notifications/initialized' && message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
