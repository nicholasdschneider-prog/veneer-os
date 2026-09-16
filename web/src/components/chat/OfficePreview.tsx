import { useEffect, useState, type ReactNode } from 'react';
import { FileWarning, Image as ImageIcon } from 'lucide-react';
import {
  fetchOfficePreview,
  type DocxBlock,
  type DocxParagraph,
  type DocxRun,
  type OfficePreview as OfficePreviewData,
  type XlsxCell,
  type XlsxPreview,
} from '../../lib/officePreview';

interface OfficePreviewProps {
  fileName: string;
  url: string;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: OfficePreviewData };

const LIST_INDENTS = ['pl-0', 'pl-5', 'pl-10', 'pl-14', 'pl-18', 'pl-22', 'pl-26', 'pl-30', 'pl-34'];

function renderRun(run: DocxRun, index: number): ReactNode {
  if (run.break === 'line') return <br key={index} />;
  if (run.break === 'page') {
    return (
      <span key={index} className="my-3 block border-t border-dashed pt-1 text-[10px] font-normal text-muted-foreground">
        Page break
      </span>
    );
  }
  let content: ReactNode = run.image ? (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      <ImageIcon className="size-3.5" aria-hidden="true" />
      {run.text}
    </span>
  ) : (
    run.text
  );
  if (run.code) content = <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{content}</code>;
  if (run.strike) content = <del>{content}</del>;
  if (run.italic) content = <em>{content}</em>;
  if (run.bold) content = <strong>{content}</strong>;
  if (run.href) {
    content = (
      <a href={run.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
        {content}
      </a>
    );
  }
  return <span key={index}>{content}</span>;
}

function DocxParagraphView({ paragraph, listNumber }: { paragraph: DocxParagraph; listNumber?: number }) {
  const content = paragraph.runs.length ? paragraph.runs.map(renderRun) : <br />;
  if (paragraph.list) {
    return (
      <div
        className={`flex gap-2 ${LIST_INDENTS[paragraph.list.level] ?? LIST_INDENTS[8]}`}
      >
        <span className="w-5 shrink-0 text-right text-muted-foreground" aria-hidden="true">
          {paragraph.list.ordered ? `${listNumber ?? 1}.` : '•'}
        </span>
        <p className="min-w-0 flex-1 leading-6">{content}</p>
      </div>
    );
  }
  switch (paragraph.style) {
    case 'title':
      return <h1 className="mb-6 font-serif text-3xl font-bold leading-tight">{content}</h1>;
    case 'heading1':
      return <h1 className="mt-7 mb-3 font-serif text-2xl font-bold leading-tight">{content}</h1>;
    case 'heading2':
      return <h2 className="mt-6 mb-2 font-serif text-xl font-bold leading-tight">{content}</h2>;
    case 'heading3':
      return <h3 className="mt-5 mb-2 text-lg font-bold leading-tight">{content}</h3>;
    case 'heading4':
      return <h4 className="mt-4 mb-2 font-semibold">{content}</h4>;
    case 'heading5':
      return <h5 className="mt-4 mb-2 text-sm font-semibold">{content}</h5>;
    case 'heading6':
      return <h6 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide">{content}</h6>;
    default:
      return <p className="mb-3 leading-6">{content}</p>;
  }
}

function DocxBlocks({ blocks }: { blocks: DocxBlock[] }) {
  const listCounters = new Map<number, number>();
  return blocks.map((block, index) => {
    if (block.kind === 'paragraph') {
      if (!block.list) {
        listCounters.clear();
        return <DocxParagraphView key={index} paragraph={block} />;
      }
      for (const level of listCounters.keys()) {
        if (level > block.list.level) listCounters.delete(level);
      }
      const listNumber = block.list.ordered ? (listCounters.get(block.list.level) ?? 0) + 1 : undefined;
      if (listNumber !== undefined) listCounters.set(block.list.level, listNumber);
      return <DocxParagraphView key={index} paragraph={block} listNumber={listNumber} />;
    }
    listCounters.clear();
    if (block.kind === 'pageBreak') {
      return (
        <div key={index} className="my-8 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="h-px flex-1 border-t border-dashed" />
          Page break
          <span className="h-px flex-1 border-t border-dashed" />
        </div>
      );
    }
    return (
      <div key={index} className="my-5 overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={row.header ? 'bg-muted/70' : 'even:bg-muted/25'}>
                {row.cells.map((cell, cellIndex) => {
                  const Cell = row.header ? 'th' : 'td';
                  return (
                    <Cell key={cellIndex} className="min-w-28 border-r border-b p-2 text-left align-top last:border-r-0">
                      <DocxBlocks blocks={cell.blocks} />
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

function DocxDocument({ preview }: { preview: Extract<OfficePreviewData, { kind: 'docx' }> }) {
  return (
    <div className="min-h-full w-full min-w-0 flex-1 bg-muted/30 px-3 py-5 sm:px-8">
      <article className="mx-auto min-h-[60dvh] max-w-[52rem] rounded-sm bg-white px-6 py-8 text-[15px] text-[#26221c] shadow-sm sm:px-12 sm:py-12">
        <DocxBlocks blocks={preview.blocks} />
        {!preview.blocks.length ? <p className="text-sm text-muted-foreground">This document is empty.</p> : null}
      </article>
      {preview.truncated ? (
        <p className="mx-auto mt-3 max-w-[52rem] text-xs text-muted-foreground">
          The preview reached its safe content limit. Download the file to view the rest.
        </p>
      ) : null}
    </div>
  );
}

function columnLabel(index: number): string {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function cellClass(cell: XlsxCell): string {
  if (cell.type === 'formula') return 'font-mono text-primary';
  if (cell.type === 'number' || cell.type === 'date') return 'tabular-nums';
  if (cell.type === 'error') return 'font-mono text-destructive';
  return '';
}

function XlsxDocument({ preview }: { preview: XlsxPreview }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeSheet = preview.sheets[activeIndex] ?? preview.sheets[0]!;
  let columnCount = 0;
  for (const row of activeSheet.rows) columnCount = Math.max(columnCount, row.cells.length);

  return (
    <div className="flex min-h-full w-full min-w-0 flex-1 flex-col bg-card">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 px-2 pt-2" role="tablist" aria-label="Workbook sheets">
        {preview.sheets.map((sheet, index) => (
          <button
            key={`${sheet.name}-${index}`}
            type="button"
            role="tab"
            aria-selected={index === activeIndex}
            onClick={() => setActiveIndex(index)}
            className={`shrink-0 rounded-t-lg border border-b-0 px-3 py-2 text-xs font-medium ${
              index === activeIndex ? 'bg-card text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {sheet.name}
            {sheet.state !== 'visible' ? <span className="ml-1 text-[10px]">({sheet.state})</span> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {activeSheet.rows.length ? (
          <table className="border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="sticky left-0 z-30 h-7 min-w-10 border-r border-b bg-muted px-2 text-right font-medium text-muted-foreground" />
                {Array.from({ length: columnCount }, (_, column) => (
                  <th key={column} className="h-7 min-w-28 border-r border-b bg-muted px-2 text-center font-medium text-muted-foreground">
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeSheet.rows.map((row, rowPosition) => (
                <tr key={row.index} className={rowPosition === 0 ? 'font-semibold' : 'even:bg-muted/20'}>
                  <th className="sticky left-0 z-10 min-w-10 border-r border-b bg-muted px-2 py-1.5 text-right font-medium text-muted-foreground">
                    {row.index}
                  </th>
                  {Array.from({ length: columnCount }, (_, column) => {
                    const cell = row.cells[column] ?? { display: '', type: 'blank' as const };
                    return (
                      <td
                        key={column}
                        title={cell.type === 'formula' ? 'Formula shown as text. It was not calculated.' : cell.display}
                        className={`max-w-80 min-w-28 border-r border-b px-2.5 py-1.5 align-top whitespace-pre-wrap ${cellClass(cell)}`}
                      >
                        {cell.display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">This sheet is empty.</p>
        )}
      </div>
      {preview.truncated || activeSheet.truncated ? (
        <p className="shrink-0 border-t bg-background px-3 py-2 text-xs text-muted-foreground">
          The preview reached its safe row, column, or sheet limit. Download the file to view the rest.
        </p>
      ) : null}
    </div>
  );
}

export function OfficePreview({ fileName, url }: OfficePreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchOfficePreview(url, fileName, controller.signal)
      .then((preview) => setState({ status: 'ready', preview }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Preview could not load.' });
        }
      });
    return () => controller.abort();
  }, [fileName, url]);

  if (state.status === 'loading') {
    return <p className="p-4 text-sm text-muted-foreground">Preparing document preview…</p>;
  }
  if (state.status === 'error') {
    return (
      <div className="flex min-h-52 items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <FileWarning className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">Preview unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          <p className="mt-2 text-xs text-muted-foreground">You can still download the original file.</p>
        </div>
      </div>
    );
  }
  return state.preview.kind === 'docx' ? <DocxDocument preview={state.preview} /> : <XlsxDocument preview={state.preview} />;
}
