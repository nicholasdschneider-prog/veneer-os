import { useEffect, useSyncExternalStore } from 'react';
import { api, type ChatListIconMode } from './api';

interface ChatAppearanceSnapshot {
  listIcon: ChatListIconMode;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

let snapshot: ChatAppearanceSnapshot = {
  listIcon: 'provider',
  loaded: false,
  loading: false,
  saving: false,
  error: null,
};
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(patch: Partial<ChatAppearanceSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentSnapshot(): ChatAppearanceSnapshot {
  return snapshot;
}

export function loadChatAppearance(): Promise<void> {
  if (snapshot.loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  publish({ loading: true, error: null });
  loadPromise = api
    .chatAppearanceSettings()
    .then((result) => publish({ listIcon: result.settings.listIcon }))
    .catch((error: unknown) => {
      publish({ error: error instanceof Error ? error.message : 'Chat appearance could not be loaded.' });
    })
    .finally(() => {
      publish({ loaded: true, loading: false });
      loadPromise = null;
    });
  return loadPromise;
}

export async function updateChatListIcon(listIcon: ChatListIconMode): Promise<void> {
  const previous = snapshot.listIcon;
  publish({ listIcon, saving: true, error: null });
  try {
    const result = await api.updateChatAppearanceSettings({ listIcon });
    publish({ listIcon: result.settings.listIcon, loaded: true, saving: false });
  } catch (error) {
    publish({
      listIcon: previous,
      loaded: true,
      saving: false,
      error: error instanceof Error ? error.message : 'Chat appearance could not be saved.',
    });
  }
}

export function useChatAppearance(): ChatAppearanceSnapshot {
  const value = useSyncExternalStore(subscribe, currentSnapshot, currentSnapshot);
  useEffect(() => {
    void loadChatAppearance();
  }, []);
  return value;
}

export type { ChatListIconMode };
