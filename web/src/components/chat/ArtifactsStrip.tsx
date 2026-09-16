import { useEffect, useState } from 'react';
import { AppWindow, ChevronDown, FileImage, FileSpreadsheet, FileText, LayoutTemplate } from 'lucide-react';
import { api, type SessionFile } from '../../lib/api';
import type { Artifact } from '../../lib/artifacts';
import { artifactKey, artifactPathKey } from '../../lib/artifacts';
import { formatBytes } from '../../lib/format';
import { pageExpiryLabel } from '../../lib/pageExpiry';
import { CollapsibleAttachments } from '../ui/attachment';
import { FileDownloadLink } from '../ui/file-download-link';

type StripItem = { kind: 'artifact'; artifact: Artifact } | { kind: 'session'; file: SessionFile };

interface ArtifactsStripProps {
  conversationId: string;
  artifacts: Artifact[];
  sessionFiles: SessionFile[];
  onOpenArtifact: (artifact: Artifact) => void;
  onOpenSessionFile: (file: SessionFile) => void;
}

function itemName(item: StripItem): string {
  if (item.kind === 'session') return item.file.name;
  return item.artifact.type === 'file' ? item.artifact.name : item.artifact.title || item.artifact.slug;
}

function itemDescription(item: StripItem): string {
  if (item.kind === 'session') return formatBytes(item.file.size);
  if (item.artifact.type === 'page') return `Published page · ${pageExpiryLabel(item.artifact.expiresAt)}`;
  if (item.artifact.type === 'app') {
    const runtime = item.artifact.runtime === 'local' ? 'This Veneer' : 'Cloudflare';
    return `Mini app · ${runtime} · ${item.artifact.status}`;
  }
  return formatBytes(item.artifact.size);
}

function itemIcon(item: StripItem) {
  if (item.kind === 'session') {
    return /\.(csv|tsv|xlsx)$/i.test(item.file.name) ? <FileSpreadsheet /> : <FileText />;
  }
  const artifact = item.artifact;
  if (artifact.type === 'page') return <LayoutTemplate />;
  if (artifact.type === 'app') return <AppWindow />;
  if (artifact.kind === 'csv' || artifact.kind === 'tsv') return <FileSpreadsheet />;
  if (artifact.kind === 'image') return <FileImage />;
  return <FileText />;
}

/** Pages, apps, and csv/tsv tables get the large preview cards; everything else is a one-line chip. */
function isPrimary(item: StripItem): boolean {
  if (item.kind === 'session') return /\.(csv|tsv)$/i.test(item.file.name);
  if (item.artifact.type === 'page' || item.artifact.type === 'app') return true;
  return item.artifact.kind === 'csv' || item.artifact.kind === 'tsv';
}

/** Quote-aware single-line split — only for the visual preview strip, not a real CSV parser. */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"' && current === '') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

const PREVIEW_ROWS = 3; // header + 2 data rows
const PREVIEW_COLS = 4;

/** First rows of a csv/tsv, fetched from the capped text preview endpoints. */
function useTablePreview(item: StripItem, conversationId: string): string[][] | null {
  const [rows, setRows] = useState<string[][] | null>(null);
  const key = item.kind === 'artifact' ? artifactKey(item.artifact) : `session:${item.file.path}`;
  const name = itemName(item);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res =
          item.kind === 'artifact' && item.artifact.type === 'file'
            ? await api.generatedFilePreview(item.artifact.id)
            : item.kind === 'session'
              ? await api.conversationFilePreview(conversationId, item.file.path)
              : null;
        const content = res && !res.binary ? res.content : undefined;
        if (cancelled || !content) return;
        const delimiter = /\.tsv$/i.test(name) ? '\t' : ',';
        const lines = content
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .slice(0, PREVIEW_ROWS);
        setRows(lines.map((line) => splitDelimited(line, delimiter).slice(0, PREVIEW_COLS)));
      } catch {
        // keep the skeleton strip
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, conversationId]);

  return rows;
}

const cardShell =
  'group relative min-w-0 rounded-xl bg-muted/40 text-card-foreground transition-colors hover:bg-muted/70 focus-within:ring-1 focus-within:ring-ring/50';

