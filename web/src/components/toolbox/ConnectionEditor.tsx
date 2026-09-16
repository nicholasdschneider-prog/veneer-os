import { useState } from 'react';
import { CheckCircle2, ChevronLeft, XCircle } from 'lucide-react';
import { api, type Connection, type ConnectionWrite, type McpConfig, type Policy, type TestResult } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, KeyValueRows, Segmented } from './controls';
import { PolicyEditor } from './PolicyEditor';

const DEFAULT_POLICY: Policy = { default: 'approve', rules: [] };

function toEntries(map: Record<string, string> | undefined): [string, string][] {
  return Object.entries(map ?? {});
}
function fromEntries(entries: [string, string][]): Record<string, string> {
  return Object.fromEntries(entries.filter(([k]) => k.trim()));
}

export function ConnectionEditor({
  connection,
  role,
  onClose,
}: {
  connection: Connection | null;
  role: string;
  onClose: (changed: boolean) => void;
}) {
  const mcp = connection?.config;

  const [name, setName] = useState(connection?.name ?? '');
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [managedBy, setManagedBy] = useState<'consultant' | 'owner'>(connection?.managedBy ?? 'consultant');
  const [transport, setTransport] = useState<'stdio' | 'remote'>(
    mcp && mcp.transport !== 'stdio' ? 'remote' : 'stdio',
  );
  const [command, setCommand] = useState(mcp?.transport === 'stdio' ? mcp.command : '');
  const [argsText, setArgsText] = useState(mcp?.transport === 'stdio' ? mcp.args.join('\n') : '');
  const [envEntries, setEnvEntries] = useState<[string, string][]>(
    toEntries(mcp?.transport === 'stdio' ? mcp.env : {}),
  );
  const [url, setUrl] = useState(mcp && mcp.transport !== 'stdio' ? mcp.url : '');
  const [headerEntries, setHeaderEntries] = useState<[string, string][]>(
    toEntries(mcp && mcp.transport !== 'stdio' ? mcp.headers : {}),
  );
  const [policy, setPolicy] = useState<Policy>(connection?.policy ?? DEFAULT_POLICY);

  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const buildConfig = (): McpConfig => {
    if (transport === 'stdio') {
      return {
        transport: 'stdio',
        command: command.trim(),
        args: argsText.split('\n').map((s) => s.trim()).filter(Boolean),
        env: fromEntries(envEntries),
      };
    }
    // Preserve http vs sse if editing a remote connection; default to http.
    const remoteKind = mcp && mcp.transport === 'sse' ? 'sse' : 'http';
    return { transport: remoteKind, url: url.trim(), headers: fromEntries(headerEntries) };
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Give this connection a name.');
      return;
    }
    setBusy('save');
    setError(null);
    const body: ConnectionWrite = {
      name: name.trim(),
      config: buildConfig(),
      enabled,
      policy,
      ...(role === 'consultant' ? { managedBy } : {}),
    };
    try {
      if (connection) await api.updateConnection(connection.id, body);
      else await api.createConnection(body);
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!connection) return;
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      const r = await api.testConnection(connection.id);
      setTest(r.result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!connection) return;
    setBusy('delete');
    try {
      await api.deleteConnection(connection.id);
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon-lg" className="rounded-full" onPointerUp={() => onClose(false)} aria-label="Back">
          <ChevronLeft className="size-5" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium">{connection ? connection.name : 'New connection'}</p>
        <Button className="rounded-xl" onPointerUp={() => void save()} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+3rem)]">
        <div className="flex flex-col gap-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shopify" className="h-11 rounded-xl" />
          </Field>

          <Field label="How it connects">
            <Segmented
              value={transport}
              options={[
                { value: 'stdio', label: 'Command' },
                { value: 'remote', label: 'Web address' },
              ]}
              onChange={setTransport}
            />
          </Field>

          {transport === 'stdio' ? (
            <>
              <Field label="Command" hint="The program that runs the connection.">
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="h-11 rounded-xl font-mono text-sm" />
              </Field>
              <Field label="Arguments" hint="One per line.">
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  rows={3}
                  placeholder={'-y\n@modelcontextprotocol/server-everything'}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-h-[44px] resize-y rounded-xl border bg-transparent px-3 py-2.5 font-mono text-sm outline-none focus:border-ring"
                />
              </Field>
              <Field label="Environment variables" hint="For API keys and secrets — stored securely, never shown again.">
                <KeyValueRows entries={envEntries} onChange={setEnvEntries} keyPlaceholder="API_KEY" secret hasStoredSecrets={connection?.hasSecrets} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Web address">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="h-11 rounded-xl font-mono text-sm" />
              </Field>
              <Field label="Headers" hint="For auth tokens — stored securely, never shown again.">
                <KeyValueRows entries={headerEntries} onChange={setHeaderEntries} keyPlaceholder="Authorization" secret hasStoredSecrets={connection?.hasSecrets} />
              </Field>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">What it's allowed to do</span>
            <PolicyEditor policy={policy} onChange={setPolicy} />
          </div>

          {/* Enabled + management */}
          <div className="flex items-center justify-between rounded-xl border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">Off means the assistant can't use it.</p>
            </div>
            <button
              onPointerUp={() => setEnabled((v) => !v)}
              className={`relative h-7 w-12 rounded-full transition-colors ${enabled ? 'bg-brand' : 'bg-muted-foreground/30'}`}
              aria-pressed={enabled}
              aria-label="Toggle enabled"
            >
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-card shadow transition-all ${enabled ? 'left-[1.375rem]' : 'left-0.5'}`} />
            </button>
          </div>

          {role === 'consultant' ? (
            <Field label="Who can manage this" hint="Owners can edit their own; consultant items stay yours.">
              <Segmented
                value={managedBy}
                options={[
                  { value: 'consultant', label: 'Consultant' },
                  { value: 'owner', label: 'Client owner' },
                ]}
                onChange={setManagedBy}
              />
            </Field>
          ) : null}

          {test ? (
            <div className={`rounded-xl px-4 py-3 text-sm ${test.ok ? 'bg-accent text-brand' : 'bg-destructive/10 text-destructive'}`}>
              <p className="flex items-start gap-1.5">
                {test.ok ? <CheckCircle2 className="size-4 shrink-0 translate-y-0.5" /> : <XCircle className="size-4 shrink-0 translate-y-0.5" />}
                <span>{test.detail}</span>
              </p>
              {test.tools.length ? (
                <ul className="mt-2 flex flex-col gap-0.5 font-mono text-xs">
                  {test.tools.map((t) => (
                    <li key={t} className="truncate">{t}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}

          <div className="flex flex-col gap-2">
            {connection ? (
              <Button variant="outline" className="h-11 rounded-xl" onPointerUp={() => void runTest()} disabled={busy !== null}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </Button>
            ) : null}
            {connection ? (
              <Button
                variant="ghost"
                className="h-11 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                onPointerUp={() => void remove()}
                disabled={busy !== null}
              >
                {busy === 'delete' ? 'Removing…' : 'Remove'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
