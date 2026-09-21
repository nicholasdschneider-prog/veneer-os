import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Artifact, FileArtifact, PageArtifact, PublishedArtifact } from '../../lib/artifacts';
import { artifactForHref, artifactFromHash, artifactHashValue, artifactKey } from '../../lib/artifacts';
import { rememberChatArtifact, syncChatArtifactMemory } from '../../lib/chatArtifactMemory';
import {
  conversationBrowserPollState,
  rememberConversationBrowserDismissal,
  rememberedConversationBrowserDismissal,
} from '../../lib/conversationBrowserMemory';
import type { ToastAction } from '../ui/toast';
import { DESKTOP_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { Chat } from '../../screens/Chat';
import { FileBrowser } from '../../screens/FileBrowser';
import { SplitView } from '../layout/SplitView';
import { ArtifactPanel } from './ArtifactPanel';
import { DesktopPanel, shouldDockDesktop, useFloatingDesktop } from '../desktop/FloatingDesktop';
import { CitationPanel } from './CitationPanel';
import { SideChatPanel } from './SideChatPanel';
import { withSideParam } from '../../lib/sideChat';
import { ConversationBrowserPanel } from '../browser/ConversationBrowserPanel';
import type { Citation } from '../../lib/citations';
import type { ProjectFileLocation } from '../../lib/projectFilesRoute';

const ARTIFACT_HISTORY_STATE = 'veneerArtifactPanel';

interface ChatWorkspaceProps {
  conversationId: string;
  projectId?: string | null;
  todoId?: string | null;
  backHash?: string | null;
  focusMessageId?: string | null;
  artifactParam: string | null;
  /** `side` query value: a side chat docked beside this one (see SideChatPanel). */
  sideParam?: string | null;
  projectFilesId: string | null;
  projectFile: ProjectFileLocation | null;
  projectBrowserId: string | null;
  onCloseProjectFiles: () => void;
  onOpenProjectFile: (projectId: string, file: ProjectFileLocation) => void;
  onClearProjectFile: () => void;
  onOpenProjectBrowser: (projectId: string) => void;
  onCloseProjectBrowser: () => void;
  onNavigate: (hash: string) => void;
  onToast: (message: string, action?: ToastAction) => void;
}

function hashWithArtifact(value: string | null): string {
  const [path, query = ''] = (window.location.hash || '#/').split('?');
  const params = new URLSearchParams(query);
  if (value) {
    params.set('artifact', value);
    params.delete('files');
    params.delete('file');
    params.delete('line');
    params.delete('column');
    params.delete('dir');
    params.delete('browser');
  } else {
    params.delete('artifact');
  }
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ''}`;
}

function replaceHash(hash: string, panelEntry: boolean): void {
  const oldURL = window.location.href;
  const state = { ...(window.history.state ?? {}) } as Record<string, unknown>;
  if (panelEntry) state[ARTIFACT_HISTORY_STATE] = true;
  else delete state[ARTIFACT_HISTORY_STATE];
  window.history.replaceState(state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

function pushHash(hash: string): void {
  const oldURL = window.location.href;
  window.history.pushState({ ...(window.history.state ?? {}), [ARTIFACT_HISTORY_STATE]: true }, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

export function ChatWorkspace({
  conversationId,
  projectId = null,
  todoId = null,
  backHash = null,
  focusMessageId = null,
  artifactParam,
  sideParam = null,
  projectFilesId,
  projectFile,
  projectBrowserId,
  onCloseProjectFiles,
  onOpenProjectFile,
  onClearProjectFile,
  onOpenProjectBrowser,
  onCloseProjectBrowser,
  onNavigate,
  onToast,
}: ChatWorkspaceProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const {
    state: desktopState,
    show: showDesktop,
    hide: hideDesktop,
    setDockAvailable,
  } = useFloatingDesktop();
  const isNew = conversationId === 'new';
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(isNew ? [] : null);
  const [citations, setCitations] = useState<Citation[] | null>(null);
  const [revision, setRevision] = useState(0);
  const artifactMemoryCheckedRef = useRef(false);
  const previousArtifactParamRef = useRef<string | null>(artifactParam);
  const browserDismissedRef = useRef(rememberedConversationBrowserDismissal(conversationId));
  const sideChatOpen = Boolean(sideParam && !isNew);
  const alternativePanelSelected = Boolean(artifactParam || projectFilesId || citations || sideChatOpen);

  useEffect(() => {
    if (isNew || projectBrowserId) return;
    let alive = true;
    const check = () => {
      void api.veneerBrowserConversation(conversationId).then(({ session }) => {
        if (!alive) return;
        const next = conversationBrowserPollState(
          session,
          browserDismissedRef.current,
          alternativePanelSelected,
        );
        if (browserDismissedRef.current !== next.dismissedAt) {
          browserDismissedRef.current = next.dismissedAt;
          rememberConversationBrowserDismissal(conversationId, next.dismissedAt);
        }
        if (next.shouldOpen) onOpenProjectBrowser(projectId ?? 'chat');
      }).catch(() => {});
    };
    check();
    const timer = window.setInterval(check, 3_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [alternativePanelSelected, conversationId, isNew, onOpenProjectBrowser, projectBrowserId, projectId]);

  const dismissConversationBrowser = useCallback(() => {
    browserDismissedRef.current = Date.now();
    rememberConversationBrowserDismissal(conversationId, browserDismissedRef.current);
  }, [conversationId]);

  const selectAlternativePanel = dismissConversationBrowser;

  const closeConversationBrowser = useCallback(() => {
    dismissConversationBrowser();
    onCloseProjectBrowser();
  }, [dismissConversationBrowser, onCloseProjectBrowser]);

  const openConversationBrowser = useCallback(() => {
    browserDismissedRef.current = null;
    rememberConversationBrowserDismissal(conversationId, null);
    setCitations(null);
    onOpenProjectBrowser(projectId ?? 'chat');
  }, [conversationId, onOpenProjectBrowser, projectId]);

  const refreshArtifacts = useCallback(async (): Promise<Artifact[]> => {
    if (isNew) return [];
    try {
      const result = await api.conversationArtifacts(conversationId);
      setArtifacts(result.artifacts);
      return result.artifacts;
    } catch {
      setArtifacts((current) => current ?? []);
      return [];
    }
  }, [conversationId, isNew]);

  useEffect(() => {
    setArtifacts(isNew ? [] : null);
    setCitations(null);
    void refreshArtifacts();
  }, [isNew, refreshArtifacts]);

  useEffect(() => {
    setDockAvailable(isDesktop);
    return () => setDockAvailable(false);
  }, [isDesktop, setDockAvailable]);

  const selected = useMemo(
    () => artifactFromHash(artifactParam, artifacts ?? []),
    [artifactParam, artifacts],
  );

  useEffect(() => {
    if (isNew) return;
    const firstCheck = !artifactMemoryCheckedRef.current;
    const remembered = syncChatArtifactMemory(
      conversationId,
      artifactParam,
      previousArtifactParamRef.current,
      firstCheck,
    );
    artifactMemoryCheckedRef.current = true;
    previousArtifactParamRef.current = artifactParam;
    if (remembered) pushHash(hashWithArtifact(remembered));
  }, [artifactParam, conversationId, isNew]);

  // A stale or malformed deep link should quietly return to the chat once the
  // artifact list has resolved. Synthetic bare-URL artifacts resolve locally.
  useEffect(() => {
    if (artifactParam && artifacts !== null && !selected) {
      rememberChatArtifact(conversationId, null);
      replaceHash(hashWithArtifact(null), false);
    }
  }, [artifactParam, artifacts, conversationId, selected]);

  const openArtifact = useCallback(
    (artifact: Artifact) => {
      selectAlternativePanel();
      setCitations(null);
      const value = artifactHashValue(artifact);
      rememberChatArtifact(conversationId, value);
      const next = hashWithArtifact(value);
      if (artifactParam) replaceHash(next, Boolean(window.history.state?.[ARTIFACT_HISTORY_STATE]));
      else pushHash(next);
    },
    [artifactParam, conversationId, selectAlternativePanel],
  );

  const openCitations = useCallback((next: Citation[]) => {
    if (!next.length) return;
    selectAlternativePanel();
    if (projectBrowserId) onCloseProjectBrowser();
    if (desktopState === 'full') showDesktop('mini');
    setCitations(next);
  }, [desktopState, onCloseProjectBrowser, projectBrowserId, selectAlternativePanel, showDesktop]);

  const openProjectFile = useCallback((nextProjectId: string, file: ProjectFileLocation) => {
    selectAlternativePanel();
    setCitations(null);
    if (projectBrowserId) onCloseProjectBrowser();
    if (desktopState === 'full') showDesktop('mini');
    onOpenProjectFile(nextProjectId, file);
  }, [desktopState, onCloseProjectBrowser, onOpenProjectFile, projectBrowserId, selectAlternativePanel, showDesktop]);

  const closeArtifact = useCallback(() => {
    rememberChatArtifact(conversationId, null);
    if (window.history.state?.[ARTIFACT_HISTORY_STATE]) window.history.back();
    else replaceHash(hashWithArtifact(null), false);
  }, [conversationId]);

  const handleArtifactDeleted = useCallback(
    (artifact: FileArtifact | PageArtifact) => {
      closeArtifact();
      setArtifacts((current) => current?.filter((item) => artifactKey(item) !== artifactKey(artifact)) ?? current);
    },
    [closeArtifact],
  );

  const handlePublish = useCallback(
    async (published: PublishedArtifact) => {
      const next = await refreshArtifacts();
      if (artifactParam === `${published.type}:${published.id}`) setRevision((value) => value + 1);
      if (!isDesktop) return;
      const artifact =
        next.find((item) => item.type === published.type && item.id === published.id) ??
        artifactForHref(published.url, next);
      if (artifact) openArtifact(artifact);
    },
    [artifactParam, isDesktop, openArtifact, refreshArtifacts],
  );

  const desktopPanelOpen = shouldDockDesktop(desktopState, isDesktop);
  const conversationBrowserOpen = Boolean(projectBrowserId && !isNew);
  const panelOpen = Boolean(sideChatOpen || conversationBrowserOpen || desktopPanelOpen || citations || projectFilesId || artifactParam);
  const [agentName, setAgentName] = useState('the agent');
  useEffect(() => {
    if (!sideChatOpen) return;
    void api.conversation(conversationId).then((r) => setAgentName(r.conversation.assistantName)).catch(() => undefined);
  }, [conversationId, sideChatOpen]);
  const closeSideChat = useCallback(() => {
    replaceHash(withSideParam(window.location.hash, null), false);
  }, []);
  const deletable = Boolean(
    selected &&
      selected.type !== 'app' &&
      artifacts?.some((artifact) => artifactKey(artifact) === artifactKey(selected)),
  );

  return (
    <SplitView
      storageKey="split:artifact"
      side="right"
      sidebarHidden={!panelOpen}
      mobileShows={panelOpen ? 'sidebar' : 'detail'}
      defaultWidth={520}
      minWidth={280}
      maxWidth={1200}
      detailMinWidth={300}
      separatorLabel={
        sideChatOpen
          ? 'Resize side chat'
          : conversationBrowserOpen
          ? 'Resize Veneer Browser'
          : desktopPanelOpen
          ? 'Resize Agent Browser'
          : citations
            ? 'Resize citations'
            : projectFilesId
              ? 'Resize project files'
              : 'Resize artifact preview'
      }
      sidebar={
        sideChatOpen && sideParam ? (
          <SideChatPanel
            parentId={conversationId}
            agentName={agentName}
            sideParam={sideParam}
            onNavigate={onNavigate}
            onToast={onToast}
            onClose={closeSideChat}
          />
        ) : conversationBrowserOpen ? (
          <ConversationBrowserPanel conversationId={conversationId} onClose={closeConversationBrowser} onToast={onToast} />
        ) : desktopPanelOpen ? (
          <DesktopPanel onMinimize={() => showDesktop('mini')} onHide={hideDesktop} />
        ) : citations ? (
          <CitationPanel
            citations={citations}
            isDesktop={isDesktop}
            onClose={() => setCitations(null)}
          />
        ) : projectFilesId ? (
          <FileBrowser
            title="Project files"
            fixedRoot={`project:${projectFilesId}`}
            initialFile={projectFile}
            backLabel="Close project files"
            onBack={onCloseProjectFiles}
            onInitialFileDeclined={onClearProjectFile}
            onToast={onToast}
          />
        ) : (
          <ArtifactPanel
            artifact={selected}
            deletable={deletable}
            loading={Boolean(artifactParam && artifacts === null)}
            isDesktop={isDesktop}
            revision={revision}
            onClose={closeArtifact}
            onArtifactDeleted={handleArtifactDeleted}
            onToast={onToast}
          />
        )
      }
    >
      <Chat
        conversationId={conversationId}
        projectId={projectId}
        todoId={todoId}
        backHash={backHash}
        focusMessageId={focusMessageId}
        artifacts={artifacts ?? []}
        onOpenArtifact={openArtifact}
        onRefreshArtifacts={refreshArtifacts}
        onPublishArtifact={handlePublish}
        onOpenCitations={openCitations}
        onOpenProjectFile={openProjectFile}
        onOpenBrowser={openConversationBrowser}
        onNavigate={onNavigate}
        onToast={onToast}
      />
    </SplitView>
  );
}
