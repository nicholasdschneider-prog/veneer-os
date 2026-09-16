import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type DopplerConnection } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function StatusPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={
        ready
          ? 'rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300'
          : 'rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground'
      }
    >
      {label}
    </span>
  );
}

function SecretTokenInput({
  label,
  detail,
  value,
  onChange,
  configured,
}: {
  label: string;
  detail: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="grid gap-1.5">
      <span className="flex items-center justify-between gap-3 text-sm font-medium">
        {label}
        <StatusPill ready={configured} label={configured ? 'Stored securely' : 'Not set'} />
      </span>
      <span className="text-xs text-muted-foreground">{detail}</span>
      <span className="relative mt-1">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={reveal ? 'text' : 'password'}
          placeholder={configured ? 'Leave blank to keep the current token' : 'Paste service token'}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="h-12 rounded-xl pr-12 font-mono text-base md:text-sm"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg"
          onPointerUp={() => setReveal((current) => !current)}
          aria-label={reveal ? `Hide ${label}` : `Show ${label}`}
        >
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </span>
    </label>
  );
}

export function DopplerGuidanceCard({
  connection,
  draft,
  canEdit,
  saving,
  onChange,
  onSave,
}: {
  connection: DopplerConnection | null;
  draft: string;
  canEdit: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const saved = connection?.additionalGuidance ?? '';
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <LockKeyhole className="size-5 text-brand" />
          Agent guidance
        </CardTitle>
        <CardDescription>
          Review the locked Doppler access rule and add guidance for agents on this Veneer instance.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Access mode</span>
          <div className="rounded-xl border bg-muted/40 px-3 py-3">
            <p className="font-medium">{connection?.access.label ?? 'Loading access mode…'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connection?.project && connection.config
                ? `Connected to ${connection.project}/${connection.config}.`
                : 'No client project is connected.'}
            </p>
          </div>
        </div>

        <div className="grid gap-1.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            Platform safety guidance
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Locked
            </span>
          </span>
          <p
            className="rounded-xl border bg-muted/40 px-3 py-3 text-sm leading-6 text-muted-foreground"
            aria-readonly="true"
          >
            {connection?.access.safetyGuidance ?? 'Loading platform guidance…'}
          </p>
        </div>

        <label className="grid gap-1.5" htmlFor="doppler-additional-guidance">
          <span className="text-sm font-medium">Additional guidance</span>
          <span className="text-xs leading-5 text-muted-foreground">
            Added to every agent turn on this instance. It cannot override the locked rule. Do not put secrets here.
          </span>
          <textarea
            id="doppler-additional-guidance"
            value={draft}
            maxLength={20_000}
            disabled={!canEdit}
            onChange={(event) => onChange(event.target.value)}
            placeholder="For example: Use the client project for all vendor API keys."
            rows={6}
            className="resize-y rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-60 md:text-sm"
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {draft.length.toLocaleString()} / 20,000
          </span>
          {canEdit ? (
            <Button type="button" disabled={saving || draft === saved} onPointerUp={onSave}>
              {saving ? 'Saving…' : 'Save guidance'}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Only the owner can change this guidance.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function DopplerPage({
  onToast,
  canEditGuidance = true,
}: {
  onToast: (message: string) => void;
  canEditGuidance?: boolean;
}) {
  const [connection, setConnection] = useState<DopplerConnection | null>(null);
  const [project, setProject] = useState('');
  const [config, setConfig] = useState('prd');
  const [runtimeToken, setRuntimeToken] = useState('');
  const [agentToken, setAgentToken] = useState('');
  const [guidanceDraft, setGuidanceDraft] = useState('');
  const [busy, setBusy] = useState<'connect' | 'test' | 'disconnect' | 'guidance' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const applyConnection = useCallback((next: DopplerConnection) => {
    setConnection(next);
    if (next.project) setProject(next.project);
    if (next.config) setConfig(next.config);
    setGuidanceDraft(next.additionalGuidance);
  }, []);

  useEffect(() => {
    api
      .doppler()
      .then(({ connection: next }) => applyConnection(next))
      .catch((reason: Error) => setError(reason.message));
  }, [applyConnection]);

  const connect = useCallback(async () => {
    setBusy('connect');
    setError(null);
    setMemoryNotice(null);
    try {
      const result = await api.connectDoppler({
        project: project.trim(),
        config: config.trim(),
        runtimeToken: runtimeToken.trim(),
        agentToken: agentToken.trim(),
      });
      applyConnection(result.connection);
      // Memory is an optional enhancement, so setup failing does not fail the
      // connection — but the reason has to reach the person who can act on it.
      if (result.memory && !result.memory.configured && result.memory.error) {
        setMemoryNotice(result.memory.error);
      }
      setRuntimeToken('');
      setAgentToken('');
      onToast(connection?.connected ? 'Doppler connection updated.' : 'Doppler connected.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }, [agentToken, applyConnection, config, connection?.connected, onToast, project, runtimeToken]);

  const test = useCallback(async () => {
    setBusy('test');
    setError(null);
    try {
      const result = await api.testDoppler();
      applyConnection(result.connection);
      onToast('Runtime read and agent write access verified.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }, [applyConnection, onToast]);

  const saveGuidance = useCallback(async () => {
    setBusy('guidance');
    setError(null);
    try {
      const result = await api.updateDopplerGuidance(guidanceDraft);
      applyConnection(result.connection);
      onToast('Agent guidance saved.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }, [applyConnection, guidanceDraft, onToast]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setError(null);
    try {
      const result = await api.disconnectDoppler();
      applyConnection(result.connection);
      setRuntimeToken('');
      setAgentToken('');
      setConfirmDisconnect(false);
      onToast('Doppler disconnected and local credentials cleared.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }, [applyConnection, onToast]);

  const connected = connection?.connected === true;
  const canConnect =
    project.trim().length > 0 &&
    config.trim().length > 0 &&
    (connected || (runtimeToken.trim().length > 0 && agentToken.trim().length > 0));

  return (
    <div className="flex flex-col gap-4">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5 text-brand" />
            Client secret vault
          </CardTitle>
          <CardDescription>
            Connect this Veneer instance to one client-specific Doppler project. Tokens are write-only,
            stored locally with 0600 permissions, and excluded from backups.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill ready={connected} label={connected ? 'Connected' : 'Not connected'} />
            <StatusPill
              ready={connection?.runtime.healthy === true}
              label={connection?.runtime.healthy ? 'Runtime healthy' : 'Runtime not verified'}
            />
            {connection?.connectedAt ? (
              <span className="text-xs text-muted-foreground">
                Connected {new Date(connection.connectedAt).toLocaleString()}
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
          ) : null}

          {memoryNotice ? (
            <div className="mt-4 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Memory is not set up.</span> {memoryNotice}
            </div>
          ) : null}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Doppler project
              <Input
                value={project}
                onChange={(event) => setProject(event.target.value)}
                placeholder="client-project"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-12 rounded-xl text-base md:text-sm"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Config
              <Input
                value={config}
                onChange={(event) => setConfig(event.target.value)}
                placeholder="prd"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-12 rounded-xl text-base md:text-sm"
              />
            </label>
          </div>

          <div className="mt-5 grid gap-5">
            <SecretTokenInput
              label="Runtime token · read only"
              detail="Used by Veneer services. It can download secrets but cannot change them."
              value={runtimeToken}
              onChange={setRuntimeToken}
              configured={connection?.runtime.configured === true}
            />
            <SecretTokenInput
              label="Agent token · read/write"
              detail="Used only through approval-gated agent tools and the owner/consultant terminal."
              value={agentToken}
              onChange={setAgentToken}
              configured={connection?.agent.configured === true}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button type="button" disabled={!canConnect || busy !== null} onPointerUp={() => void connect()}>
              {busy === 'connect' ? <RefreshCw className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              {connected ? 'Reconnect' : 'Connect'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!connected || busy !== null}
              onPointerUp={() => void test()}
            >
              {busy === 'test' ? <RefreshCw className="size-4 animate-spin" /> : null}
              Test access
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={!connected || busy !== null}
              onPointerUp={() => setConfirmDisconnect(true)}
            >
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>

      <DopplerGuidanceCard
        connection={connection}
        draft={guidanceDraft}
        canEdit={canEditGuidance}
        saving={busy === 'guidance'}
        onChange={setGuidanceDraft}
        onSave={() => void saveGuidance()}
      />

      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        Precedence is local API-key override → client Doppler → legacy environment. Secret values are
        never returned by this page.
      </p>

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Doppler?</DialogTitle>
            <DialogDescription>
              Veneer will delete both local tokens and the dedicated Doppler CLI cache. The project and
              its secrets remain unchanged in Doppler; features fall back to local overrides or legacy
              environment values.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onPointerUp={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== null}
              onPointerUp={() => void disconnect()}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
