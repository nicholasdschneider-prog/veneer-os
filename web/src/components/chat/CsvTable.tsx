import { useMemo } from 'react';
import { parseDsv } from '../../lib/csv';

const CSV_PREVIEW_ROWS = 200;

export function CsvTable({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = useMemo(() => parseDsv(text, delimiter), [text, delimiter]);
  const [header, ...body] = rows;
  if (!header?.length) {
    return <p className="p-4 text-sm text-muted-foreground">Empty file.</p>;
  }
  const shown = body.slice(0, CSV_PREVIEW_ROWS);
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card shadow-[0_1px_0_var(--border)]">
          <tr>
            {header.map((heading, index) => (
              <th key={index} className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-muted/40">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2.5 py-1 align-top whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length ? (
        <p className="border-t px-2.5 py-1.5 text-xs text-muted-foreground">
          Showing {shown.length} of {body.length} rows — download for the full file.
        </p>
      ) : null}
    </>
  );
}
