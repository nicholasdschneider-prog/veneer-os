export const DEFAULT_PAGE_TITLE = 'Veneer Pro';

export function pageTitle(clientName: string | null | undefined): string {
  const normalized = clientName?.trim();
  return normalized ? `${DEFAULT_PAGE_TITLE} — ${normalized}` : DEFAULT_PAGE_TITLE;
}

export function applyPageTitle(
  clientName: string | null | undefined,
  target: Pick<Document, 'title'> = document,
): void {
  target.title = pageTitle(clientName);
}
