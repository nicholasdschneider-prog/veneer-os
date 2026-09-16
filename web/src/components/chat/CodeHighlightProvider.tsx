import type { ReactNode } from 'react';
import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from '@pierre/diffs/react';
import { createDiffsWorker } from './diffsWorker';

const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: createDiffsWorker,
  poolSize: 2,
  totalASTLRUCacheSize: 40,
};

const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  langs: ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'html', 'markdown'],
  tokenizeMaxLineLength: 2_000,
};

/** Shared worker-backed highlighting boundary for lazily loaded code surfaces. */
export function CodeHighlightProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
