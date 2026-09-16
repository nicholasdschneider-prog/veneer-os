// DB dates arrive as 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO.
export function parsePageDate(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function pageExpiryLabel(expiresAt: string | undefined, now: number = Date.now()): string {
  if (!expiresAt) return '7-day expiry';
  const remainingMs = parsePageDate(expiresAt).getTime() - now;
  if (remainingMs <= 0) return 'Expired';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `Expires in ${hours}h`;
  const days = Math.ceil(hours / 24);
  return `Expires in ${days}d`;
}

export function pageExpiryDate(expiresAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsePageDate(expiresAt),
  );
}

export function pageExpiresSoon(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const remainingMs = parsePageDate(expiresAt).getTime() - now;
  return remainingMs <= 24 * 60 * 60 * 1000;
}
