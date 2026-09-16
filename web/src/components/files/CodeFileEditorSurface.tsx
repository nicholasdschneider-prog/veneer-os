import { useMemo } from 'react';
import type { FileContents, FileOptions } from '@pierre/diffs';
import { Editor, type EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, File, type CreateEditor, Virtualizer } from '@pierre/diffs/react';
import { CodeHighlightProvider } from '../chat/CodeHighlightProvider';

const FILE_OPTIONS: FileOptions<undefined> = {
  disableFileHeader: true,
  overflow: 'scroll',
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: 'system',
};

const createEditor: CreateEditor<undefined> = (options) => new Editor(options);

export function CodeFileEditorSurface({
  fileName,
  content,
  cacheKey,
  line,
  column,
  onChange,
}: {
  fileName: string;
  content: string;
  cacheKey: string;
  line?: number;
  column?: number;
  onChange: (content: string) => void;
}) {
  const file = useMemo<FileContents>(
    () => ({ name: fileName, contents: content, cacheKey }),
    [cacheKey, content, fileName],
  );
  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      onAttach(editor) {
        editor.focus(
          line
            ? { lineNumber: line, character: Math.max(0, (column ?? 1) - 1) }
            : { lineNumber: 'first-visible', preventScroll: true },
        );
      },
      onChange(nextFile) {
        onChange(nextFile.contents);
      },
    }),
    [column, line, onChange],
  );

  return (
    <CodeHighlightProvider>
      <EditProvider createEditor={createEditor}>
        <Virtualizer
          className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
          contentClassName="min-w-max"
        >
          <File file={file} options={FILE_OPTIONS} edit editorOptions={editorOptions} />
        </Virtualizer>
      </EditProvider>
    </CodeHighlightProvider>
  );
}
