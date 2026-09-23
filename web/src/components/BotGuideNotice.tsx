import { useBotGuide } from '@/lib/botGuide';

export function BotGuideNotice({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const { catalog } = useBotGuide();
  const recent = catalog?.features.filter(feature => feature.isNew) ?? [];
  return <aside aria-label="Bot feature updates" className="mb-6 rounded-xl border bg-muted/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{recent.length ? 'New ways to work with your bots' : 'Get more from your bots'}</p>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{recent.length
          ? `${recent.slice(0, 3).map(feature => feature.title).join(' · ')}${recent.length > 3 ? ` · +${recent.length - 3} more` : ''}`
          : 'Step-by-step feature instructions, example requests, and setup requirements.'}</p>
      </div>
      <button className="min-h-11 shrink-0 rounded-lg border bg-background px-4 text-sm font-medium hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onNavigate(recent.length ? '#/bot-guide?new=1' : '#/bot-guide')}>
        {recent.length ? `See what’s new (${recent.length})` : 'Open Bot guide'}
      </button>
    </div>
    {recent.length > 0 && <button className="mt-2 min-h-9 text-sm underline underline-offset-4" onClick={() => onNavigate('#/bot-guide')}>Browse all features</button>}
  </aside>;
}
