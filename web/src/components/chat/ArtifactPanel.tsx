import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  AppWindow,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  LayoutTemplate,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import type { Artifact, FileArtifact, PageArtifact } from '../../lib/artifacts';
import { artifactKey, chatReturnUrl, miniAppLaunchUrl } from '../../lib/artifacts';
import { delimiterFor } from '../../lib/csv';
import { formatBytes } from '../../lib/format';
import { pageExpiryLabel } from '../../lib/pageExpiry';
import { Button } from '../ui/button';
import { EmbeddedPreviewFrame } from '../ui/embedded-preview-frame';
import { FileDownloadLink } from '../ui/file-download-link';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { CsvTable } from './CsvTable';
import { CodeFilePreview, isCodeFileName } from './CodeFilePreview';
import { HtmlFilePreview } from './HtmlFilePreview';
import { isMarkdownFileName, MarkdownFilePreview } from './MarkdownFilePreview';

const MobilePdfViewer = lazy(() =>
  import('./MobilePdfViewer').then((module) => ({ default: module.MobilePdfViewer })),
);
const OfficePreview = lazy(() =>
  import('./OfficePreview').then((module) => ({ default: module.OfficePreview })),
);

const OFFICE_RE = /\.(docx|xlsx)$/i;

interface ArtifactPanelProps {
  artifact: Artifact | null;
  deletable: boolean;
  loading?: boolean;
  isDesktop: boolean;
  revision: number;
  onClose: () => void;
  onArtifactDeleted: (artifact: FileArtifact | PageArtifact) => void;
  onToast: (message: string) => void;
}

interface TextPreviewState {
  loading: boolean;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}

function iconFor(artifact: Artifact): ReactNode {
  if (artifact.type === 'page') return <LayoutTemplate className="size-5" />;
  if (artifact.type === 'app') return <AppWindow className="size-5" />;
  if (artifact.kind === 'csv' || artifact.kind === 'tsv' || (artifact.type === 'file' && /\.xlsx$/i.test(artifact.name))) {
    return <FileSpreadsheet className="size-5" />;
  }
  if (artifact.kind === 'image') return <FileImage className="size-5" />;
  return <FileText className="size-5" />;
}

function displayTitle(artifact: Artifact): string {
  return artifact.type === 'file' ? artifact.name : artifact.title || artifact.slug;
}

function fileInlineUrl(artifact: FileArtifact): string {
  return api.generatedFileDownloadUrl(artifact.id, { inline: true });
}

function refreshedUrl(url: string, revision: string): string {
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set('_veneer_refresh', revision);
  return parsed.toString();
}

