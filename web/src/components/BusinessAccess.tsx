import { useState } from 'react';
import { botsApi, type BusinessTeam } from '@/lib/bots';
import { Button } from './ui/button';
export function BusinessAccess({ team, onChanged }: { team: BusinessTeam; onChanged: () => void }) {
  const [users, setUsers] = useState<{ id: number; display_name: string }[]>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('viewer');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = async (id: number, next: string | null) => {
    setBusy(true);
    setError('');
    try {
      await botsApi.manageTeam({ action: 'member', team_id: team.id, user_id: id, role: next });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update access');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="group [&[open]]:basis-full [&[open]]:rounded-xl [&[open]]:border [&[open]]:p-4"
      onToggle={(e) => {
        if (e.currentTarget.open)
          void botsApi
            .candidates()
            .then((r) => setUsers(r.users))
            .catch((e) => setError(e.message));
      }}
    >
      <summary className="cursor-pointer list-none rounded-full border px-3 py-1.5 text-xs font-medium group-open:mb-1 group-open:inline-block group-open:border-0 group-open:px-0 group-open:py-0 group-open:text-sm">
        <span className="group-open:hidden">Manage access</span>
        <span className="hidden group-open:inline">{team.name} business access</span>
      </summary>
      <p className="my-3 text-xs text-muted-foreground">
        Access applies only to this business. Viewers can read; members can chat; managers can
        manage chats. Only the owner changes business access. Assigned decision approval remains
        separate.
      </p>
      {team.members.map((m) => (
        <div key={m.user_id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>
            {m.display_name} · {m.role}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void update(m.user_id, null)}
          >
            Remove access
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Employee"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="min-w-0 rounded-lg border bg-background p-2 text-sm"
        >
          <option value="">Choose an employee</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select>
        <select
          aria-label="Business role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border bg-background p-2 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="member">Member</option>
          <option value="manager">Manager</option>
        </select>
        <Button
          size="sm"
          disabled={busy || !userId}
          onClick={() => void update(Number(userId), role)}
        >
          Save access
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </details>
  );
}
