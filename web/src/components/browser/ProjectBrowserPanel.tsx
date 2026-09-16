import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleStop, ExternalLink, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { VeneerBrowserOtherProfile, VeneerBrowserProfile } from '../../lib/types';
import { Button } from '../ui/button';

export function browserChatHref(projectId: string, conversationId: string): string {
  const query = new URLSearchParams({ project: projectId, browser: projectId });
  return `#/chat/${encodeURIComponent(conversationId)}?${query.toString()}`;
}

export function ActiveBrowserSessions({
  projectId,
  profiles,
}: {
  projectId: string;
  profiles: VeneerBrowserProfile[];
}) {
  const activeProfiles = profiles.filter((profile) => profile.active);
  if (!activeProfiles.length) return null;
  return (
    <div className="border-b px-3 py-3" aria-label="Active chat browsers">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active chat browsers</h3>
      <div className="space-y-2">
        {activeProfiles.map((profile) => (
          <div key={profile.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  profile.activeConversationTitle ?? (profile.activeConversationId ? 'Active chat' : null),
                  profile.activeCloneCount ? `${profile.activeCloneCount} temporary ${profile.activeCloneCount === 1 ? 'copy' : 'copies'}` : null,
                ].filter(Boolean).join(' · ') || 'Active browser'}
              </p>
            </div>
            {profile.activeConversationId ? (
              <Button asChild variant="outline" size="sm">
                <a href={browserChatHref(projectId, profile.activeConversationId)} aria-label={`Open ${profile.activeConversationTitle ?? 'active chat'} browser`}>
                  Open <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function OtherPeoplesProfiles({
  profiles,
  busy,
  onDelete,
}: {
  profiles: VeneerBrowserOtherProfile[];
  busy: boolean;
  onDelete: (profile: VeneerBrowserOtherProfile) => void;
}) {
  if (!profiles.length) return null;
  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-t px-3 py-3" aria-label="Other people’s profiles">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other people’s profiles</h3>
      <p className="mb-2 mt-1 text-xs text-muted-foreground">
        You can delete these to clear out a stale login. Everything else stays with the person who saved it.
      </p>
      <div className="space-y-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile.name}</p>
              <p className="truncate text-xs text-muted-foreground">{profile.ownerName}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || profile.active}
              aria-label={`Delete ${profile.name} from ${profile.ownerName}`}
              onPointerUp={() => onDelete(profile)}
            >
              <Trash2 className="size-3.5" />Delete
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectBrowserPanel({
  projectId,
  isOwner = false,
  onClose,
  onToast,
}: {
  projectId: string;
  /** Owners also see other people's profiles, delete-only. The server agrees. */
  isOwner?: boolean;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [profiles, setProfiles] = useState<VeneerBrowserProfile[]>([]);
  const [others, setOthers] = useState<VeneerBrowserOtherProfile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? null,
    [profiles, selectedId],
  );

  const load = useCallback(async () => {
    const result = await api.veneerBrowserProfiles(projectId);
    setConfigured(result.configured);
    setProfiles(result.profiles);
    setOthers(result.others ?? []);
    setDefaultProfileId(result.defaultProfileId);
    setSelectedId((current) => result.profiles.some((profile) => profile.id === current)
      ? current
      : result.defaultProfileId ?? result.profiles[0]?.id ?? '');
  }, [projectId]);

  useEffect(() => { void load().catch((err: Error) => setError(err.message)); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load().catch(() => {}), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const action = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await task(); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const createProfile = () => {
    const name = window.prompt('Name this browser profile', 'New profile')?.trim();
    if (!name) return;
    void action(async () => {
      const { profile } = await api.createVeneerBrowserProfile(projectId, name);
      setSelectedId(profile.id);
      onToast(`Created “${profile.name}”`);
    });
  };

  const deleteOther = (profile: VeneerBrowserOtherProfile) => {
    if (!window.confirm(`Delete “${profile.name}” from ${profile.ownerName} and its saved login data? This cannot be undone.`)) return;
    void action(async () => {
      await api.deleteVeneerBrowserProfile(projectId, profile.id);
      onToast(`Deleted “${profile.name}”`);
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Veneer Browser profiles">
      <header className="flex min-h-14 items-center gap-2 border-b px-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Veneer Browser</h2>
          <p className="truncate text-xs text-muted-foreground">Your browser profiles</p>
        </div>
        <Button variant="ghost" size="icon" onPointerUp={onClose} aria-label="Close browser"><X className="size-4" /></Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2" aria-label="Your browser profiles">
        <select
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          value={selected?.id ?? ''}
          onChange={(event) => setSelectedId(event.target.value)}
          aria-label="Browser profile"
        >
          {profiles.length
            ? profiles.map((profile) => <option key={profile.id} value={profile.id}>
              {profile.name}{profile.id === defaultProfileId ? ' · default' : ''}
            </option>)
            : <option value="">No profiles</option>}
        </select>
        <Button variant="outline" size="icon" onPointerUp={createProfile} disabled={busy || !configured} aria-label="Create browser profile"><Plus className="size-4" /></Button>
        {selected ? <>
          {selected.id !== defaultProfileId ? <Button variant="outline" size="icon" disabled={busy} aria-label="Set as default profile" onPointerUp={() => void action(async () => {
            await api.selectVeneerBrowserProfile(projectId, selected.id);
            onToast(`Set “${selected.name}” as the default browser profile.`);
          })}><Star className="size-4" /></Button> : null}
          <Button variant="outline" size="icon" disabled={busy} aria-label="Rename profile" onPointerUp={() => {
            const name = window.prompt('Rename browser profile', selected.name)?.trim();
            if (name && name !== selected.name) void action(async () => { await api.renameVeneerBrowserProfile(projectId, selected.id, name); });
          }}><Pencil className="size-4" /></Button>
          <Button variant="outline" size="icon" disabled={busy || selected.active} aria-label="Delete profile" onPointerUp={() => {
            if (!window.confirm(`Delete “${selected.name}” and its saved login data? This cannot be undone.`)) return;
            void action(async () => { await api.deleteVeneerBrowserProfile(projectId, selected.id); onToast(`Deleted “${selected.name}”`); });
          }}><Trash2 className="size-4" /></Button>
        </> : null}
      </div>

      {!configured ? <div className="m-4 rounded-xl border p-4 text-sm text-muted-foreground">Veneer Browser is not configured on this client.</div> : null}
      {error ? <div className="m-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      <ActiveBrowserSessions projectId={projectId} profiles={profiles} />
      {!selected && configured ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center"><div>
          <p className="text-sm text-muted-foreground">Create a saved login profile. You can attach it to a chat when you need it.</p>
          <Button className="mt-3" onPointerUp={createProfile}><Plus className="mr-1 size-4" />Create profile</Button>
        </div></div>
      ) : selected ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center"><div className="max-w-sm">
          <p className="font-medium">{selected.name}</p>
          {selected.id === defaultProfileId ? <p className="mt-1 text-xs font-medium text-primary">Default profile</p> : null}
          <p className="mt-1 text-sm text-muted-foreground">
            {selected.active
              ? [
                selected.activeConversationTitle ? `In use by “${selected.activeConversationTitle}”` : 'In use',
                selected.activeCloneCount ? `${selected.activeCloneCount} temporary ${selected.activeCloneCount === 1 ? 'copy' : 'copies'}` : null,
              ].filter(Boolean).join(' · ')
              : 'Ready to attach to a chat. Saved login data stays with this profile.'}
          </p>
          {selected.active ? (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {selected.activeConversationId ? (
                <Button asChild variant="outline">
                  <a href={browserChatHref(projectId, selected.activeConversationId)}>
                    Open chat <ExternalLink className="size-4" />
                  </a>
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy} onPointerUp={() => void action(async () => {
                await api.stopVeneerBrowserProfile(projectId, selected.id);
              })}><CircleStop className="mr-1 size-4" />Stop safely</Button>
            </div>
          ) : null}
        </div></div>
      ) : null}
      {isOwner ? <OtherPeoplesProfiles profiles={others} busy={busy} onDelete={deleteOther} /> : null}
    </section>
  );
}
