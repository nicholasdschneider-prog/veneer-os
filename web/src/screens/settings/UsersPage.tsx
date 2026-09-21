import { botsApi, type Bot } from '@/lib/bots';
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminUser } from '../../lib/api';
import { Button } from '@/components/ui/button';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Admin',
  member: 'Member',
  consultant: 'Consultant', // legacy — displayed but never offered as a choice
};

const STATUS_BADGE: Record<AdminUser['status'], { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  active: { label: 'Active', cls: 'bg-accent text-brand' },
  disabled: { label: 'Disabled', cls: 'bg-destructive/10 text-destructive' },
};

/** Short date; normalizes SQLite-style timestamps (space, no zone). */
function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Settings → People & access (owner only). One table row per user: approve pending
 * accounts, change roles (Admin/Member), and disable or re-enable access.
 * Fetches its own data — /api/me identifies which row is you (no actions on
 * your own account; the server rejects it anyway).
 */
export function UsersPage() {
  const [accessUser, setAccessUser] = useState<AdminUser | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [meId, setMeId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    void Promise.all([api.adminListUsers().then((r) => r.users), api.me()])
      .then(([list, me]) => {
        setUsers(list);
        setMeId(me.user?.id ?? null);
        setLoadError(null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);
  useEffect(load, [load]);

  const patch = useCallback(
    async (id: number, body: { role?: 'owner' | 'member'; status?: AdminUser['status'] }) => {
      setBusyId(id);
      setActionError(null);
      try {
        const r = await api.adminUpdateUser(id, body);
        setUsers((prev) => (prev ? prev.map((u) => (u.id === id ? r.user : u)) : prev));
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const openAccess = async (user: AdminUser) => {
    setActionError(null);
    try {
      const list = await botsApi.list('all');
      setBots(list.bots.filter(b => b.business_team_id && !b.archived));
      setChosen(user.employeeWorkspace ? (user.allowedBotIds ?? []) : list.bots.filter(b => b.membership?.subteam === 'Customer Service').map(b => b.conversation_id));
      setAccessUser(user);
    } catch (e) { setActionError((e as Error).message); }
  };
  const saveAccess = async () => {
    if (!accessUser) return;
    setBusyId(accessUser.id); setActionError(null);
    try {
      const selected = bots.filter(b => chosen.includes(b.conversation_id));
      const teamIds = new Set(selected.map(b => b.business_team_id));
      if (!selected.length || teamIds.size !== 1) throw new Error('Choose bots from one business.');
      await botsApi.manageTeam({ action: 'employee', team_id: selected[0]!.business_team_id, user_id: accessUser.id, email: accessUser.email, conversation_ids: chosen, activate: true });
      setAccessUser(null); load();
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusyId(null); }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-muted-foreground">
        People who've signed in. Approve pending accounts, choose who's an admin, and disable access.
      </p>

      <form className="flex flex-wrap items-end gap-3 rounded-xl border p-4" onSubmit={e => {
        e.preventDefault(); setActionError(null);
        void api.adminCreateUser(newEmail, newName).then(r => { load(); setNewEmail(''); setNewName(''); return openAccess(r.user); }).catch(e => setActionError(e.message));
      }}>
        <label className="text-sm">Name<input required value={newName} onChange={e => setNewName(e.target.value)} className="mt-1 block rounded-lg border bg-background p-2" /></label>
        <label className="text-sm">Work email<input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="mt-1 block rounded-lg border bg-background p-2" /></label>
        <Button type="submit">Add employee</Button>
        <p className="basis-full text-xs text-muted-foreground">Creates a pending account. Choose bot access before approval. Their email must also be allowed by your sign-in policy.</p>
      </form>
      {accessUser && <section className="space-y-3 rounded-xl border p-4" aria-label="Employee bot access">
        <h2 className="font-semibold">Bot access for {accessUser.email}</h2>
        <p className="text-sm text-muted-foreground">Only selected bots and their questions will be available. This replaces their bot selection in this business. They can share question handling with you.</p>
        <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="sr-only">Allowed bots</legend>
          {bots.map(bot => <label key={bot.conversation_id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={chosen.includes(bot.conversation_id)} onChange={e => setChosen(prev => e.target.checked ? [...prev, bot.conversation_id] : prev.filter(id => id !== bot.conversation_id))} />
            {bot.name} · {bot.membership?.subteam || 'Business team'}
          </label>)}
        </fieldset>
        <div className="flex gap-2"><Button disabled={busyId !== null || chosen.length === 0} onClick={() => void saveAccess()}>Approve with selected bots</Button><Button variant="outline" onClick={() => setAccessUser(null)}>Cancel</Button></div>
      </section>}
      {loadError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{loadError}</div>
      ) : null}
      {actionError ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{actionError}</div>
      ) : null}

      {users === null && !loadError ? (
        <p className="px-1 text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {users ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-card shadow-[0_1px_0_var(--border)]">
              <tr>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">User</th>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">Role</th>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">Status</th>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">Joined</th>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">Last seen</th>
                <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} isYou={u.id === meId} busy={busyId === u.id} onPatch={patch} onAccess={u => void openAccess(u)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function UserRow({
  user,
  isYou,
  busy,
  onPatch,
  onAccess,
}: {
  user: AdminUser;
  isYou: boolean;
  busy: boolean;
  onAccess: (user: AdminUser) => void;
  onPatch: (id: number, body: { role?: 'owner' | 'member'; status?: AdminUser['status'] }) => void;
}) {
  const badge = STATUS_BADGE[user.status];
  // A legacy consultant can't be represented in the Admin/Member select, so
  // show their role as a label instead (they're never offered as a choice).
  const editableRole = !user.employeeWorkspace && !isYou && user.status === 'active' && user.role !== 'consultant';

  return (
    <tr className="border-t first:border-t-0 odd:bg-muted/40">
      <td className="px-3 py-2.5 align-middle">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="min-w-0 truncate">{user.displayName || user.email}</span>
            {isYou ? <span className="shrink-0 text-xs font-normal text-muted-foreground">You</span> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 align-middle whitespace-nowrap">
        {editableRole ? (
          <select
            value={user.role === 'owner' ? 'owner' : 'member'}
            onChange={(e) => onPatch(user.id, { role: e.target.value as 'owner' | 'member' })}
            disabled={busy}
            aria-label={`Role for ${user.email}`}
            className="rounded-lg border bg-card px-2 py-1 outline-none focus:border-ring"
          >
            <option value="owner">Admin</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <span className="text-muted-foreground">{ROLE_LABEL[user.role] ?? user.role}</span>
        )}
      </td>
      <td className="px-3 py-2.5 align-middle whitespace-nowrap">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
      </td>
      <td className="px-3 py-2.5 align-middle whitespace-nowrap text-muted-foreground">{formatDate(user.createdAt)}</td>
      <td className="px-3 py-2.5 align-middle whitespace-nowrap text-muted-foreground">
        {formatDate(user.lastSeenAt)}
      </td>
      <td className="px-3 py-2.5 text-right align-middle whitespace-nowrap">
        {!isYou && user.role === 'member' && user.status !== 'disabled' && <Button className="mr-2" size="sm" variant="outline" disabled={busy} onClick={() => onAccess(user)}>{user.employeeWorkspace ? 'Edit bot access' : 'Set bot access'}</Button>}
        {isYou ? null : user.status === 'pending' ? (
          <Button size="sm" className="rounded-lg" onPointerUp={() => onPatch(user.id, { status: 'active' })} disabled={busy}>
            {busy ? 'Approving…' : 'Approve full workspace'}
          </Button>
        ) : user.status === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
            onPointerUp={() => onPatch(user.id, { status: 'disabled' })}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Disable'}
          </Button>
        ) : (
          <Button size="sm" className="rounded-lg" onPointerUp={() => onPatch(user.id, { status: 'active' })} disabled={busy}>
            {busy ? 'Enabling…' : 'Enable'}
          </Button>
        )}
      </td>
    </tr>
  );
}
