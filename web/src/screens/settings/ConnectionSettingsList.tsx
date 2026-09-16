import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { api, type Connection } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ConnectionEditor } from '@/components/toolbox/ConnectionEditor';
import { SettingsSection } from './SettingsPrimitives';

type EditorState = { connection: Connection | null };

export function ConnectionSettingsList({
  role,
}: {
  role: string;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api
      .connections()
      .then((result) => setConnections(result.connections))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  if (editor) {
    return (
      <ConnectionEditor
        connection={editor.connection}
        role={role}
        onClose={(changed) => {
          setEditor(null);
          if (changed) load();
        }}
      />
    );
  }

  return (
    <SettingsSection
      title="MCP connections"
      description="Connect custom tools and services through the Model Context Protocol."
      action={role !== 'member' ? (
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl"
          onPointerUp={() => setEditor({ connection: null })}
        >
          <Plus className="size-4" />
          Add connection
        </Button>
      ) : undefined}
    >
      {error ? <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p> : null}
      {connections === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No MCP connections yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          {connections.map((connection, index) => {
            const editable =
              role !== 'member' && (role === 'consultant' || connection.managedBy === 'owner');
            return (
              <button
                key={connection.id}
                type="button"
                disabled={!editable}
                onPointerUp={() => {
                  if (editable) setEditor({ connection });
                }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
                  index > 0 ? 'border-t' : ''
                } disabled:cursor-default disabled:opacity-80`}
              >
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    connection.enabled ? 'bg-brand' : 'bg-muted-foreground/30'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{connection.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {connection.enabled ? 'On' : 'Off'} ·{' '}
                    {connection.managedBy === 'owner' ? 'Workspace managed' : 'Consultant managed'}
                    {!editable ? ' · Read only' : ''}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}
