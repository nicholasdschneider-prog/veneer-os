import { useEffect, useState } from 'react';
import type { BusinessTeam } from '@/lib/bots';
const key = 'veneer:selected-business';
export function useBusinessSelection() {
  const [business, setBusiness] = useState(() => localStorage.getItem(key) ?? '');
  useEffect(() => {
    const sync = () => setBusiness(localStorage.getItem(key) ?? '');
    window.addEventListener('business-selection', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('business-selection', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const select = (id: string) => {
    localStorage.setItem(key, id);
    setBusiness(id);
    window.dispatchEvent(new Event('business-selection'));
  };
  return { business, select };
}
export function BusinessSelector({
  teams,
  business,
  onSelect,
  compact = false,
}: {
  teams: BusinessTeam[];
  business: string;
  onSelect: (id: string) => void;
  /** A bare pill-shaped select with no caption, for a one-line toolbar. */
  compact?: boolean;
}) {
  useEffect(() => {
    if (teams.length && localStorage.getItem(key) === null) onSelect(teams[0]!.id);
  }, [teams]);
  if (!teams.length) return null;
  if (compact)
    return (
      <select
        aria-label="Business"
        value={business}
        onChange={(e) => onSelect(e.target.value)}
        className="max-w-[11rem] rounded-full border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
      >
        <option value="">All businesses</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    );
  return (
    <label className="block text-xs text-muted-foreground">
      Business
      <select
        aria-label="Business"
        value={business}
        onChange={(e) => onSelect(e.target.value)}
        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground"
      >
        <option value="">All accessible businesses</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
