import { useMemo } from 'react';
import type { FileContents, FileOptions } from '@pierre/diffs';
import { File, Virtualizer } from '@pierre/diffs/react';
import { CodeHighlightProvider } from './CodeHighlightProvider';

const FILE_OPTIONS: FileOptions<undefined> = {
  disableFileHeader: true,
  overflow: 'scroll',
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: 'system',
};

export function CodeFileSurface({
  fileName,
  content,
  cacheKey,
}: {
  fileName: string;
  content: string;
  cacheKey?: string;
}) {
  const file = useMemo<FileContents>(
    () => ({ name: fileName, contents: content, cacheKey }),
    [cacheKey, content, fileName],
  );

  return (
    <CodeHighlightProvider>
      <Virtualizer
        className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
        contentClassName="min-w-max"
      >
        <File file={file} options={FILE_OPTIONS} />
      </Virtualizer>
    </CodeHighlightProvider>
  );
}
