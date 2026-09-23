import { useEffect, useState } from 'react';
import { requestJson } from './api';
import type { BotFeatureCatalog } from '../../../server/src/featureGuide/catalog';
export type { BotFeatureCatalog };

/** Refresh on focus so an already-open workspace discovers later releases. */
export function useBotGuide() {
  const [catalog, setCatalog] = useState<BotFeatureCatalog | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      void requestJson<BotFeatureCatalog>('/api/bot-workflows/guide').then(value => {
        if (active) { setCatalog(value); setError(''); }
      }).catch(() => { if (active) setError('Could not load the guide. Please try again.'); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [attempt]);
  return { catalog, error, retry: () => setAttempt(value => value + 1) };
}

export function filterBotFeatures(catalog: BotFeatureCatalog, query: string, onlyNew: boolean) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return catalog.features.filter(feature => (!onlyNew || feature.isNew) && words.every(word =>
    [feature.title, feature.category, feature.summary, feature.audience, feature.example, feature.limits, ...feature.steps]
      .join(' ').toLocaleLowerCase().includes(word)));
}