export function ArtifactPanel({
  artifact,
  deletable,
  loading = false,
  isDesktop,
  revision,
  onClose,
  onArtifactDeleted,
  onToast,
}: ArtifactPanelProps) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<TextPreviewState>({ loading: false });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [manualRevision, setManualRevision] = useState<number | null>(null);

  useEffect(() => setCopied(false), [artifact]);

  useEffect(() => {
    setConfirmDelete(false);
    setDeleting(false);
    setDeleteError(null);
  }, [artifact]);

  useEffect(() => {
    if (
      !artifact ||
      artifact.type !== 'file' ||
      (!['csv', 'tsv', 'text', 'code'].includes(artifact.kind) && !isCodeFileName(artifact.name))
    ) {
      setPreview({ loading: false });
      return;
    }
    let stopped = false;
    setPreview({ loading: true });
    void api
      .generatedFilePreview(artifact.id)
      .then((result) => {
        if (!stopped) {
          setPreview({
            loading: false,
            content: result.content,
            truncated: result.truncated,
            binary: result.binary,
          });
        }
      })
      .catch((error: Error) => {
        if (!stopped) setPreview({ loading: false, error: error.message });
      });
    return () => {
      stopped = true;
    };
  }, [artifact, revision]);

  if (!artifact) {
    return (
      <div className="flex h-full flex-col bg-background">
        <header className="flex items-center gap-1 border-b border-border px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
          {!isDesktop ? (
            <Button
              variant="ghost"
              size="icon-lg"
              className="h-11 w-11 shrink-0 rounded-full"
              onPointerUp={onClose}
              aria-label="Back to chat"
            >
              <ChevronLeft className="size-5" />
            </Button>
          ) : null}
          <p className="min-w-0 flex-1 truncate px-2 font-medium">{loading ? 'Loading artifact…' : 'Artifact unavailable'}</p>
          {isDesktop ? (
            <Button
              variant="ghost"
              size="icon-lg"
              className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
              onPointerUp={onClose}
              aria-label="Close artifact panel"
            >
              <X className="size-5" />
            </Button>
          ) : null}
        </header>
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          {loading ? 'Preparing preview…' : 'This artifact is no longer available.'}
        </div>
      </div>
    );
  }

  const title = displayTitle(artifact);
  const isMarkdown = artifact.type === 'file' && isMarkdownFileName(artifact.name);
  const isCode =
    artifact.type === 'file' && (artifact.kind === 'code' || isCodeFileName(artifact.name));
  const url = artifact.type === 'file' ? fileInlineUrl(artifact) : artifact.url;
  const openUrl = artifact.type === 'app'
    ? miniAppLaunchUrl(artifact.url, chatReturnUrl(window.location.href))
    : url;
  const previewRevision = `${revision}-${manualRevision ?? 'initial'}`;
  const pageUrl =
    artifact.type === 'page' && (revision > 0 || manualRevision !== null)
      ? refreshedUrl(artifact.url, `${artifact.updatedAt}-${previewRevision}`)
      : url;
  const copyLink = () => {
    if (artifact.type === 'file') return;
    void navigator.clipboard
      .writeText(artifact.url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => onToast('Could not copy link'));
  };
  const deleteArtifact = async () => {
    if (!deletable || artifact.type === 'app') return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (artifact.type === 'file') await api.deleteGeneratedFile(artifact.id);
      else await api.deletePage(artifact.id);
      onArtifactDeleted(artifact);
      onToast(artifact.type === 'file' ? `Deleted ${artifact.name}` : `Deleted "${displayTitle(artifact)}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delete failed';
      setDeleteError(message);
      onToast(message);
    } finally {
      setDeleting(false);
    }
  };

  let body: ReactNode;
  if (artifact.type === 'page') {
    body = (
      <EmbeddedPreviewFrame
        key={`${artifactKey(artifact)}:${previewRevision}`}
        src={pageUrl}
        title={title}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    );
  } else if (artifact.type === 'app') {
    body =
      artifact.status === 'deployed' ? (
        <EmbeddedPreviewFrame
          key={`${artifactKey(artifact)}:${revision}`}
          src={artifact.url}
          title={title}
          preserveOrigin
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-xl border bg-card p-5 text-center">
            <AppWindow className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">{artifact.status === 'deploying' ? 'App is deploying…' : 'Deployment failed'}</p>
            {artifact.lastError ? <p className="mt-2 text-sm text-destructive">{artifact.lastError}</p> : null}
          </div>
        </div>
      );
  } else if (artifact.kind === 'image') {
    body = (
      <div className="flex min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
        <img src={url} alt={artifact.name} className="m-auto max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (artifact.kind === 'pdf') {
    body = isDesktop ? (
      <iframe
        key={`${artifactKey(artifact)}:${revision}`}
        src={url}
        title={title}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    ) : (
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 text-sm text-muted-foreground">
            Preparing PDF viewer…
          </div>
        }
      >
        <MobilePdfViewer key={`${artifactKey(artifact)}:${revision}`} url={url} title={title} />
      </Suspense>
    );
  } else if (artifact.kind === 'html') {
    body = (
      <HtmlFilePreview
        key={`${artifactKey(artifact)}:${revision}`}
        title={title}
        url={url}
        loadSource={() => api.generatedFilePreview(artifact.id)}
      />
    );
  } else if (OFFICE_RE.test(artifact.name)) {
    body = (
      <div className="flex min-h-0 flex-1 overflow-auto overscroll-contain bg-card">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Preparing document preview…</p>}>
          <OfficePreview key={`${artifactKey(artifact)}:${revision}`} fileName={artifact.name} url={url} />
        </Suspense>
      </div>
    );
  } else if (artifact.kind === 'csv' || artifact.kind === 'tsv' || artifact.kind === 'text' || isCode) {
    body = (
      <div
        className={`min-h-0 flex-1 overscroll-contain bg-card ${
          isCode ? 'flex flex-col overflow-hidden' : 'overflow-auto'
        }`}
      >
        {preview.loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>
        ) : preview.error ? (
          <p className="p-4 text-sm text-destructive">{preview.error}</p>
        ) : preview.binary || preview.content === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">No text preview is available.</p>
        ) : artifact.kind === 'csv' || artifact.kind === 'tsv' ? (
          <CsvTable text={preview.content} delimiter={delimiterFor(artifact.name)} />
        ) : isMarkdown ? (
          <MarkdownFilePreview content={preview.content} imageBaseUrl={api.generatedFileMarkdownImageUrl(artifact.id, '')} />
        ) : isCode ? (
          <CodeFilePreview
            fileName={artifact.name}
            content={preview.content}
            cacheKey={`artifact:${artifact.id}:${artifact.updatedAt}`}
          />
        ) : (
          <pre className="p-4 text-xs whitespace-pre-wrap break-words">{preview.content}</pre>
        )}
        {preview.truncated ? (
          <p className="sticky bottom-0 border-t bg-background px-4 py-2 text-xs text-muted-foreground">
            Preview shows the first part of this file — download for all of it.
          </p>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border bg-card p-5 text-center">
          <FileText className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">No preview for this file type</p>
          <FileDownloadLink
            href={api.generatedFileDownloadUrl(artifact.id, { name: artifact.name })}
            name={artifact.name}
            buttonVariant="default"
            buttonSize="default"
            className="mt-4 rounded-xl"
            iconClassName="size-4"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex items-center gap-1 border-b border-border px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
        {!isDesktop ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full"
            onPointerUp={onClose}
            aria-label="Back to chat"
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <span className="flex size-10 shrink-0 items-center justify-center text-muted-foreground">{iconFor(artifact)}</span>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {artifact.type === 'page'
              ? `Published page · ${pageExpiryLabel(artifact.expiresAt)}`
              : artifact.type === 'app'
                ? `Mini app · ${artifact.runtime === 'local' ? 'This Veneer' : 'Cloudflare'} · ${artifact.status}`
                : `${formatBytes(artifact.size)} · ${artifact.kind.toUpperCase()}`}
          </p>
        </div>
        {artifact.type === 'page' ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            onClick={() => setManualRevision(Date.now())}
            aria-label="Refresh page preview"
            title="Refresh page preview"
          >
            <RefreshCw className="size-5" />
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="icon-lg" className="h-11 w-11 shrink-0 rounded-full text-muted-foreground">
          <a href={openUrl} target="_blank" rel="noopener" aria-label="Open in new tab">
            <ExternalLink className="size-5" />
          </a>
        </Button>
        {artifact.type === 'file' ? (
          <FileDownloadLink
            href={api.generatedFileDownloadUrl(artifact.id, { name: artifact.name })}
            name={artifact.name}
            showLabel={false}
            buttonVariant="ghost"
            buttonSize="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            iconClassName="size-5"
          />
        ) : (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            onPointerUp={copyLink}
            aria-label={copied ? 'Link copied' : 'Copy link'}
          >
            {copied ? <Check className="size-5 text-primary" /> : <Copy className="size-5" />}
          </Button>
        )}
        {deletable && artifact.type !== 'app' ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
            aria-label={`Delete ${title}`}
            title={`Delete ${title}`}
          >
            <Trash2 className="size-5" />
          </Button>
        ) : null}
        {isDesktop ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            onPointerUp={onClose}
            aria-label="Close artifact panel"
          >
            <X className="size-5" />
          </Button>
        ) : null}
      </header>
      {body}
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setConfirmDelete(false);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="truncate pr-6">Delete {title}?</DialogTitle>
            <DialogDescription>
              {artifact.type === 'page'
                ? 'This permanently removes the published page, including its public address. Anyone with the link will get a 404.'
                : 'This permanently removes the file from disk. Chats that mention it will no longer be able to open it.'}
            </DialogDescription>
            {deleteError ? (
              <p role="alert" className="text-sm text-destructive">
                Delete failed: {deleteError}
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 rounded-xl"
              onClick={() => {
                setConfirmDelete(false);
                setDeleteError(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onClick={() => void deleteArtifact()}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