function CardTrigger({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Preview ${name}`}
      onPointerUp={onOpen}
      className="absolute inset-0 z-10 cursor-pointer rounded-xl outline-none"
    />
  );
}

/** Portrait page screenshot; falls back to a styled stand-in when absent. */
function PortraitThumb({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className="h-[70px] w-[58px] shrink-0 rounded-md border border-border/60 bg-muted object-cover object-top"
      />
    );
  }
  return (
    <div className="flex h-[70px] w-[58px] shrink-0 flex-col gap-[7px] overflow-hidden rounded-md border border-border/60 bg-gradient-to-br from-muted to-muted/30 p-2">
      <div className="h-[5px] w-3/4 rounded-sm bg-foreground/30" />
      <div className="h-[3px] w-full rounded-sm bg-foreground/15" />
      <div className="h-[3px] w-5/6 rounded-sm bg-foreground/15" />
      <div className="h-[3px] w-full rounded-sm bg-foreground/10" />
      <div className="h-[3px] w-2/3 rounded-sm bg-foreground/10" />
      <div className="h-[3px] w-5/6 rounded-sm bg-foreground/10" />
    </div>
  );
}

/** Page/app card: portrait thumbnail left, title and metadata right. */
function PublishedCard({ item, onOpen }: { item: StripItem; onOpen: () => void }) {
  const name = itemName(item);
  const artifact = item.kind === 'artifact' ? item.artifact : null;
  const thumbSrc = artifact?.type === 'page' ? api.pageThumbnailUrl(artifact.id) : null;
  const lines =
    artifact?.type === 'page'
      ? ['Published page', pageExpiryLabel(artifact.expiresAt)]
      : artifact?.type === 'app'
        ? ['Mini app', `${artifact.runtime === 'local' ? 'This Veneer' : 'Cloudflare'} · ${artifact.status}`]
        : [];
  return (
    <div className={`${cardShell} flex items-center gap-3 p-2.5`}>
      <PortraitThumb src={thumbSrc} />
      <CardTrigger name={name} onOpen={onOpen} />
      <div className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-medium">{name}</span>
        {lines.map((line) => (
          <span key={line} className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

/** CSV/TSV card: wide header-plus-rows strip on top, name and metadata below. */
function TableCard({
  item,
  conversationId,
  onOpen,
  href,
}: {
  item: StripItem;
  conversationId: string;
  onOpen: () => void;
  href: string | null;
}) {
  const name = itemName(item);
  const rows = useTablePreview(item, conversationId);
  const size = item.kind === 'session' ? item.file.size : item.artifact.type === 'file' ? item.artifact.size : 0;
  const label = /\.tsv$/i.test(name) ? 'TSV' : 'CSV';
  return (
    <div className={`${cardShell} overflow-hidden`}>
      <div className="flex h-12 flex-col justify-start gap-[3px] overflow-hidden border-b border-border/60 bg-muted/40 px-2.5 py-1.5">
        {rows?.length ? (
          rows.map((cells, rowIndex) => (
            <div
              // Preview rows are positional; the data has no stable id.
              // eslint-disable-next-line react/no-array-index-key
              key={rowIndex}
              className={`flex gap-2 text-[9px] leading-[10px] ${
                rowIndex === 0 ? 'font-medium text-foreground/80' : 'text-muted-foreground'
              }`}
            >
              {cells.map((cell, cellIndex) => (
                // eslint-disable-next-line react/no-array-index-key
                <span key={cellIndex} className="w-0 flex-1 truncate">
                  {cell}
                </span>
              ))}
            </div>
          ))
        ) : (
          <>
            <div className="h-[9px] w-full rounded-sm bg-foreground/15" />
            <div className="h-2 w-full rounded-sm bg-foreground/8" />
            <div className="h-2 w-11/12 rounded-sm bg-foreground/8" />
          </>
        )}
      </div>
      <CardTrigger name={name} onOpen={onOpen} />
      <div className="flex items-center gap-2 py-2 pr-1.5 pl-2.5">
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-xs font-medium">{name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {label} · {formatBytes(size)}
          </span>
        </div>
        {href ? <DownloadAction href={href} name={name} /> : null}
      </div>
    </div>
  );
}

function DownloadAction({ href, name }: { href: string; name: string }) {
  return (
    <FileDownloadLink
      href={href}
      name={name}
      showLabel={false}
      className="relative z-20 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
    />
  );
}

export function ArtifactsStrip({
  conversationId,
  artifacts,
  sessionFiles,
  onOpenArtifact,
  onOpenSessionFile,
}: ArtifactsStripProps) {
  // Per-chat collapse choice; open by default. Guarded reads/writes because
  // localStorage is absent in static rendering and can throw in private mode.
  const collapseKey = `vp-artifacts-collapsed:${conversationId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(collapseKey) === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (next) window.localStorage.setItem(collapseKey, '1');
        else window.localStorage.removeItem(collapseKey);
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
  };
  const registeredPaths = new Set(
    artifacts.filter((artifact) => artifact.type === 'file').map((artifact) => artifactPathKey(artifact.path)),
  );
  const items: StripItem[] = [
    ...artifacts.map((artifact): StripItem => ({ kind: 'artifact', artifact })),
    ...sessionFiles
      .filter((file) => !registeredPaths.has(artifactPathKey(file.path)))
      .map((file): StripItem => ({ kind: 'session', file })),
  ];
  if (!items.length) return null;

  const primaryItems = items.filter(isPrimary);
  const fileItems = items.filter((item) => !primaryItems.includes(item));

  const keyFor = (item: StripItem) =>
    item.kind === 'artifact' ? artifactKey(item.artifact) : `session:${item.file.path}`;
  const open = (item: StripItem) =>
    item.kind === 'artifact' ? onOpenArtifact(item.artifact) : onOpenSessionFile(item.file);
  const downloadUrl = (item: StripItem): string | null => {
    if (item.kind === 'session') return api.conversationFileDownloadUrl(conversationId, item.file.path);
    if (item.artifact.type === 'file') {
      return api.generatedFileDownloadUrl(item.artifact.id, { name: item.artifact.name });
    }
    return null;
  };
  const imageThumbUrl = (item: StripItem): string | null => {
    if (item.kind === 'artifact' && item.artifact.type === 'file' && item.artifact.kind === 'image') {
      return api.generatedFileDownloadUrl(item.artifact.id, { inline: true, name: item.artifact.name });
    }
    if (item.kind === 'session' && /\.(png|jpe?g|gif|webp|svg)$/i.test(item.file.name)) {
      return api.conversationFileInlineUrl(conversationId, item.file.path);
    }
    return null;
  };

  // Single-line chip: icon (or image thumbnail), name, download.
  const renderChip = (item: StripItem) => {
    const name = itemName(item);
    const href = downloadUrl(item);
    const thumb = imageThumbUrl(item);
    return (
      <div
        data-slot="attachment"
        className="relative flex max-w-56 min-w-0 shrink-0 items-center gap-2 rounded-lg bg-muted/40 py-1 pr-1 pl-2 text-card-foreground transition-colors hover:bg-muted/70 focus-within:ring-1 focus-within:ring-ring/50"
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="size-[18px] shrink-0 rounded-sm object-cover"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5">{itemIcon(item)}</span>
        )}
        <button
          type="button"
          aria-label={`Preview ${name}`}
          onPointerUp={() => open(item)}
          className="absolute inset-0 z-10 cursor-pointer rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        />
        <span className="min-w-0 truncate text-xs">{name}</span>
        {href ? <DownloadAction href={href} name={name} /> : null}
      </div>
    );
  };

  const renderRow = (item: StripItem) => {
    const name = itemName(item);
    const href = downloadUrl(item);
    return (
      <div className="relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground [&_svg]:size-4">
          {itemIcon(item)}
        </div>
        <button
          type="button"
          aria-label={`Preview ${name}`}
          onPointerUp={() => open(item)}
          className="absolute inset-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-xs font-medium">{name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{itemDescription(item)}</span>
        </div>
        {href ? (
          <FileDownloadLink
            href={href}
            name={name}
            showLabel={false}
            className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="px-1 pb-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        className="flex cursor-pointer items-center gap-1 px-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        Artifacts from this chat{collapsed ? ` · ${items.length}` : ''}
        <ChevronDown className={`size-3 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      {collapsed ? null : primaryItems.length ? (
        <div className="flex min-w-0 scroll-fade-x snap-x snap-mandatory scroll-px-1 scrollbar-none gap-2 overflow-x-auto overscroll-x-contain py-1">
          {primaryItems.map((item) => (
            <div key={keyFor(item)} className="w-64 flex-none snap-start">
              {isPrimary(item) && (item.kind === 'session' || item.artifact.type === 'file') ? (
                <TableCard
                  item={item}
                  conversationId={conversationId}
                  onOpen={() => open(item)}
                  href={downloadUrl(item)}
                />
              ) : (
                <PublishedCard item={item} onOpen={() => open(item)} />
              )}
            </div>
          ))}
        </div>
      ) : null}
      {!collapsed && fileItems.length ? (
        <CollapsibleAttachments
          items={fileItems}
          getKey={keyFor}
          label={(count) => `${count} artifacts`}
          renderChip={renderChip}
          renderRow={renderRow}
        />
      ) : null}
    </div>
  );
}
