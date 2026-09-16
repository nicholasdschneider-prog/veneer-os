import { lazy, Suspense } from 'react';
import { cn } from '../../lib/utils';

const CodeFileSurface = lazy(() =>
  import('./CodeFileSurface').then((module) => ({ default: module.CodeFileSurface })),
);

const CODE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'c',
  'cjs',
  'clj',
  'cljs',
  'cpp',
  'cs',
  'css',
  'dart',
  'ex',
  'exs',
  'fish',
  'go',
  'graphql',
  'gql',
  'h',
  'hcl',
  'hpp',
  'java',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'lua',
  'mjs',
  'php',
  'pl',
  'prisma',
  'py',
  'r',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sol',
  'sql',
  'svelte',
  'swift',
  'tf',
  'toml',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const CODE_BASENAMES = new Set([
  'dockerfile',
  'gemfile',
  'makefile',
  'procfile',
]);

export function isCodeFileName(fileName: string): boolean {
  const name = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (CODE_BASENAMES.has(name)) return true;
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : '';
  return CODE_EXTENSIONS.has(extension);
}

export function CodeFilePreview({
  fileName,
  content,
  cacheKey,
  className,
}: {
  fileName: string;
  content: string;
  cacheKey?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 bg-card', className)}>
      <Suspense
        fallback={<p className="p-4 text-sm text-muted-foreground">Preparing code viewer…</p>}
      >
        <CodeFileSurface fileName={fileName} content={content} cacheKey={cacheKey} />
      </Suspense>
    </div>
  );
}
