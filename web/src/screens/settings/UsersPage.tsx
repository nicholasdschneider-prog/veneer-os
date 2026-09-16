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

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-sm text-muted-foreground">
        People who've signed in. Approve pending accounts, choose who's an admin, and disable access.
      </p>

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
                <UserRow key={u.id} user={u} isYou={u.id === meId} busy={busyId === u.id} onPatch={patch} />
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
}: {
  user: AdminUser;
  isYou: boolean;
  busy: boolean;
  onPatch: (id: number, body: { role?: 'owner' | 'member'; status?: AdminUser['status'] }) => void;
}) {
  const badge = STATUS_BADGE[user.status];
  // A legacy consultant can't be represented in the Admin/Member select, so
  // show their role as a label instead (they're never offered as a choice).
  const editableRole = !isYou && user.status === 'active' && user.role !== 'consultant';

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
        {isYou ? null : user.status === 'pending' ? (
          <Button size="sm" className="rounded-lg" onPointerUp={() => onPatch(user.id, { status: 'active' })} disabled={busy}>
            {busy ? 'Approving…' : 'Approve'}
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
