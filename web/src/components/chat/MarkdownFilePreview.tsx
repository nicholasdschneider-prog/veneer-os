import { Markdown, MarkdownDocumentImageContext } from '../Markdown';
import { cn } from '../../lib/utils';

const MARKDOWN_FILE_RE = /\.(?:md|markdown)$/i;

export function isMarkdownFileName(fileName: string): boolean {
  return MARKDOWN_FILE_RE.test(fileName.trim());
}

/** Render a local Markdown file with the same sanitized renderer as chat prose. */
export function MarkdownFilePreview({
  content,
  imageBaseUrl,
  className,
}: {
  content: string;
  imageBaseUrl: string;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full max-w-4xl p-4 sm:p-8', className)}>
      <MarkdownDocumentImageContext.Provider value={imageBaseUrl}>
        <Markdown markdown={content} />
      </MarkdownDocumentImageContext.Provider>
    </div>
  );
}
