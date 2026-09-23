import { useEffect, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { filterBotFeatures, useBotGuide } from '@/lib/botGuide';

export function BotGuide({ hash, onNavigate }: { hash: string; onNavigate: (hash: string) => void }) {
  const { catalog, error, retry } = useBotGuide();
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const onlyNew = params.get('new') === '1';
  const selectedId = params.get('feature');
  const features = catalog ? filterBotFeatures(catalog, query, onlyNew) : [];
  useEffect(() => {
    if (selectedId && catalog) document.getElementById(`feature-${selectedId}`)?.scrollIntoView({ block: 'start' });
  }, [selectedId, catalog]);
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(message); }
    catch { setCopied('Copy unavailable. Select the example text or copy this page’s address.'); }
  };
  return <div className="h-full overflow-y-auto bg-background">
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
      <header className="border-b pb-7">
        <button className="mb-5 min-h-9 text-sm text-muted-foreground underline underline-offset-4" onClick={() => onNavigate('#/bots')}>Back to Chats</button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><BookOpen className="size-4" /> The employee handbook</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Work with your VeneerBots</h1>
          </div>
          <Button variant="outline" onClick={() => void copy(`${window.location.origin}${window.location.pathname}#/bot-guide`, 'Guide link copied.')}>Copy guide link</Button>
        </div>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">Know what’s available. Learn the steps. Give your bot a clear request. This guide grows as features ship, and bots receive the same capability updates in their working instructions.</p>
        {catalog && <p className="mt-3 text-xs text-muted-foreground">Updated {catalog.updated} · {catalog.features.length} features · New callouts stay for 30 days</p>}
      </header>
      <section aria-label="Find a feature" className="sticky top-0 z-10 space-y-3 border-b bg-background py-4">
        <label className="flex items-center gap-2 rounded-lg border bg-card px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only">Search the bot guide</span>
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search a task, feature, or question…" className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={!onlyNew ? 'secondary' : 'ghost'} aria-pressed={!onlyNew} onClick={() => onNavigate('#/bot-guide')}>All features</Button>
          <Button variant={onlyNew ? 'secondary' : 'ghost'} aria-pressed={onlyNew} onClick={() => onNavigate('#/bot-guide?new=1')}>New features{catalog ? ` (${catalog.features.filter(feature => feature.isNew).length})` : ''}</Button>
          <span role="status" className="text-xs text-muted-foreground">{catalog ? `${features.length} results` : 'Loading guide…'}</span>
        </div>
      </section>
      <p role="status" className="mt-2 text-sm">{copied}</p>
      {error && <div role="alert" className="my-4 rounded-lg border p-4 text-sm">{error} <Button variant="outline" onClick={retry}>Try again</Button></div>}
      {catalog && features.length === 0 && <p className="py-12 text-muted-foreground">{query ? 'No matching features. Try “schedule,” “approval,” or “browser.”' : 'No new features in the last 30 days. Browse all features for the full guide.'}</p>}
      <div className="divide-y">
        {features.map(feature => <article key={feature.id} id={`feature-${feature.id}`} className="scroll-mt-44 py-7 sm:py-9">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{feature.category}</span><span aria-hidden="true">·</span><span>{feature.audience}</span>
            {feature.isNew && <span className="rounded-full bg-primary px-2 py-1 font-semibold text-primary-foreground">New · {feature.updated}</span>}
          </div>
          <h2 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">{feature.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.summary}</p>
          {feature.isNew && <p className="mt-3 border-l-2 border-primary pl-3 text-sm leading-relaxed">{feature.announcement}</p>}
          <div className="mt-5 grid gap-6 md:grid-cols-[1.3fr_1fr]">
            <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
              {feature.steps.map(step => <li key={step} className="pl-1">{step}</li>)}
            </ol>
            <div className="self-start rounded-xl bg-muted/50 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Try asking</h3>
              <blockquote className="mt-3 break-words text-sm leading-relaxed">“{feature.example}”</blockquote>
              <Button className="mt-3" size="sm" variant="outline" aria-label={`Copy example for ${feature.title}`} onClick={() => void copy(feature.example, `Example copied: ${feature.title}.`)}>Copy example</Button>
            </div>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground"><span className="font-medium text-foreground">Before you start: </span>{feature.limits}</p>
          <a className="mt-3 inline-flex min-h-9 items-center text-xs text-muted-foreground underline underline-offset-4" href={`#/bot-guide?feature=${feature.id}`}>Link to this feature</a>
        </article>)}
      </div>
      <footer className="border-t py-6 text-sm leading-relaxed text-muted-foreground">Features follow your existing permissions. If a control is missing, ask your business owner to check your role or bot assignment. You can always ask your bot which feature fits the task.</footer>
    </div>
  </div>;
}
