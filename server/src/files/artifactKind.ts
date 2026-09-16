import path from 'node:path';

export type ArtifactKind = 'csv' | 'tsv' | 'image' | 'pdf' | 'html' | 'code' | 'text' | 'other';

const CODE_EXTENSIONS = new Set([
  '.astro', '.bash', '.c', '.cjs', '.clj', '.cljs', '.cpp', '.cs', '.css', '.dart',
  '.ex', '.exs', '.fish', '.go', '.graphql', '.gql', '.h', '.hcl', '.hpp', '.java',
  '.js', '.json', '.json5', '.jsonc', '.jsx', '.kt', '.kts', '.less', '.lua', '.mjs',
  '.php', '.pl', '.prisma', '.py', '.r', '.rb', '.rs', '.sass', '.scala', '.scss',
  '.sh', '.sol', '.sql', '.svelte', '.swift', '.tf', '.toml', '.ts', '.tsx', '.vue',
  '.xml', '.yaml', '.yml', '.zsh',
]);

const CODE_BASENAMES = new Set(['dockerfile', 'gemfile', 'makefile', 'procfile']);

/** Classify generated files for the chat artifact viewer. */
export function artifactKind(fileName: string): ArtifactKind {
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (CODE_EXTENSIONS.has(ext) || CODE_BASENAMES.has(base)) return 'code';
  if (['.txt', '.md', '.markdown', '.log'].includes(ext)) return 'text';
  return 'other';
}
