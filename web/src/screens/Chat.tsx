import { useMessageListen } from '@/components/MessageAudioPlayer';
import { MobileChatHeader } from '../components/chat/MobileChatHeader';
import { VoiceSessions } from '../components/VoiceSessions';
import { BotCommunication, MessageThreadDialog } from '../components/BotCommunication';
import { workspaceSearchFocusKey } from '@/lib/workspaceSearch';
import { useLiveVoice } from '@/components/VoiceProvider';
import { BotAvatar, BotPresence } from '@/components/BotIdentity';
import { withSideParam } from '../lib/sideChat';
import { MessageSelection, ComposerQuote, appendMessageQuote, type MessageQuote } from '../components/chat/MessageSelection';
import { createContext, lazy, memo, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppWindow, Bell, Bot, Check, ChevronDown, ChevronLeft, Clock, Copy, Ellipsis, FileText, GitFork, HatGlasses, Mail, MessageSquare, MessagesSquare, Mic, Paperclip, Plus, Phone, AudioLines, Pin, Sparkles, UsersRound, Wrench, X } from 'lucide-react';
import { api, requestJson, type AssistantType, type ConnectorInfo, type ConnectorInstall, type ModelOption, type ModelPrefs, type SessionFile } from '../lib/api';
import { chatDeleteConfirmation, chatHeaderMenuLabels, copyChatShareUrl } from '../lib/chatDeletion';
import type { Artifact, PublishedArtifact } from '../lib/artifacts';
import { artifactForHref, artifactPathKey, isDesktopWatchLink, localPathForHref } from '../lib/artifacts';
import { useFloatingDesktop } from '../components/desktop/FloatingDesktop';
import { canUseChatComposer, canUseChatControls } from '../lib/chatAccess';
import { resolveEffectiveApprovalMode } from '../lib/approvalMode';
import { chatViewportStyle, isChatKeyboardActive, shouldDismissChatKeyboard } from '../lib/chatViewport';
import { ConnectorGlyph } from '../lib/connectorIcons';
import {
  appendChatMentionFooter,
  chatMentionsInText,
  segmentMentions,
  splitChatMentionFooter,
} from '../lib/mentions';
import { delimiterFor } from '../lib/csv';
import {
  firstUserPromptKey,
  isBuildQueuePrompt,
  isLongPrompt,
  mostRecentUserPromptKey,
  shouldCollapsePrompt as shouldCollapseEligiblePrompt,
} from '../lib/promptCollapse';
import { PromptDisclosure } from '../components/chat/PromptDisclosure';
import { DEFAULT_TODO_PLANNING_PROMPT, newChatSubmissionPrompt } from '../lib/todoChatPrompt';
import { wsBus } from '../lib/ws';
import { micDictation } from '../lib/stt';
import {
  loadModelCatalogsProgressively,
  refineAgentPickAfterCatalog,
  resolveAgentPickWithCatalogs,
} from '../lib/newChatSelection';
import { syncComposerScroll } from '../lib/composerScroll';
import { isComposerSubmitKey } from '../lib/composerKeys';
import { handleComposerImagePaste } from '../lib/composerPaste';
import {
  appendSkillInvocationMarker,
  availableSkillCommands,
  composerSkillForDraft,
  draftForComposerSkill,
  filterSkillCommands,
  skillNameForPrompt,
  skillQueryForDraft,
  splitSkillInvocationMarker,
  type SkillCommand,
} from '../lib/skillCommands';
import { skillsApi, type SkillsList } from '../lib/skills';
import { composerHasSendableContent, composerTrailingAction } from '../lib/composerTrailingAction';
import { mobileGmailLinkFor, openMobileGmailLink } from '../lib/mobileGmailLinks';
import { projectFileLinkIntent, type ProjectFileLinkIntent } from '../lib/projectFileLinks';
import type { ProjectFileLocation } from '../lib/projectFilesRoute';
import { emptyTranscript, reduceEvents, subagentGroupSummary, subagentProgressSummary, transcriptItemsForDisplay, type ChatItem, type TranscriptState } from '../lib/transcript';
import { agentMessageActivityLabel, agentMessageFocusKey, agentMessageGroupLabel } from '../lib/agentMessageActivity';
import { AgentMessageToolDetails } from '../components/chat/AgentMessageToolDetails';
import { AgentMessagePromptDisclosure, isLocalAgentOrigin } from '../components/chat/AgentMessagePromptDisclosure';
import { CollapsedMessageDisclosure } from '../components/chat/CollapsedMessageDisclosure';
import {
  groupActivityRuns,
  type ActivityRenderItem,
  type SubagentChatItem,
  type ToolChatItem,
} from '../lib/activityRuns';
import { containsMermaidFence, segmentFrozenTranscript } from '../lib/transcriptFreeze';
import {
  agentBadge,
  contextWindowFor,
  formatTokens,
  isProvider,
  modelLabel,
  PROVIDERS,
  providerLabel,
  stripProviderPrefix,
  type Provider,
} from '../lib/modelLabel';
import type {
  ApprovalMode,
  Conversation,
  ConversationActivity,
  ConversationQueueSnapshot,
  ConversationStatus,
  FailedTurnSnapshot,
  PendingWakeup,
  Project,
  QueuedMessageSnapshot,
} from '../lib/types';
import { newestQueueSnapshot, type OrderedQueueSnapshot } from '../lib/queueSnapshots';
import { Markdown, MarkdownImageSourcesContext } from '../components/Markdown';
import { chatImageSources } from '../lib/chatImageSources';
import { CreatorAvatar } from '@/components/CreatorAvatar';
import { ProviderIcon } from '@/components/ProviderIcon';
import { QueuedMessageRow } from '@/components/chat/QueuedPeek';
import { WakeupChip } from '@/components/chat/WakeupChip';
import { SkillCommandPicker } from '@/components/chat/SkillCommandPicker';
import { ComposerSkillChip, ComposerSkillDetails } from '@/components/chat/ComposerSkillChip';
import { AssistantResponseMetadata } from '@/components/chat/AssistantResponseMetadata';
import {
  ModelThinkingPicker,
  buildModelChoices,
  buildExistingChatModelChoices,
  type ModelThinkingValue,
  effortLabel,
  type ModelChoice,
} from '@/components/chat/ModelThinkingPicker';
import { useTypewriter } from '@/hooks/useTypewriter';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileDownloadLink } from '@/components/ui/file-download-link';
import { CodeFilePreview, isCodeFileName } from '@/components/chat/CodeFilePreview';
import { HtmlFilePreview, isHtmlFileName } from '@/components/chat/HtmlFilePreview';
import { isMarkdownFileName, MarkdownFilePreview } from '@/components/chat/MarkdownFilePreview';
import type { ToastAction } from '@/components/ui/toast';
import { cancelArchive, scheduleArchive } from '../lib/pendingArchive';
import {
  completePendingNewChat,
  failPendingNewChat,
  moveNewChatDraft,
  readNewChatDraft,
  startPendingNewChat,
  writeNewChatDraft,
} from '../lib/newChatDrafts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller';
import { Message, MessageContent, MessageFooter } from '@/components/ui/message';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  CollapsibleAttachments,
} from '@/components/ui/attachment';
import { CsvTable } from '../components/chat/CsvTable';
import { ArtifactsStrip } from '../components/chat/ArtifactsStrip';
import { AutomationStrip } from '../components/chat/AutomationStrip';
import { ChatContextDialog } from '../components/chat/ChatContextDialog';
import { ChatArchiveButton } from '../components/chat/ChatArchiveButton';
import { ChatHeaderMenuItems } from '../components/chat/ChatHeaderMenuItems';
import { MoveChatDialog } from '../components/chat/MoveChatDialog';
import { QuestionCard } from '../components/chat/QuestionCard';
import { RevealSecretCard } from '../components/chat/RevealSecretCard';
import { SecretCard } from '../components/chat/SecretCard';
import { ChatMentionOption, sortChatsByRecentUse } from '../components/chat/ChatMentionOption';
import { DictationWaveform } from '../components/chat/DictationWaveform';
import { AgentWorkingMarker, AgentWorkingStopButton } from '../components/chat/AgentWorkingStatus';
import { CitationChip } from '../components/chat/CitationChip';
import { ConnectionToolRow } from '../components/chat/connections/ConnectionToolRow';
import {
  citationsFromPayload,
  extractCitations,
  type Citation,
} from '../lib/citations';

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

function ScrollToLatestSend({ pendingId }: { pendingId?: string }) {
  const { scrollToEnd } = useMessageScroller();
  const previousIdRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (!pendingId || pendingId === previousIdRef.current) return;
    previousIdRef.current = pendingId;
    scrollToEnd({ behavior: 'auto' });
  }, [pendingId, scrollToEnd]);

  return null;
}

function ScrollToPendingQuestion({ messageId }: { messageId?: string }) {
  const { scrollToMessage } = useMessageScroller();
  const previousIdRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (!messageId) {
      previousIdRef.current = undefined;
      return;
    }
    if (messageId === previousIdRef.current) return;
    previousIdRef.current = messageId;
    // Let the scroller finish its own layout pass first. Tall cards then open
    // at their heading instead of dropping the user halfway through the form.
    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      scrollToMessage(messageId, { align: 'start', behavior: 'auto', scrollMargin: 8 });
      // scrollToMessage first creates the room below an oversized card. Apply
      // the final position on the next frame after that spacer has laid out.
      settleFrame = window.requestAnimationFrame(() => {
        const item = document.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        item?.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [messageId, scrollToMessage]);

  return null;
}

function ScrollToLinkedMessage({ messageId, ready }: { messageId: string | null; ready: boolean }) {
  const { scrollToMessage } = useMessageScroller();

  useLayoutEffect(() => {
    if (!messageId || !ready) return;
    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      scrollToMessage(messageId, { align: 'center', behavior: 'auto', scrollMargin: 24 });
      settleFrame = window.requestAnimationFrame(() => {
        const item = document.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        if (!item) return;
        item.dataset.linkedFocus = 'true';
        item.scrollIntoView({ block: 'center', behavior: 'auto' });
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
      const item = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      delete item?.dataset.linkedFocus;
    };
  }, [messageId, ready, scrollToMessage]);

  return null;
}
const SESSION_IMAGE_RE = /\.(png|jpe?g|svg|gif|webp)$/i;
const SESSION_OFFICE_RE = /\.(docx|xlsx)$/i;
const OfficePreview = lazy(() =>
  import('../components/chat/OfficePreview').then((module) => ({ default: module.OfficePreview })),
);
const CLAUDE_LOGIN_ERROR_RE = /\bnot logged in\b[\s\S]*\/login\b/i;
// Let the final committed transcript render before a send requested during
// dictation reads and clears the draft.
const DICTATION_SEND_SETTLE_MS = 500;

// In-memory transcript cache, keyed by conversation id, living OUTSIDE React so
// it survives the keyed remount when you switch chats (App gives Chat a
// `key={conversationId}`, so React throws away all component state on every
// switch). Lets a re-opened chat paint its last-known transcript instantly —
// especially noticeable on mobile flipping back and forth — instead of showing
// an empty screen while the WebSocket snapshot round-trips. The snapshot is
// always authoritative and overwrites this on arrival; the cache is purely a
// paint-first placeholder. In-memory only, so it clears on a full page reload —
// that's fine, the snapshot rebuilds it. Bounded so a long-lived mobile tab
// can't accumulate every chat ever opened (transcripts can approach MB-scale).
type CachedTranscript = { transcript: TranscriptState; status: ConversationStatus; contextTokens: number | null };

/** One row in the composer's @-mention popup: an available connected account
 *  (one row PER install — "Gmail — Work" and "Gmail — Personal" are separate
 *  rows), or another chat. */
type MentionItem =
  | { kind: 'connector'; connector: ConnectorInfo; install: ConnectorInstall }
  | { kind: 'chat'; conv: Conversation };

function connectorAvailableIn(install: ConnectorInstall, projectId: string | null): boolean {
  if (install.status !== 'connected') return false;
  if (install.scopeMode === 'all') return true;
  return Boolean(projectId && install.projects.some((project) => project.id === projectId));
}
const transcriptCache = new Map<string, CachedTranscript>();
const TRANSCRIPT_CACHE_CAP = 25;
function cacheTranscript(id: string, entry: CachedTranscript) {
  // delete-then-set moves the entry to the newest slot (Map keeps insertion
  // order), giving us LRU eviction of the oldest untouched conversation.
  transcriptCache.delete(id);
  transcriptCache.set(id, entry);
  while (transcriptCache.size > TRANSCRIPT_CACHE_CAP) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest === undefined) break;
    transcriptCache.delete(oldest);
  }
}
// Images that arrive in tool results (browser screenshots, Read on an image,
// …) render as inline thumbnails in the transcript; tapping one opens the
// chat-level lightbox overlay. Deep rows reach that overlay through this
// context rather than prop-drilling a setter through ChatRow → ToolGroupRow.
interface LightboxImage {
  src: string;
  name: string;
}
const ImageLightboxContext = createContext<(img: LightboxImage) => void>(() => {});

// One picked file's journey through the composer: uploading → done (server
// path known) or error. previewUrl is a local object URL for image thumbnails.
interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  previewUrl: string | null;
  path: string | null;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function publishedArtifact(toolName: string, resultPreview: string): PublishedArtifact | null {
  const type = toolName.endsWith('publish_page') ? 'page' : toolName.endsWith('publish_app') ? 'app' : null;
  if (!type) return null;
  const id = new RegExp(`${type}_id:\\s*([^\\s]+)`, 'i').exec(resultPreview)?.[1];
  const url = /https?:\/\/[^\s]+/.exec(resultPreview)?.[0];
  return id && url ? { type, id, url } : null;
}

function playVoiceStoppedAlert(): void {
  const AudioContextClass =
    window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
    void ctx.resume().catch(() => undefined);
    window.setTimeout(() => void ctx.close().catch(() => undefined), 350);
  } catch {
    /* Audio alerts are best-effort; the visible error still tells the user. */
  }
}

export function Chat({
  conversationId,
  projectId: projectIdProp = null,
  todoId = null,
  backHash = null,
  focusMessageId = null,
  artifacts,
  onOpenArtifact,
  onRefreshArtifacts,
  onPublishArtifact,
  onOpenCitations,
  onOpenProjectFile,
  onOpenBrowser,
  onNavigate,
  onToast,
  sideChatButton = true,
}: {
  conversationId: string; // 'new' for a not-yet-created conversation
  // For a new chat, the project (folder) it will be created in (from the route);
  // for an existing chat this is ignored — its project is read from the server.
  projectId?: string | null;
  // For a new chat fired off from a todo (#/chat/new?todo=<id>): seed the draft
  // from that todo and, once sent, flip the todo to 'active' + link this chat.
  todoId?: string | null;
  // Automation-run chats return to their parent workspace on mobile.
  backHash?: string | null;
  /** queued_messages id from a sender-side agent handoff deep link. */
  focusMessageId?: string | null;
  artifacts: Artifact[];
  onOpenArtifact: (artifact: Artifact) => void;
  onRefreshArtifacts: () => Promise<Artifact[]>;
  onPublishArtifact: (artifact: PublishedArtifact) => Promise<void>;
  onOpenCitations: (citations: Citation[]) => void;
  onOpenProjectFile: (projectId: string, file: ProjectFileLocation) => void;
  onOpenBrowser?: () => void;
  onNavigate: (hash: string) => void;
  onToast: (message: string, action?: ToastAction) => void;
  /** Hidden when this chat is itself rendered inside a side chat panel. */
  sideChatButton?: boolean;
}) {
  const isNew = conversationId === 'new';
  const { show: showDesktop } = useFloatingDesktop();
  // The project this chat belongs to: the prop for a new chat, or the fetched
  // value for an existing one. Drives the back button's destination.
  const [projectId, setProjectId] = useState<string | null>(projectIdProp);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  // Paint-first from the in-memory cache on mount (see transcriptCache above):
  // shows the last-known transcript immediately while the WS snapshot reconciles.
  const [transcript, setTranscript] = useState<TranscriptState>(
    () => (isNew ? emptyTranscript() : transcriptCache.get(conversationId)?.transcript ?? emptyTranscript()),
  );
  // Keys present the moment a snapshot loads (history) skip the typewriter
  // reveal; only assistant text that streams in live during this session animates.
  // Seed from the cached paint too, so a re-opened chat's history doesn't re-type.
  const historicalKeysRef = useRef<Set<string>>(
    new Set(isNew ? [] : transcriptCache.get(conversationId)?.transcript.items.map((i) => i.key) ?? []),
  );
  const [status, setStatus] = useState<ConversationStatus>(
    () => (isNew ? 'idle' : transcriptCache.get(conversationId)?.status ?? 'idle'),
  );
  // Unsent composer text is persisted per conversation. A new chat uses its
  // project + source to keep drafts separate before a conversation id exists.
  const DKEY = (id: string) => `veneer.draft.${id}`;
  const [draft, setDraft] = useState(() => {
    if (isNew) return readNewChatDraft(projectIdProp, todoId);
    try {
      return localStorage.getItem(DKEY(conversationId)) ?? '';
    } catch {
      return '';
    }
  });
  const quoteStorageKey = `veneer.quote.${conversationId}`;
  const [messageThread, setMessageThread] = useState<{turn:string;at:string}|null>(null);
  const [messageQuote, setMessageQuote] = useState<MessageQuote | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(quoteStorageKey) ?? 'null');
      return saved && typeof saved.text === 'string' && typeof saved.role === 'string' ? saved : null;
    } catch { return null; }
  });
  useEffect(() => {
    try {
      if (messageQuote) localStorage.setItem(quoteStorageKey, JSON.stringify(messageQuote));
      else localStorage.removeItem(quoteStorageKey);
    } catch { /* The quote remains available in memory. */ }
  }, [messageQuote, quoteStorageKey]);
  const [creatingNewChat, setCreatingNewChat] = useState(false);
  useEffect(() => {
    if (isNew) {
      // Keep the submitted text in storage while the first turn starts. This
      // also protects it if the user leaves the screen before the request ends.
      if (!creatingNewChat) writeNewChatDraft(projectId, todoId, draft);
      return;
    }
    try {
      if (draft) localStorage.setItem(DKEY(conversationId), draft);
      else localStorage.removeItem(DKEY(conversationId));
    } catch {
      /* private mode / quota — draft still lives in component state */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, conversationId, creatingNewChat, isNew, projectId, todoId]);
  const [sendError, setSendError] = useState<string | null>(null);
  // For a new chat the agent type is chosen from the dropdown (default first);
  // for an existing chat it's fetched from the conversation.
  const [assistantSlug, setAssistantSlug] = useState<string>(() => (isNew ? '' : 'assistant'));
  const [assistantName, setAssistantName] = useState<string | null>(null);
  const [agentTypes, setAgentTypes] = useState<AssistantType[]>([]);
  const isPlatformDev = assistantSlug === 'platform-dev';
  // Which agent/model actually answered — resolved server-side once the first
  // turn runs, so this stays null for a brand-new, not-yet-sent chat.
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // Existing chats carry a nullable override plus its server-resolved effective
  // mode. New chats keep the override null until the user taps the shield chip.
  const [approvalModeOverride, setApprovalModeOverride] = useState<ApprovalMode | null>(null);
  const [effectiveApprovalMode, setEffectiveApprovalMode] = useState<ApprovalMode>('ask');
  const [conversationFullAccess, setConversationFullAccess] = useState(false);
  // Input tokens the provider processed on the most recent turn — the
  // conversation's current "context used". Seeded from the conversation on load,
  // then updated live from each turn_done event's usage. Null = no turn yet.
  const [contextTokens, setContextTokens] = useState<number | null>(
    () => (isNew ? null : transcriptCache.get(conversationId)?.contextTokens ?? null),
  );
  const contextRevisionRef = useRef(0);
  // Client-side echo of a message the moment it's sent — reconciled away once
  // the matching turn_started event lands in the transcript. Lets a message
  // sent mid-turn show as "queued" instead of silently vanishing until the
  // current turn finishes.
  const [pendingSends, setPendingSends] = useState<{ id: string; text: string; queued: boolean }[]>([]);
  // The runner/SQLite queue is authoritative. Every WebSocket snapshot carries
  // it, so switching chats or reconnecting cannot make waiting messages vanish.
  const [queued, setQueued] = useState<QueuedMessageSnapshot[]>([]);
  const [sendingQueuedId, setSendingQueuedId] = useState<number | null>(null);
  const [failedTurn, setFailedTurn] = useState<FailedTurnSnapshot | null>(null);
  const queuedRef = useRef<QueuedMessageSnapshot[]>([]);
  const activeQueueConversationRef = useRef(conversationId);
  activeQueueConversationRef.current = conversationId;
  const orderedQueueRef = useRef<OrderedQueueSnapshot | null>(null);
  const applyQueueSnapshot = useCallback((targetConversationId: string, snapshot: ConversationQueueSnapshot) => {
    // A request from the chat we just left can also finish late. It must not
    // alter the active chat, even if its snapshot has a larger revision.
    if (activeQueueConversationRef.current !== targetConversationId) return;
    const next = newestQueueSnapshot(orderedQueueRef.current, targetConversationId, snapshot);
    if (next === orderedQueueRef.current) return;
    orderedQueueRef.current = next;
    queuedRef.current = next.snapshot.messages;
    setQueued(next.snapshot.messages);
    setFailedTurn(next.snapshot.failedTurn);
  }, []);
  // Long-press-to-queue gesture state (shared by the send arrow AND the Stop
  // button — see the flush guard).
  const LONG_PRESS_MS = 450;
  const lpTimer = useRef<number | null>(null);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const lpFired = useRef(false); // shared latch, read by BOTH the send arrow AND the Stop button
  // Pending self-scheduled wake-ups for this chat. The snapshot frame seeds it
  // and the 'wakeups' frame keeps it live; local edits drop rows optimistically.
  const [wakeups, setWakeups] = useState<PendingWakeup[]>([]);
  const seenUserCountRef = useRef(
    isNew ? 0 : (transcriptCache.get(conversationId)?.transcript.items.filter((i) => i.kind === 'user').length ?? 0),
  );
  const [archived, setArchived] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [creator, setCreator] = useState<Conversation['creator'] | null>(null);
  const [visibility, setVisibility] = useState<Conversation['visibility']>('team');
  const [canSend, setCanSend] = useState(true);
  const [canManage, setCanManage] = useState(true);
  const [canChangeVisibility, setCanChangeVisibility] = useState(false);
  const [automation, setAutomation] = useState<Conversation['automation']>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [compactionBusy, setCompactionBusy] = useState(false);
  const [conversationActivity, setConversationActivity] = useState<ConversationActivity>(null);
  const [visibilityDialogOpen, setVisibilityDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [contextDialogOpen, setContextDialogOpen] = useState(false);

  // New-chat-only picker (server picks a default for anything left unset).
  // One combined choice across all providers; model '' = provider default.
  const [pick, setPick] = useState<{ provider: Provider; model: string }>({ provider: 'claude', model: '' });
  const [pickEffort, setPickEffort] = useState('');
  const activeProvider: Provider | null = isNew
    ? pick.provider
    : provider && isProvider(provider)
      ? provider
      : null;
  // The model/thinking chip opens this dialog (new-chat cross-provider picker,
  // or the mid-chat single-provider switcher — both feed the same UI).
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // New-chat picker groups models under one collapsible header per provider
  // (Claude, Codex …). Only one is open at a time — an accordion — and it
  // opens on the provider currently picked so the other stays out of the way.
  // Every provider's live models in one flat list (Claude's public Models API,
  // Codex's `model/list` RPC — see server/src/routes/api.ts GET /models),
  // minus the ones hidden in Settings. null while loading.
  const [modelChoices, setModelChoices] = useState<ModelChoice[] | null>(null);
  // Settings' default thinking level — re-applied when the picked provider
  // changes, since each provider has its own effort vocabulary.
  const defaultEffortRef = useRef<string | null>(null);
  // Loaded model prefs, kept for re-seeding the picker when the agent changes.
  const prefsRef = useRef<ModelPrefs | null>(null);
  // Late provider catalogs may refine an untouched saved default, but must
  // never replace a model or agent the user has already picked on this screen.
  const newChatSelectionTouchedRef = useRef(false);
  const loadedModelProvidersRef = useRef(new Set<Provider>());
  // A to-do chat appends this after its editable first message. Keep the
  // bundled default ready so a transient settings request failure never drops
  // the planning contract.
  const todoPlanningPromptRef = useRef(DEFAULT_TODO_PLANNING_PROMPT);

  // @-mention: reference another chat (agent looks it up / messages it via the
  // mcp__agents__* tools) or invoke a connector (inserts @<slug>, which the
  // agent's instructions explain — see materialize.ts connectorsNote).
  const screenRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Backdrop behind the composer textarea that paints pill highlights under
  // connector @mentions; its text is transparent, the textarea's is real.
  const composerHighlightRef = useRef<HTMLDivElement>(null);
  // Chat picks from the @-mention popup: clean `@<Title>` token in the draft,
  // the conversation id kept here until send appends it as a footer. Entries
  // whose token was edited out of the draft are simply never matched.
  const chatMentionMapRef = useRef(new Map<string, string>());
  const [composerFocused, setComposerFocused] = useState(false);
  const restoreChatViewport = useCallback(() => {
    setComposerFocused(false);
    const el = screenRef.current;
    if (!el) return;
    const style = chatViewportStyle(false, null);
    el.style.height = style.height;
    el.style.transform = style.transform;
  }, []);
  const [mentionable, setMentionable] = useState<Conversation[]>([]);
  const [mentionProjectNames, setMentionProjectNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [mentionableConnectors, setMentionableConnectors] = useState<ConnectorInfo[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null);
  const [skillsList, setSkillsList] = useState<SkillsList | null>(null);
  const [skillActive, setSkillActive] = useState(0);
  const [skillDismissedFor, setSkillDismissedFor] = useState<string | null>(null);
  const [skillDetailsOpen, setSkillDetailsOpen] = useState(false);

  // Voice dictation (the server-selected provider, proxied at /ws/stt). While
  // recording, `draft` is kept as dictationBase + live/committed speech text.
  const liveVoice = useLiveVoice();
  const listenToMessage = useMessageListen();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [sendingAfterDictation, setSendingAfterDictation] = useState(false);
  const dictationBaseRef = useRef('');
  // Speech updates append at the end, so keep their newest words visible. A
  // manual edit clears this latch and preserves the user's scroll position.
  const followDictationScrollRef = useRef(false);
  const pendingDictationSendRef = useRef<{
    dismissKeyboard: boolean;
    timer: number | null;
  } | null>(null);
  const sendRef = useRef<(dismissKeyboard?: boolean) => Promise<void>>(async () => undefined);

  const finishPendingDictationSend = useCallback((reason: 'user' | 'cancel' | 'unexpected') => {
    const pending = pendingDictationSendRef.current;
    if (!pending) return;
    if (reason !== 'user') {
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pendingDictationSendRef.current = null;
      setSendingAfterDictation(false);
      return;
    }
    if (pending.timer !== null) return;
    pending.timer = window.setTimeout(() => {
      if (pendingDictationSendRef.current !== pending) return;
      pendingDictationSendRef.current = null;
      setSendingAfterDictation(false);
      void sendRef.current(pending.dismissKeyboard);
    }, DICTATION_SEND_SETTLE_MS);
  }, []);

  const toggleDictation = useCallback(() => {
    if (transcribing || liveVoice.pinnedId) return;
    if (recording || micDictation.isActive) {
      micDictation.stop();
      return;
    }
    dictationBaseRef.current = draft;
    setSendError(null);
    setRecording(true);
    void micDictation
      .start({
        onPartial: (text) => {
          followDictationScrollRef.current = true;
          setDraft(joinDictation(dictationBaseRef.current, text));
        },
        onCommitted: (text) => {
          dictationBaseRef.current = joinDictation(dictationBaseRef.current, text);
          followDictationScrollRef.current = true;
          setDraft(dictationBaseRef.current);
        },
        onFinalizing: () => {
          setRecording(false);
          setTranscribing(true);
        },
        onError: (message) => setSendError(message),
        onEnd: (reason) => {
          setRecording(false);
          setTranscribing(false);
          finishPendingDictationSend(reason);
          if (reason === 'unexpected') playVoiceStoppedAlert();
        },
      })
      .catch((err: unknown) => {
        setSendError(err instanceof Error ? err.message : 'Could not access microphone');
        setRecording(false);
        setTranscribing(false);
        finishPendingDictationSend('unexpected');
      });
  }, [draft, recording, transcribing, finishPendingDictationSend, liveVoice.pinnedId]);

  // Don't leave the mic hot if the user navigates away mid-recording.
  useEffect(
    () => () => {
      const pending = pendingDictationSendRef.current;
      if (pending?.timer !== null && pending?.timer !== undefined) window.clearTimeout(pending.timer);
      pendingDictationSendRef.current = null;
      micDictation.stop('cancel');
    },
    [],
  );

  // Files the agent created in this chat (CSV etc.), detected server-side
  // from the session transcript. Refetched whenever a turn ends, so a file
  // the agent just wrote appears without a reload. Tap → preview dialog.
  const [sessionFiles, setSessionFiles] = useState<SessionFile[]>([]);
  const imageSources = useMemo(
    () => chatImageSources(conversationId, sessionFiles, artifacts),
    [conversationId, sessionFiles, artifacts],
  );
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);
  const [projectMarkdownPreview, setProjectMarkdownPreview] = useState<{ projectId: string; path: string } | null>(null);
  const liveToolNamesRef = useRef(new Map<string, string>());
  const publishArtifactRef = useRef(onPublishArtifact);
  publishArtifactRef.current = onPublishArtifact;

  // File attachments: picked → uploaded right away to /api/uploads (stored
  // under the server's data dir), then referenced by absolute path in the
  // sent message text so the agent can read them from disk.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tapping an image chip expands it over the transcript. Only the transcript
  // area is covered, so the composer stays fully usable underneath. Resolved
  // against the live list so removing or sending the attachment auto-dismisses it.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedImage = expandedId
    ? (attachments.find((a) => a.id === expandedId && a.previewUrl) ?? null)
    : null;
  // Second source for the same overlay: an image from a tool result in the
  // transcript (opened via ImageLightboxContext from a ToolRow thumbnail).
  const [expandedToolImage, setExpandedToolImage] = useState<LightboxImage | null>(null);
  const overlayImage =
    expandedToolImage ?? (expandedImage ? { src: expandedImage.previewUrl!, name: expandedImage.name } : null);
  const closeOverlay = useCallback(() => {
    setExpandedId(null);
    setExpandedToolImage(null);
  }, []);

  // Highlight the composer while a file is dragged over it. Without our own
  // drop handling the browser navigates to the dropped file (opens it in a
  // tab); catching it here routes the drop through the same addFiles path as
  // the paperclip picker.
  const [dragActive, setDragActive] = useState(false);

  const addFiles = useCallback((list: FileList | readonly File[] | null) => {
    if (!list?.length) return;
    setSendError(null);
    for (const file of Array.from(list)) {
      const id = crypto.randomUUID();
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, previewUrl, path: null, status: 'uploading' },
      ]);
      void api
        .uploadFile(file)
        .then((meta) =>
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: 'done' as const, path: meta.path, name: meta.name } : a)),
          ),
        )
        .catch((err: unknown) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' }
                : a,
            ),
          ),
        );
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Image previews hold object URLs — release them if the user navigates away
  // with files still staged.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    [],
  );

  // iOS keeps the layout viewport tall when its keyboard opens. While the
  // composer has focus, match both the visual viewport's size and its offset:
  // Safari can pan that viewport while focusing the textarea. Restore the full
  // layout height on blur because iOS can leave visualViewport at its stale
  // keyboard-sized height after the keyboard closes.
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const el = screenRef.current;
      if (!el) return;
      // Check the DOM focus too. A delayed visualViewport event must not put
      // the stale keyboard height back after the textarea has blurred.
      const style = chatViewportStyle(
        isChatKeyboardActive(composerFocused, textareaRef.current, document.activeElement),
        vv,
      );
      el.style.height = style.height;
      el.style.transform = style.transform;
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
    };
  }, [composerFocused]);

  // A new chat is always reached through an explicit user action, so start it
  // ready to type. autoFocus on the textarea covers the initial DOM commit;
  // this layout effect is a fallback for route/component transition timing.
  useLayoutEffect(() => {
    if (!isNew) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [isNew]);

  // Grow the composer with its content — scrollHeight counts wrapped lines,
  // which a rows={newline count} approach misses. The textarea's max-h caps
  // the growth; past that it scrolls internally.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const followEnd = followDictationScrollRef.current;
    followDictationScrollRef.current = false;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    // Keep the mention-highlight backdrop aligned when editing shifts the
    // textarea's internal scroll (it scrolls once past max-h).
    syncComposerScroll(el, composerHighlightRef.current, followEnd);
  }, [draft]);

  useEffect(() => {
    let stop = false;
    void Promise.all([
      api.conversations().then((r) => r.conversations).catch(() => null),
      api.projects().then((r) => r.projects).catch(() => null),
      api.connectors().then((r) => r.connectors).catch(() => null),
      skillsApi.list().catch(() => null),
    ]).then(([conversations, availableProjects, connectors, availableSkills]) => {
      if (stop) return;
      if (conversations) setMentionable(conversations);
      if (availableProjects) {
        setMentionProjectNames(new Map(availableProjects.map((project) => [project.id, project.name])));
      }
      if (connectors) setMentionableConnectors(connectors);
      if (availableSkills) setSkillsList(availableSkills);
    });
    return () => {
      stop = true;
    };
  }, [projectId]);

  const mentionableByRecentUse = useMemo(() => sortChatsByRecentUse(mentionable), [mentionable]);

  // Lowercase mention tokens of every install connected in this scope — the
  // composer's highlight overlay marks exactly these in the draft.
  const connectedMentions = useMemo(() => {
    const tokens = new Set<string>();
    for (const connector of mentionableConnectors)
      for (const install of connector.installs)
        if (connectorAvailableIn(install, projectId)) tokens.add(install.mention.toLowerCase());
    return tokens;
  }, [mentionableConnectors, projectId]);

  const mentionQuery = /@([^\s@]*)$/.exec(draft)?.[1] ?? null;
  // Connectors first (short, high-signal list), then other chats.
  const mentionItems: MentionItem[] =
    mentionQuery === null
      ? []
      : [
          ...mentionableConnectors
            .flatMap((connector) =>
              connector.installs
                .filter((install) => connectorAvailableIn(install, projectId))
                .map((install) => ({ kind: 'connector' as const, connector, install })),
            )
            .filter(({ connector, install }) =>
              `${connector.name} ${connector.slug} ${install?.label ?? ''} ${install?.mention ?? ''}`
                .toLowerCase()
                .includes(mentionQuery.toLowerCase()),
            )
            .slice(0, 4),
          ...mentionableByRecentUse
            .filter((c) => c.id !== conversationId)
            .filter((c) => (c.title ?? 'Untitled chat').toLowerCase().includes(mentionQuery.toLowerCase()))
            .slice(0, 6)
            .map((conv) => ({ kind: 'chat' as const, conv })),
        ];
  const showMentions = mentionQuery !== null && mentionDismissedFor !== mentionQuery && mentionItems.length > 0;

  const skillCommands = useMemo(
    () => availableSkillCommands(skillsList, { provider: activeProvider, projectId, platformDev: isPlatformDev }),
    [activeProvider, isPlatformDev, projectId, skillsList],
  );
  const skillQuery = skillQueryForDraft(draft);
  const skillItems = skillQuery === null ? [] : filterSkillCommands(skillCommands, skillQuery);
  const showSkills = skillQuery !== null && skillsList?.ok === true && skillDismissedFor !== skillQuery;
  const composerSkill = composerSkillForDraft(draft, skillCommands);
  const composerDraft = composerSkill?.request ?? draft;

  useEffect(() => {
    setMentionActive(0);
  }, [mentionQuery]);

  useEffect(() => {
    setSkillActive(0);
  }, [skillQuery]);

  const insertMention = useCallback(
    (item: MentionItem) => {
      setDraft((prev) => {
        const match = /@([^\s@]*)$/.exec(prev);
        if (!match) return prev;
        if (item.kind === 'connector') {
          return `${prev.slice(0, prev.length - match[0].length)}@${item.install.mention} `;
        }
        const label = item.conv.title?.trim() || 'Untitled chat';
        // Clean token only — the id rides in a footer appended at send time
        // (appendChatMentionFooter), so the draft never shows a raw chat id.
        chatMentionMapRef.current.set(`@${label}`, item.conv.id);
        return `${prev.slice(0, prev.length - match[0].length)}@${label} `;
      });
      setMentionDismissedFor(null);
      textareaRef.current?.focus();
    },
    [],
  );

  const insertSkill = useCallback((item: SkillCommand) => {
    if (item.conflict) return;
    setDraft(`/${item.name} `);
    setSkillDismissedFor(null);
    setSkillDetailsOpen(false);
    textareaRef.current?.focus();
  }, []);

  const removeComposerSkill = useCallback(() => {
    if (!composerSkill) return;
    setDraft(composerSkill.request);
    setSkillDetailsOpen(false);
    textareaRef.current?.focus();
  }, [composerSkill]);

  // The project's name for the header label (both new and existing chats).
  useEffect(() => {
    if (!projectId) {
      setProjectName(null);
      return;
    }
    let stop = false;
    void api.project(projectId).then((r) => {
      if (!stop) setProjectName(r.project.name);
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [projectId]);

  // Fire-off seeding: a new chat opened from a todo (#/chat/new?todo=<id>)
  // prefills the draft once from that todo — title, blank line, notes (if any),
  // blank line, then each link/file href on its own line. Guarded by a ref so a
  // later re-render never clobbers what the user has since typed; also skipped
  // if the draft is already non-empty.
  const todoSeededRef = useRef(false);
  useEffect(() => {
    if (!isNew || !todoId || todoSeededRef.current) return;
    todoSeededRef.current = true;
    let stop = false;
    void api
      .todos()
      .then(({ todos }) => {
        if (stop) return;
        const todo = todos.find((t) => t.id === todoId);
        if (!todo) return;
        const parts: string[] = [todo.title.trim()];
        if (todo.notes.trim()) parts.push(todo.notes.trim());
        const hrefs = [
          ...todo.links.filter((l) => l.kind === 'link').map((l) => l.href),
          ...todo.links.filter((l) => l.kind === 'file').map((l) => l.href),
        ].filter(Boolean);
        if (hrefs.length) parts.push(hrefs.join('\n'));
        const seeded = parts.join('\n\n');
        setDraft((prev) => (prev.trim() ? prev : seeded));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [isNew, todoId]);

  useEffect(() => {
    if (isNew) return; // new-chat setup (agents + picker) is handled below.
    let stop = false;
    const contextRevision = contextRevisionRef.current;
    // Existing conversations don't carry the assistant in the WS snapshot.
    void api.conversation(conversationId).then((r) => {
      if (stop) return;
      setAssistantSlug(r.conversation.assistantSlug);
      setAssistantName(r.conversation.assistantName);
      setProvider(r.conversation.provider);
      setModel(r.conversation.model);
      setLastAnsweredModel(r.conversation.lastAnsweredModel ?? null);
      setEffort(r.conversation.effort);
      setApprovalModeOverride(r.conversation.approvalMode);
      setEffectiveApprovalMode(r.conversation.effectiveApprovalMode);
      setConversationFullAccess(r.conversation.fullAccess);
      setArchived(r.conversation.archived);
      setPinned(r.conversation.pinOrder !== null);
      setTitle(r.conversation.title);
      setCreator(r.conversation.creator);
      setVisibility(r.conversation.visibility);
      setCanSend(r.conversation.canSend);
      setCanManage(r.conversation.canManage);
      setCanChangeVisibility(r.conversation.canChangeVisibility);
      setProjectId(r.conversation.projectId);
      if (contextRevisionRef.current === contextRevision) setContextTokens(r.conversation.contextTokens);
      setAutomation(r.conversation.automation);
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [conversationId, isNew]);

  useEffect(() => {
    if (!isNew) return;
    let stop = false;
    let stopModelLoading: () => void = () => undefined;
    void Promise.all([
      api.assistants().then((r) => r.assistants).catch(() => [] as AssistantType[]),
      api.modelPrefs().then((r) => r.prefs).catch(() => null),
      api.projects().then((r) => r.projects).catch(() => [] as Project[]),
      todoId
        ? api.todoPlanningSettings().then((r) => r.settings).catch(() => null)
        : Promise.resolve(null),
    ]).then(([assistants, prefs, availableProjects, todoPlanningSettings]) => {
      if (stop) return;
      setAgentTypes(assistants);
      setProjects(availableProjects);
      prefsRef.current = prefs;
      if (todoPlanningSettings) todoPlanningPromptRef.current = todoPlanningSettings.prompt;
      defaultEffortRef.current = prefs?.defaultEffort ?? null;
      newChatSelectionTouchedRef.current = false;
      loadedModelProvidersRef.current = new Set();
      // Open on the saved default agent (if still selectable), else the built-in
      // one; then seed the model/thinking picker from that agent's default.
      const available = new Set(assistants.map((a) => a.slug));
      const projectDefault = availableProjects.find((project) => project.id === projectId)?.defaultAgent;
      const slug = projectDefault && available.has(projectDefault)
        ? projectDefault
        : prefs?.defaultAgent && available.has(prefs.defaultAgent)
          ? prefs.defaultAgent
          : (assistants.find((a) => a.isDefault) ?? assistants.find((a) => !a.adminOnly) ?? assistants[0])?.slug ?? '';
      setAssistantSlug(slug);
      const seed = resolveAgentPickWithCatalogs(slug, prefs, null, loadedModelProvidersRef.current, true);
      setPick({ provider: seed.provider, model: seed.model });
      setPickEffort(seed.effort);

      stopModelLoading = loadModelCatalogsProgressively(
        (provider) => api.models(provider).then((result) => result.models),
        (catalogs, settledProvider) => {
          if (stop) return;
          if (settledProvider) loadedModelProvidersRef.current.add(settledProvider);
          const choices = buildModelChoices(
            catalogs,
            prefs?.hiddenModels ?? [],
            prefs?.providerDefaults ?? {},
            prefs?.modelOrder ?? {},
          );
          setModelChoices(choices);
          // Only the selected provider can validate the saved model/effort.
          // Once the user acts, every late response becomes list-only data.
          if (settledProvider) {
            const refined = refineAgentPickAfterCatalog(
              slug,
              prefs,
              choices,
              loadedModelProvidersRef.current,
              settledProvider,
              newChatSelectionTouchedRef.current,
              true,
            );
            if (refined) {
              setPick({ provider: refined.provider, model: refined.model });
              setPickEffort(refined.effort);
            }
          }
        },
      );
    });
    return () => {
      stop = true;
      stopModelLoading();
    };
  }, [isNew, todoId]);

  // Switching the agent type re-seeds the picker from that agent's Settings
  // default (each agent can have its own model + thinking).
  const chooseAgent = useCallback(
    (slug: string, preferGlobalProvider = false) => {
      newChatSelectionTouchedRef.current = true;
      setAssistantSlug(slug);
      if (slug === 'platform-dev') setApprovalModeOverride(null);
      const seed = resolveAgentPickWithCatalogs(
        slug,
        prefsRef.current,
        modelChoices,
        loadedModelProvidersRef.current,
        preferGlobalProvider,
      );
      setPick({ provider: seed.provider, model: seed.model });
      setPickEffort(seed.effort);
    },
    [modelChoices],
  );

  const chooseProject = useCallback(
    (nextProjectId: string | null) => {
      moveNewChatDraft(projectId, nextProjectId, todoId, draft);
      // Put the selected project in the route. If the user leaves and returns,
      // this exact new-chat scope now opens and reads the matching stored draft.
      const [, query = ''] = window.location.hash.split('?');
      const params = new URLSearchParams(query);
      if (nextProjectId) params.set('project', nextProjectId);
      else params.delete('project');
      const nextQuery = params.toString();
      onNavigate(`#/chat/new${nextQuery ? `?${nextQuery}` : ''}`);
    },
    [draft, onNavigate, projectId, todoId],
  );

  // The model is only known once a turn has actually run (the CLI resolves
  // its own default); re-fetch after each turn to pick up what just answered.
  useEffect(() => {
    if (isNew || status === 'working' || status === 'needs_you') return;
    let stop = false;
    const contextRevision = contextRevisionRef.current;
    void api.conversation(conversationId).then((r) => {
      if (stop) return;
      setProvider(r.conversation.provider);
      setModel(r.conversation.model);
      setLastAnsweredModel(r.conversation.lastAnsweredModel ?? null);
      setEffort(r.conversation.effort);
      setApprovalModeOverride(r.conversation.approvalMode);
      setEffectiveApprovalMode(r.conversation.effectiveApprovalMode);
      setConversationFullAccess(r.conversation.fullAccess);
      if (contextRevisionRef.current === contextRevision) setContextTokens(r.conversation.contextTokens);
      // Pick up an auto-generated title (LLM auto-naming or the provider's own
      // rolling title) that landed while the turn ran.
      setTitle(r.conversation.title);
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [conversationId, isNew, status]);

  const [chatModelOptions, setChatModelOptions] = useState<ModelOption[]>([]);
  const [chatPick, setChatPick] = useState<ModelThinkingValue>({ provider: 'claude', model: '', effort: '' });
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [lastAnsweredModel, setLastAnsweredModel] = useState<string | null>(null);
  useEffect(() => {
    if (isNew || !provider || !isProvider(provider)) return;
    let stop = false;
    let stopLoading = () => {};
    void api.modelPrefs().then((r) => r.prefs).catch(() => null).then((prefs) => {
      if (stop) return;
      defaultEffortRef.current = prefs?.defaultEffort ?? null;
      stopLoading = loadModelCatalogsProgressively(
        (target) => api.models(target).then((result) => result.models),
        (catalogs) => {
          if (stop) return;
          setChatModelOptions(catalogs[provider]);
          setModelChoices(buildExistingChatModelChoices(catalogs, prefs?.hiddenModels ?? [], prefs?.modelOrder ?? {}));
        },
      );
    });
    return () => { stop = true; stopLoading(); };
  }, [isNew, provider]);
  useEffect(() => {
    if (!isNew && modelPickerOpen && provider && isProvider(provider)) {
      setChatPick({ provider, model: model ?? '', effort: effort ?? '' });
      setModelError(null);
    }
  }, [isNew, modelPickerOpen, provider, model, effort]);
  const applyChatModel = async () => {
    if (modelSaving) return;
    setModelSaving(true);
    setModelError(null);
    try {
      const { conversation } = await api.switchConversationModel(conversationId, chatPick);
      setProvider(conversation.provider);
      setModel(conversation.model);
      setEffort(conversation.effort);
      setLastAnsweredModel(conversation.lastAnsweredModel ?? null);
      setContextTokens(conversation.contextTokens);
      setModelPickerOpen(false);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : 'Could not switch models.');
    } finally {
      setModelSaving(false);
    }
  };
  const selectedAgent = agentTypes.find((agent) => agent.slug === assistantSlug);
  const hasFullAccess = isNew ? Boolean(selectedAgent?.full_access) : conversationFullAccess;
  const shownApprovalMode = resolveEffectiveApprovalMode(
    hasFullAccess,
    isNew ? approvalModeOverride : null,
    isNew ? selectedAgent?.approval_mode : effectiveApprovalMode,
  );
  const setChatApprovalMode = useCallback((next: ApprovalMode) => {
    if (hasFullAccess) return;
    if (next === shownApprovalMode) return;
    if (isNew) {
      setApprovalModeOverride(next);
      return;
    }
    const previousOverride = approvalModeOverride;
    const previousEffective = effectiveApprovalMode;
    setApprovalModeOverride(next);
    setEffectiveApprovalMode(next);
    void api
      .updateConversation(conversationId, { approval_mode: next })
      .catch(() => {
        setApprovalModeOverride(previousOverride);
        setEffectiveApprovalMode(previousEffective);
      });
  }, [approvalModeOverride, conversationId, effectiveApprovalMode, hasFullAccess, isNew, shownApprovalMode]);
  // Live subscription (snapshot + deltas over the multiplexed socket).
  useEffect(() => {
    // Chat-mention token → id mappings belong to one conversation's draft.
    chatMentionMapRef.current = new Map();
    setConversationActivity(null);
    // Never carry another chat's self wake-up marker across the subscription handoff.
    setWakeups([]);
    if (isNew) {
      setTranscript(emptyTranscript());
      setStatus('idle');
      setPendingSends([]);
      applyQueueSnapshot(conversationId, { revision: 0, messages: [], failedTurn: null });
      seenUserCountRef.current = 0;
      setContextTokens(null);
      return;
    }
    return wsBus.subscribe(conversationId, {
      onSnapshot: (events, snapStatus, queue, activity, snapWakeups) => {
        liveToolNamesRef.current.clear();
        const next = reduceEvents(emptyTranscript(), events);
        historicalKeysRef.current = new Set(next.items.map((i) => i.key));
        setTranscript(next);
        setStatus(snapStatus);
        setConversationActivity(activity);
        applyQueueSnapshot(conversationId, queue);
        setWakeups(snapWakeups);
        const userItems = next.items.filter((i) => i.kind === 'user');
        const lastUser = userItems.at(-1);
        // A reconnect can replace the live event that would normally reconcile
        // the local "Sending…" echo. If the authoritative snapshot already has
        // that running message, clear the echo; queued messages render below
        // from `queue` instead.
        if (lastUser) {
          setPendingSends((prev) => (prev[0]?.text === lastUser.text ? prev.slice(1) : prev));
        }
        seenUserCountRef.current = userItems.length;
        // A reconnect can miss the live context_compacted signal. The DB value
        // is authoritative and is cleared on successful maintenance.
        const contextRevision = contextRevisionRef.current;
        void api
          .conversation(conversationId)
          .then((result) => {
            if (contextRevisionRef.current === contextRevision) {
              setContextTokens(result.conversation.contextTokens);
            }
          })
          .catch(() => undefined);
      },
      onEvent: (event) => {
        if (event.type === 'tool_started') {
          const started = event as { toolId?: unknown; toolName?: unknown };
          liveToolNamesRef.current.set(String(started.toolId ?? ''), String(started.toolName ?? ''));
        } else if (event.type === 'tool_finished') {
          const finished = event as { toolId?: unknown; ok?: unknown; resultPreview?: unknown };
          const toolId = String(finished.toolId ?? '');
          const toolName = liveToolNamesRef.current.get(toolId) ?? '';
          liveToolNamesRef.current.delete(toolId);
          if (finished.ok) {
            const published = publishedArtifact(toolName, String(finished.resultPreview ?? ''));
            if (published) void publishArtifactRef.current(published);
          }
        }
        // Keep the composer's context readout live: each completed turn reports
        // the input tokens the provider just processed. (The union's catch-all
        // member widens `usage` to unknown, so read it through a narrow cast.)
        if (event.type === 'context_compacted') {
          contextRevisionRef.current += 1;
          setContextTokens(typeof event.contextTokens === 'number' ? event.contextTokens : null);
        } else if (event.type === 'turn_done') {
          const usage = (event as { usage?: { inputTokens?: number } }).usage;
          if (typeof usage?.inputTokens === 'number') {
            contextRevisionRef.current += 1;
            setContextTokens(usage.inputTokens);
          }
        }
        setTranscript((prev) => {
          const next = reduceEvents(prev, [event]);
          // A streamed reply that just finalized (the live buffer cleared and a
          // fresh assistant item was appended) was already fully shown in the
          // streaming ghost bubble — mark it historical so its final render
          // doesn't blank out and re-type from the first character.
          if (prev.streamingText && !next.streamingText) {
            const lastAssistant = next.items.findLast((i) => i.kind === 'assistant');
            if (lastAssistant) historicalKeysRef.current.add(lastAssistant.key);
          }
          return next;
        });
      },
      onStatus: (nextStatus, activity) => {
        setStatus(nextStatus);
        setConversationActivity(activity);
      },
      onQueue: (queue) => applyQueueSnapshot(conversationId, queue),
      onWakeups: (next) => setWakeups(next),
      onError: (message) => {
        if (message === 'Conversation access changed' || message === 'Conversation not found') {
          onNavigate(projectId ? `#/?project=${projectId}` : '#/');
        }
      },
    });
  }, [conversationId, isNew, applyQueueSnapshot, onNavigate, projectId]);

  // Write-through to the in-memory cache: every rendered transcript/status keeps
  // this conversation's cached paint current, so switching away (which unmounts
  // this component) and back re-seeds from the latest state instead of blanking.
  useEffect(() => {
    if (isNew) return;
    cacheTranscript(conversationId, { transcript, status, contextTokens });
  }, [conversationId, isNew, transcript, status, contextTokens]);

  // A locally-echoed send is "confirmed" once its matching turn_started event
  // shows up as a real transcript item — pop pending entries in send order as
  // real ones arrive (turns are strictly serialized per conversation, so FIFO
  // order always matches).
  useEffect(() => {
    const userItems = transcript.items.filter((i) => i.kind === 'user');
    const seen = seenUserCountRef.current;
    if (userItems.length <= seen) {
      seenUserCountRef.current = userItems.length;
      return;
    }
    const fresh = userItems.slice(seen);
    seenUserCountRef.current = userItems.length;
    setPendingSends((prev) => {
      let next = prev;
      for (const item of fresh) {
        if (next[0]?.text === item.text) next = next.slice(1);
      }
      return next;
    });
  }, [transcript.items]);

  // One-time upgrade path for messages staged by the former browser-only queue.
  // Move each into SQLite, deleting its local copy only after the POST succeeds.
  useEffect(() => {
    if (isNew) return;
    const key = `veneer.queue.${conversationId}`;
    let cancelled = false;
    let legacy: { id?: string; text: string }[] = [];
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) legacy = parsed.filter((item) => typeof item?.text === 'string' && item.text.trim());
    } catch {
      return;
    }
    if (!legacy.length) return;
    void (async () => {
      for (let i = 0; i < legacy.length && !cancelled; i++) {
        const item = legacy[i]!;
        try {
          const posted = await api.queueMessage(conversationId, item.text);
          if (cancelled) return;
          applyQueueSnapshot(conversationId, posted.queue);
          const remaining = legacy.slice(i + 1);
          if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
          else localStorage.removeItem(key);
        } catch (err) {
          if (!cancelled) setSendError(`Could not restore a queued message: ${(err as Error).message}`);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, isNew, applyQueueSnapshot]);

  // A turn is also in flight while an approval is pending (process is waiting on us).
  const working = status === 'working' || status === 'needs_you';
  const compacting = compactionBusy || conversationActivity === 'compacting';

  // Upgrade already-running archived chats created before the server-side
  // reactivation rule shipped. A reconnect after the web restart repairs the
  // metadata without interrupting the live agent.
  useEffect(() => {
    if (isNew || !archived || !working) return;
    let stopped = false;
    void api
      .updateConversation(conversationId, { archived: false })
      .then(() => {
        if (!stopped) setArchived(false);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [archived, conversationId, isNew, working]);

  // Refresh the created-files list on load and each time a turn finishes
  // (`working` flipping back to false is the "reply landed" signal).
  useEffect(() => {
    if (isNew) return;
    let stop = false;
    void onRefreshArtifacts();
    void api
      .conversationFiles(conversationId)
      .then((r) => {
        if (!stop) setSessionFiles(r.files);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [conversationId, isNew, onRefreshArtifacts, working]);

  const send = useCallback(async (dismissKeyboard = false) => {
    if (creatingNewChat) return;
    const pendingDictationSend = pendingDictationSendRef.current;
    if (pendingDictationSend) {
      // A second Enter/click while the transcript is settling belongs to the
      // same intent; remember the stronger keyboard-dismiss preference only.
      pendingDictationSend.dismissKeyboard ||= dismissKeyboard;
      return;
    }
    if (transcribing || micDictation.isFinalizing || recording || micDictation.isActive) {
      pendingDictationSendRef.current = { dismissKeyboard, timer: null };
      setSendingAfterDictation(true);
      setSendError(null);
      if (recording || micDictation.isActive) micDictation.stop();
      return;
    }
    const text = draft.trim();
    const readyFiles = attachments.filter((a) => a.status === 'done' && a.path);
    if (!text && !messageQuote && readyFiles.length === 0) return;
    if (attachments.some((a) => a.status === 'uploading')) {
      setSendError('Still uploading — one moment…');
      return;
    }
    // A touch tap on Send should give the conversation its screen space back.
    // Keep hardware/mouse sends focused so desktop users can keep typing.
    if (dismissKeyboard) {
      textareaRef.current?.blur();
      // iOS can keep the old keyboard-sized visualViewport after blur. Reset
      // the inline height now instead of waiting for another viewport event.
      restoreChatViewport();
    }
    // Attachments travel as absolute paths appended to the message — every
    // agent has filesystem access and reads them from disk directly.
    const withFiles = readyFiles.length
      ? `${text ? `${text}\n\n` : ''}Attached files (saved on this server — read them from these paths):\n${readyFiles
          .map((a) => `- ${a.path}`)
          .join('\n')}`
      : text;
    // Chat @mentions: the visible prompt keeps the clean `@<Title>` tokens; the
    // ids the agent needs go into a machine-readable footer the transcript
    // strips again. Only tokens still present in the draft are attached.
    const chatMentions = chatMentionsInText(text, chatMentionMapRef.current);
    const visibleOutgoing = appendChatMentionFooter(appendMessageQuote(withFiles, messageQuote), chatMentions);
    const invokedSkill = skillNameForPrompt(text, skillCommands);
    // Keep the seeded to-do text clean and editable in the composer, then add
    // the planning-only contract only at submission. Ordinary new chats and
    // every later turn are intentionally unaffected.
    const submittedVisible = isNew
      ? newChatSubmissionPrompt(visibleOutgoing, todoId, todoPlanningPromptRef.current)
      : visibleOutgoing;
    const submitted = appendSkillInvocationMarker(submittedVisible, invokedSkill);
    const outgoing = appendSkillInvocationMarker(visibleOutgoing, invokedSkill);
    const stagedAttachments = attachments;
    // For a new chat, keep the stored copy until the server confirms creation.
    // The empty composer prevents a duplicate send while that request runs.
    if (isNew) writeNewChatDraft(projectId, todoId, text);
    setDraft('');
    setMessageQuote(null);
    setAttachments([]);
    setSendError(null);
    const restore = () => {
      setDraft(text);
      setMessageQuote(messageQuote);
      setAttachments(stagedAttachments);
    };
    const releasePreviews = () => {
      for (const a of stagedAttachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    };
    if (isNew) {
      const optimisticId = crypto.randomUUID();
      setCreatingNewChat(true);
      startPendingNewChat({ id: optimisticId, projectId, todoId });
      try {
        const { conversation } = await api.createConversation(submitted, {
          id: optimisticId,
          assistantSlug,
          provider: pick.provider,
          model: pick.model || undefined,
          effort: pickEffort || undefined,
          approval_mode: isPlatformDev ? undefined : approvalModeOverride ?? undefined,
          projectId: projectId ?? undefined,
          visibility,
        });
        writeNewChatDraft(projectId, todoId, '');
        completePendingNewChat(optimisticId, conversation);
        setCreatingNewChat(false);
        releasePreviews();
        // Fire-off: link the source todo to the freshly-created chat, mark it
        // active, and synchronize the project actually selected at send time.
        // Fire-and-forget — never block navigation on it.
        if (todoId) {
          void api
            .updateTodo(todoId, {
              state: 'active',
              conversationId: conversation.id,
              projectId: conversation.projectId,
            })
            .catch(() => undefined);
        }
        // Keep the project in the URL so the sidebar list stays expanded on it
        // with this new chat highlighted (matches how project chats are opened).
        onNavigate(
          conversation.projectId
            ? `#/chat/${conversation.id}?project=${conversation.projectId}`
            : `#/chat/${conversation.id}`,
        );
      } catch (err) {
        failPendingNewChat(optimisticId);
        setCreatingNewChat(false);
        setSendError((err as Error).message);
        restore();
      }
      return;
    }
    const pendingId = crypto.randomUUID();
    // Queued (not just "sending") whenever a turn is already running, or
    // something else already sent is still waiting ahead of it.
    setPendingSends((prev) => [...prev, { id: pendingId, text: outgoing, queued: working || prev.length > 0 }]);
    try {
      const posted = await api.sendMessage(conversationId, outgoing);
      if (archived) setArchived(false);
      applyQueueSnapshot(conversationId, posted.queue);
      if (posted.disposition === 'queued') {
        // The durable queue row now renders in the transcript; avoid a duplicate
        // transient bubble. Running sends remain until turn_started lands.
        setPendingSends((prev) => prev.filter((pending) => pending.id !== pendingId));
      } else {
        setPendingSends((prev) =>
          prev.map((pending) => (pending.id === pendingId ? { ...pending, queued: false } : pending)),
        );
      }
      releasePreviews();
    } catch (err) {
      setPendingSends((prev) => prev.filter((p) => p.id !== pendingId));
      setSendError((err as Error).message);
      restore();
    }
  }, [draft, messageQuote, attachments, recording, transcribing, isNew, assistantSlug, pick, pickEffort, projectId, visibility, todoId, conversationId, onNavigate, working, applyQueueSnapshot, archived, restoreChatViewport, creatingNewChat, skillCommands]);
  sendRef.current = send;

  // Long-press-to-queue: persist immediately through the same server-authoritative
  // path as a normal mid-turn send. Returns synchronously so the gesture can
  // latch; failures restore the draft and attachments.
  const queueDraft = useCallback(() => {
    if (transcribing || micDictation.isFinalizing) {
      setSendError('Finishing dictation — one moment…');
      return false;
    }
    if (recording || micDictation.isActive) {
      micDictation.stop();
      return false;
    }
    const text = draft.trim();
    const readyFiles = attachments.filter((a) => a.status === 'done' && a.path);
    if (!text && !messageQuote && readyFiles.length === 0) return false;
    if (attachments.some((a) => a.status === 'uploading')) {
      setSendError('Still uploading — one moment…');
      return false;
    }
    const withFiles = readyFiles.length
      ? `${text ? `${text}\n\n` : ''}Attached files (saved on this server — read them from these paths):\n${readyFiles
          .map((a) => `- ${a.path}`)
          .join('\n')}`
      : text;
    const invokedSkill = skillNameForPrompt(text, skillCommands);
    const outgoing = appendSkillInvocationMarker(
      appendChatMentionFooter(appendMessageQuote(withFiles, messageQuote), chatMentionsInText(text, chatMentionMapRef.current)),
      invokedSkill,
    );
    const stagedAttachments = attachments;
    setDraft('');
    setMessageQuote(null);
    setAttachments([]);
    setSendError(null);
    const pendingId = crypto.randomUUID();
    setPendingSends((prev) => [...prev, { id: pendingId, text: outgoing, queued: true }]);
    void api
      .queueMessage(conversationId, outgoing)
      .then((posted) => {
        if (archived) setArchived(false);
        applyQueueSnapshot(conversationId, posted.queue);
        if (posted.disposition === 'queued') {
          setPendingSends((prev) => prev.filter((pending) => pending.id !== pendingId));
        } else {
          setPendingSends((prev) =>
            prev.map((pending) => (pending.id === pendingId ? { ...pending, queued: false } : pending)),
          );
        }
        for (const attachment of stagedAttachments) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
      })
      .catch((err) => {
        setPendingSends((prev) => prev.filter((pending) => pending.id !== pendingId));
        setDraft(text);
        setMessageQuote(messageQuote);
        setAttachments(stagedAttachments);
        setSendError((err as Error).message);
      });
    return true;
  }, [draft, messageQuote, attachments, recording, transcribing, conversationId, applyQueueSnapshot, archived, skillCommands]);

  // Edit a queued message: pull it back into the composer. Only allowed when
  // the composer is empty, so an in-progress draft is never clobbered.
  const editQueued = useCallback(
    (id: number) => {
      if (draft.trim() || messageQuote) return;
      const item = queued.find((q) => q.id === id);
      if (!item) return;
      void api
        .removeQueuedMessage(conversationId, id)
        .then((result) => {
          applyQueueSnapshot(conversationId, result.queue);
          if (!result.ok) {
            setSendError('That message has already started.');
            return;
          }
          // Restore the clean prompt; re-arm the token → id map so a resend
          // rebuilds the footer for tokens still present.
          const unmarked = splitSkillInvocationMarker(item.text).visible;
          const { visible, chatTokens } = splitChatMentionFooter(unmarked);
          for (const [token, chatId] of chatTokens) chatMentionMapRef.current.set(token, chatId);
          setDraft(visible);
          textareaRef.current?.focus();
        })
        .catch((err) => setSendError((err as Error).message));
    },
    [draft, messageQuote, queued, conversationId, applyQueueSnapshot],
  );

  const removeQueued = useCallback(
    (id: number) => {
      void api
        .removeQueuedMessage(conversationId, id)
        .then((result) => {
          applyQueueSnapshot(conversationId, result.queue);
          if (!result.ok) setSendError('That message has already started.');
        })
        .catch((err) => setSendError((err as Error).message));
    },
    [conversationId, applyQueueSnapshot],
  );

  // The 'wakeups' frame is authoritative, but dropping the row on success keeps
  // the chip from lingering for a tick after the user acts on it.
  const cancelWakeup = useCallback(
    (id: string) => {
      setWakeups((prev) => prev.filter((wake) => wake.id !== id));
      void api
        .cancelWakeup(conversationId, id)
        .catch((err) => setSendError((err as Error).message));
    },
    [conversationId],
  );

  const fireWakeup = useCallback(
    (id: string) => {
      setWakeups((prev) => prev.filter((wake) => wake.id !== id));
      void api.fireWakeup(conversationId, id).catch((err) => setSendError((err as Error).message));
    },
    [conversationId],
  );

  const rescheduleWakeup = useCallback(
    (id: string, runAt: string) =>
      api.rescheduleWakeup(conversationId, id, runAt).then((result) => {
        if (result.ok) {
          setWakeups((prev) =>
            prev.map((wake) => (wake.id === id ? { ...wake, scheduledFor: runAt } : wake)),
          );
        }
        return result;
      }),
    [conversationId],
  );

  const sendQueuedNow = useCallback(
    (id: number) => {
      setSendingQueuedId(id);
      setSendError(null);
      void api
        .sendQueuedMessageNow(conversationId, id)
        .then((result) => {
          applyQueueSnapshot(conversationId, result.queue);
          if (!result.ok) setSendError('That message has already started or can no longer be sent now.');
        })
        .catch((err) => setSendError((err as Error).message))
        .finally(() => setSendingQueuedId(null));
    },
    [conversationId, applyQueueSnapshot],
  );

  const resolveFailedTurn = useCallback(
    (action: 'retry' | 'skip') => {
      const request = action === 'retry' ? api.retryFailedTurn(conversationId) : api.discardFailedTurn(conversationId);
      void request
        .then((result) => {
          applyQueueSnapshot(conversationId, result.queue);
          if (!result.ok) setSendError('That failed turn is no longer waiting.');
        })
        .catch((err) => setSendError((err as Error).message));
    },
    [conversationId, applyQueueSnapshot],
  );

  // Send-button gesture handlers: a normal tap sends; a ~450ms hold queues.
  const canStage = () => Boolean(draft.trim() || messageQuote) || attachments.some((a) => a.status === 'done');
  const cancelLp = () => {
    if (lpTimer.current != null) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
    lpStart.current = null;
  };
  const onSendPointerDown = (e: React.PointerEvent) => {
    lpFired.current = false;
    if (isNew || !canStage()) return; // no queue on new chat / empty composer
    lpStart.current = { x: e.clientX, y: e.clientY };
    lpTimer.current = window.setTimeout(() => {
      lpTimer.current = null;
      if (queueDraft()) {
        lpFired.current = true;
        navigator.vibrate?.(15);
      }
    }, LONG_PRESS_MS);
  };
  const onSendPointerMove = (e: React.PointerEvent) => {
    const s = lpStart.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancelLp(); // finger slid → abort long-press
  };
  const onSendPointerUp = (e: React.PointerEvent) => {
    cancelLp();
    if (lpFired.current) {
      lpFired.current = false;
      return; // R1: long-press must NOT also send
    }
    void send(shouldDismissChatKeyboard(e.pointerType, IS_TOUCH));
  };

  const moveQueued = useCallback((id: number, direction: -1 | 1) => {
    const current = queuedRef.current;
    const from = current.findIndex((message) => message.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    const next = [...current];
    const [message] = next.splice(from, 1);
    if (!message) return;
    next.splice(to, 0, message);
    queuedRef.current = next;
    setQueued(next);
    void api
      .reorderQueuedMessages(
        conversationId,
        next.map((queuedMessage) => queuedMessage.id),
      )
      .then((result) => {
        applyQueueSnapshot(conversationId, result.queue);
        if (!result.ok) setSendError('The queue changed while you were reordering it.');
      })
      .catch((err) => setSendError((err as Error).message));
  }, [conversationId, applyQueueSnapshot]);

  const toggleArchive = async () => {
    // Un-archiving (from within the chat you're viewing) is immediate — no grace
    // period, and it leaves you where you are.
    if (archived) {
      setMenuBusy(true);
      try {
        await api.updateConversation(conversationId, { archived: false });
        setArchived(false);
      } catch {
        /* state resyncs on next fetch */
      } finally {
        setMenuBusy(false);
      }
      return;
    }

    // Archiving: leave the chat right away, but defer the write ~5s via the
    // shared pendingArchive module so the toast's Undo can cancel it — the same
    // grace period the chat list uses, and it survives this refresh/unmount.
    // Because the write never fires on undo, we also avoid needlessly
    // interrupting a still-working agent (the server-side archive kills it).
    const name = title?.trim() || 'Untitled chat';
    scheduleArchive(conversationId, 5000);
    onToast(`Archived "${name}"`, {
      label: 'Undo',
      onAction: () => cancelArchive(conversationId),
    });
    onNavigate(projectId ? `#/?project=${projectId}` : '#/');
  };

  const togglePin = async () => {
    setMenuBusy(true);
    try {
      const result = await api.updateConversation(conversationId, { pinned: !pinned });
      setPinned(result.conversation.pinOrder !== null);
    } catch {
      /* state resyncs on next fetch */
    } finally {
      setMenuBusy(false);
    }
  };

  const markUnread = async () => {
    setMenuBusy(true);
    try {
      await api.markConversationUnread(conversationId);
      const nextParams = new URLSearchParams({ focusChat: conversationId });
      if (projectId) nextParams.set('project', projectId);
      onNavigate(`#/?${nextParams.toString()}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not mark chat as unread');
    } finally {
      setMenuBusy(false);
    }
  };

  const openRenameDialog = () => {
    setRenameDraft(title?.trim() || '');
    setRenameDialogOpen(true);
  };

  const renameChat = async () => {
    const next = renameDraft.trim();
    if (!next) return;
    if (next === (title?.trim() || '')) {
      setRenameDialogOpen(false);
      return;
    }
    setMenuBusy(true);
    try {
      const result = await api.updateConversation(conversationId, { title: next });
      setTitle(result.conversation.title);
      setRenameDialogOpen(false);
      onToast('Chat renamed');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not rename chat');
    } finally {
      setMenuBusy(false);
    }
  };

  const deleteChat = async () => {
    setMenuBusy(true);
    try {
      await api.deleteConversation(conversationId);
      setDeleteDialogOpen(false);
      onToast(`Deleted "${title?.trim() || 'Untitled chat'}"`);
      onNavigate(projectId ? `#/?project=${projectId}` : '#/');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setMenuBusy(false);
    }
  };

  const toggleVisibility = async () => {
    const next = visibility === 'team' ? 'private' : 'team';
    setMenuBusy(true);
    try {
      const result = await api.updateConversation(conversationId, { visibility: next });
      setVisibility(result.conversation.visibility);
      setCanChangeVisibility(result.conversation.canChangeVisibility);
      setVisibilityDialogOpen(false);
      onToast(next === 'private' ? 'Chat is now Private' : 'Chat is now shared with the Team');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setMenuBusy(false);
    }
  };

  // ── Frozen transcript ──────────────────────────────────────────────────
  // A session's past turns are append-only. Ordinary rows become inert HTML;
  // rare Mermaid rows stay mounted so Streamdown can render and operate their
  // diagrams. Static segments on either side still append incrementally, so a
  // long ordinary history keeps the same cheap render path.
  const frozenLenRef = useRef(0);

  const items = useMemo(
    () => transcriptItemsForDisplay(transcript.items),
    [transcript.items],
  );
  const focusedMessageKey = workspaceSearchFocusKey(focusMessageId, items) ?? agentMessageFocusKey(focusMessageId);
  const focusedMessageReady = Boolean(
    focusedMessageKey && items.some((item) => item.key === focusedMessageKey),
  );
  const firstPromptKey = firstUserPromptKey(items, isCollapsibleUserPrompt);
  // A pending send is newer than every confirmed transcript row. Until it lands,
  // all confirmed prompts except the first are historical; otherwise the first
  // and newest real prompts stay expanded. Only genuinely long historical
  // prompts are condensed; synthetic task/skill rows keep dedicated renderers.
  const mostRecentPromptKey = pendingSends.length > 0
    ? null
    : mostRecentUserPromptKey(items, isCollapsibleUserPrompt);
  // While a turn is in flight, everything from its user message onward stays
  // live (streaming reveal, tool spinners, scroll anchoring). pendingSends
  // counts as in flight: the turn's user item can land before the status flip.
  const turnInFlight = working || Boolean(transcript.streamingText) || pendingSends.length > 0;
  const hasReadyAttachment = attachments.some((a) => a.status === 'done');
  const dictationActive =
    recording || transcribing || micDictation.isActive || micDictation.isFinalizing;
  const hasSendableContent = !!messageQuote || composerHasSendableContent({
    draft,
    hasReadyAttachment,
    dictationActive,
  });
  const trailingAction = composerTrailingAction({
    hasSendableContent,
    working,
    canManage,
    turnInFlight,
  });
  const enlargeMic = trailingAction === 'hidden';
  const frozenTarget = turnInFlight
    ? Math.max(0, items.findLastIndex((i) => i.kind === 'user'))
    : items.length;
  if (frozenTarget > frozenLenRef.current) frozenLenRef.current = frozenTarget;
  // Transcript shrank (conversation switch / snapshot replay) — refreeze from
  // scratch; the layout effect below rebuilds the container to match.
  if (frozenLenRef.current > items.length) frozenLenRef.current = 0;
  const frozenLen = frozenLenRef.current;
  const frozenSegments = useMemo(
    () => segmentFrozenTranscript(groupActivityRuns(items.slice(0, frozenLen))),
    [frozenLen, items],
  );

  // Static rows can't carry React handlers — tool-result thumbnails in frozen
  // turns open the lightbox through one delegated click on the container.
  const onFrozenClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest?.('[data-copy]');
    if (copyBtn instanceof HTMLElement && copyBtn.dataset.copy != null) {
      copyPromptText(copyBtn, copyBtn.dataset.copy);
      return;
    }
    const hit = target.closest?.('[data-lightbox-src]');
    if (hit instanceof HTMLElement && hit.dataset.lightboxSrc) {
      setExpandedToolImage({ src: hit.dataset.lightboxSrc, name: hit.dataset.lightboxName ?? 'image' });
    }
  }, []);

  // Open a transcript link that points at a local file path. Known files
  // resolve immediately; otherwise refresh the file registries once (detection
  // may not have caught up with a just-finished turn) and retry. A path that
  // is still unknown is dropped — a dead new tab is worse than a no-op.
  const openLocalPath = useCallback(
    async (localPath: string): Promise<boolean> => {
      const current = sessionFiles.find((f) => artifactPathKey(f.path) === artifactPathKey(localPath));
      if (current) {
        setPreviewFile(current);
        return true;
      }
      const [refreshedArtifacts, refreshedFiles] = await Promise.all([
        onRefreshArtifacts().catch(() => [] as Artifact[]),
        api
          .conversationFiles(conversationId)
          .then((r) => r.files)
          .catch(() => [] as SessionFile[]),
      ]);
      setSessionFiles(refreshedFiles);
      const artifact = refreshedArtifacts.find((a) => a.type === 'file' && artifactPathKey(a.path) === artifactPathKey(localPath));
      if (artifact) {
        onOpenArtifact(artifact);
        return true;
      }
      const file = refreshedFiles.find((f) => artifactPathKey(f.path) === artifactPathKey(localPath));
      if (file) {
        setPreviewFile(file);
        return true;
      }
      return false;
    },
    [conversationId, onOpenArtifact, onRefreshArtifacts, sessionFiles],
  );

  const openBrowserLink = useCallback((href: string) => {
    const opened = window.open(href, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
  }, []);

  const openProjectFileLink = useCallback(async (intent: ProjectFileLinkIntent, fallbackHref: string) => {
    if (!projectId) {
      if (intent.explicit) onToast("This chat isn't in a project, so Veneer can't locate that file.");
      else openBrowserLink(fallbackHref);
      return;
    }
    try {
      const { file } = await api.resolveProjectFileLink(projectId, intent.target);
      if (file.kind === 'directory') {
        onOpenProjectFile(projectId, { path: file.path, kind: 'directory' });
        return;
      }
      const knownArtifact = artifacts.find((item) => item.type === 'file' && item.path === file.absolutePath);
      if (knownArtifact) {
        onOpenArtifact(knownArtifact);
        return;
      }
      const knownSessionFile = sessionFiles.find((item) => item.path === file.absolutePath);
      if (knownSessionFile) {
        setPreviewFile(knownSessionFile);
        return;
      }
      if (isMarkdownFileName(file.path)) {
        setProjectMarkdownPreview({ projectId, path: file.path });
        return;
      }
      onOpenProjectFile(projectId, {
        path: file.path,
        ...(file.line ? { line: file.line } : {}),
        ...(file.column ? { column: file.column } : {}),
      });
    } catch (err) {
      if (intent.explicit) onToast(`Couldn't open that file: ${(err as Error).message}`);
      else openBrowserLink(fallbackHref);
    }
  }, [artifacts, onOpenArtifact, onOpenProjectFile, onToast, openBrowserLink, projectId, sessionFiles]);

  // Markdown is sanitized HTML and completed turns are frozen to static HTML,
  // so transcript links use one delegated handler shared by both render paths.
  const onTranscriptClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const listenButton = target.closest<HTMLElement>('[data-message-listen]');
      if (listenButton) {
        event.preventDefault();
        if (liveVoice.pinnedId) { onToast('End the voice call before listening to a message.'); return; }
        try { listenToMessage({ chat: conversationId, ...JSON.parse(listenButton.dataset.messageListen!) }); } catch { /* Invalid anchor. */ }
        return;
      }
      const reactionButton=target.closest<HTMLButtonElement>('[data-result-reaction]');
      if(reactionButton){
        event.preventDefault();
        if(!canSend || reactionButton.disabled)return;
        reactionButton.disabled=true;
        try {
          const anchor=JSON.parse(reactionButton.dataset.resultAnchor!);
          void requestJson<{id:string}>(`/api/bot-communication/chats/${encodeURIComponent(conversationId)}/threads`,{method:'POST',body:JSON.stringify(anchor)})
            .then(thread=>requestJson(`/api/bot-communication/threads/${thread.id}/reactions`,{method:'POST',body:JSON.stringify({emoji:reactionButton.dataset.resultReaction,active:reactionButton.getAttribute('aria-pressed')!=='true'})}))
            .then(()=>window.dispatchEvent(new Event('result-reactions-changed')))
            .catch(()=>onToast('Could not save reaction. Try again.'))
            .finally(()=>{reactionButton.disabled=false});
        }catch{reactionButton.disabled=false}
        return;
      }
      const threadButton=target.closest<HTMLElement>('[data-result-thread]');
      if(threadButton){event.preventDefault();try{setMessageThread(JSON.parse(threadButton.dataset.resultThread!));}catch{/* invalid anchor */}return;}
      // Memory panels use the browser's top-layer popover so paint containment
      // on the transcript scroller cannot clip them. Position before the
      // popover target's native click action opens it; this works for both live
      // React rows and frozen static-HTML rows.
      const memoryTrigger = target.closest?.('[data-memory-popover]');
      if (memoryTrigger instanceof HTMLElement) {
        positionMemoryPopover(memoryTrigger);
        return;
      }
      const citationsBtn = target.closest?.('[data-citations-trigger]');
      if (citationsBtn instanceof HTMLElement) {
        event.preventDefault();
        const citations = citationsFromPayload(citationsBtn.dataset.citations);
        if (citations.length) onOpenCitations(citations);
        return;
      }
      const anchor = target.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const appRoute = anchor.dataset.appRoute;
      if (appRoute) {
        event.preventDefault();
        onNavigate(appRoute);
        return;
      }
      // A "Watch live" link opens the floating desktop instead of navigating.
      if (isDesktopWatchLink(anchor.href)) {
        event.preventDefault();
        showDesktop('full');
        return;
      }
      const artifact = artifactForHref(anchor.href, artifacts);
      event.preventDefault();
      if (artifact) {
        onOpenArtifact(artifact);
        return;
      }
      const rawHref = anchor.getAttribute('href') ?? anchor.href;
      const projectIntent = projectFileLinkIntent(rawHref);
      // Existing deliverables keep their rich preview. If no registry owns an
      // absolute path, retry it as project source instead of opening a dead tab.
      const localPath = localPathForHref(anchor.href);
      if (localPath) {
        void openLocalPath(localPath).then((handled) => {
          if (!handled && projectIntent) void openProjectFileLink(projectIntent, anchor.href);
        });
        return;
      }
      if (projectIntent) {
        void openProjectFileLink(projectIntent, anchor.href);
        return;
      }
      const mobileGmailLink = mobileGmailLinkFor(anchor.href, navigator);
      if (mobileGmailLink) {
        openMobileGmailLink(mobileGmailLink);
        return;
      }
      openBrowserLink(anchor.href);
    },
    [artifacts, onNavigate, onOpenArtifact, onOpenCitations, openBrowserLink, openLocalPath, openProjectFileLink, showDesktop, canSend, conversationId, onToast, listenToMessage, liveVoice.pinnedId],
  );

  useEffect(()=>{
    if(isNew)return;
    let active=true;
    const refresh=()=>requestJson<{threads:{anchor:string;count:number;unread:number;reactions:{emoji:string;count:number;mine:number}[]}[]}>(`/api/bot-communication/chats/${encodeURIComponent(conversationId)}/threads`).then(({threads})=>{
      if(!active)return;
      for(const button of screenRef.current?.querySelectorAll<HTMLElement>('[data-result-thread]')??[]){
        const t=threads.find(t=>t.anchor===button.dataset.resultThread);
        button.textContent=t?.count?`${t.count} ${t.count===1?'reply':'replies'}${t.unread?` · ${t.unread} new`:''}`:'Reply';
        button.setAttribute('aria-label', t?.count ? `Open thread · ${button.textContent}` : 'Reply in thread');
        button.dataset.unread = t?.unread ? 'true' : 'false';
      }
      for(const button of screenRef.current?.querySelectorAll<HTMLButtonElement>('[data-result-reaction]')??[]){
        const t=threads.find(t=>t.anchor===button.dataset.resultAnchor);
        const r=t?.reactions.find(r=>r.emoji===button.dataset.resultReaction);
        button.textContent=`${button.dataset.resultReaction}${r?.count ? ` ${r.count}` : ''}`;
        button.setAttribute('aria-pressed',r?.mine?'true':'false');
        button.disabled=!canSend;
      }
    }).catch(()=>{});
    void refresh();const timer=setInterval(()=>void refresh(),8000);window.addEventListener('result-reactions-changed',refresh);return()=>{active=false;clearInterval(timer);window.removeEventListener('result-reactions-changed',refresh);};
  },[conversationId,isNew,items.length,messageThread,canSend]);

  const liveItems = groupActivityRuns(items.slice(frozenLen));
  const pendingQuestionId = liveItems.find(isAnchoredPendingQuestion)?.key;
  const revealedStreamingText = useTypewriter(transcript.streamingText, true);

  // Header: the chat title leads, the agent name sits below it. Live status is
  // folded into the agent line so nothing important is lost off the top.
  const agentName = agentTypes.find((agent) => agent.slug === assistantSlug)?.name
    ?? assistantName
    ?? (isPlatformDev ? 'Platform Dev' : assistantSlug === 'app-creator' ? 'App Creator' : 'Assistant');
  const liveStatus =
    status === 'needs_you'
      ? 'Needs your input'
      : status === 'failed'
        ? 'Last reply had a problem'
        : null;

  // The composer's model/thinking chip + its picker cover two modes: a new
  // chat (cross-provider pick + effort) or an existing one (single-provider
  // switch). activeProvider drives the effort vocabulary in either mode; a
  // mid-chat conversation with an unresolved provider shows no chip at all.
  const compactionSupported = activeProvider === 'claude' || activeProvider === 'codex';
  const compactContext = async () => {
    if (!compactionSupported || working || menuBusy || compacting) return;
    setMenuBusy(true);
    setCompactionBusy(true);
    onToast('Compacting context…');
    try {
      const result = await api.compactConversation(conversationId);
      contextRevisionRef.current += 1;
      setContextTokens(result.contextTokens);
      onToast('Context compacted');
    } catch (err) {
      onToast((err as Error).message || 'Could not compact context');
    } finally {
      setCompactionBusy(false);
      setMenuBusy(false);
    }
  };
  const activeEffort = isNew ? pickEffort : effort ?? '';
  const chipDisabled = (isNew && modelChoices === null) || (!isNew && (status === 'working' || status === 'needs_you' || modelSaving));
  const showComposer = canUseChatComposer(isNew, canSend);
  const showChatControls = canUseChatControls(isNew, canManage);
  // Compact chip label — always "Provider ModelName" (never "Default"/parens);
  // just the provider name when the model can't be resolved.
  let chipLabel: string | null = null;
  if (isNew) {
    if (modelChoices === null) {
      chipLabel = 'Loading…';
    } else {
      const choice = modelChoices.find((c) => c.provider === pick.provider && c.model === pick.model);
      chipLabel = providerLabel(pick.provider) + (choice?.short ? ` ${choice.short}` : '');
    }
  } else if (activeProvider) {
    if (model === null) {
      chipLabel = providerLabel(activeProvider);
    } else {
      // The model that answered may be an alias/hidden/retired id absent from
      // the live list — fall back to its own label so it still names itself.
      const opt = chatModelOptions.find((m) => m.id === model);
      const stripped = stripProviderPrefix(opt?.label ?? modelLabel(model) ?? model, activeProvider);
      chipLabel = `${providerLabel(activeProvider)} ${stripped}`;
    }
  }
  if (chipLabel !== null && activeEffort) chipLabel += ` · ${effortLabel(activeEffort)}`;
  // Context readout shown next to the agent chip: "47k / 1M" (used / window) once
  // a turn has run and the model resolves to a known context window, else just the
  // used count ("47k"), else nothing. Existing chats only; a new chat has no usage.
  let contextLabel: string | null = null;
  if (!isNew && contextTokens != null && contextTokens > 0) {
    const window = contextWindowFor(activeProvider, model);
    contextLabel = window ? `${formatTokens(contextTokens)} / ${formatTokens(window)}` : formatTokens(contextTokens);
  }
  const headerMenuLabels = chatHeaderMenuLabels(canManage, pinned);
  const deleteConfirmation = chatDeleteConfirmation({ visibility, status });

  return (
    <div
      ref={screenRef}
      className="conversation-surface relative mx-auto flex h-full w-full max-w-none flex-col overflow-hidden pt-[calc(env(safe-area-inset-top)+1.25rem)] md:pt-[env(safe-area-inset-top)]"
    >
      {showComposer && !creatingNewChat ? <MessageSelection rootRef={screenRef} onAdd={(quote) => {
        setMessageQuote(quote);
        textareaRef.current?.focus();
      }} /> : null}
      {isNew ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="absolute right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-20 size-12 rounded-full text-muted-foreground"
          onPointerUp={() => onNavigate(backHash ?? (projectId ? `#/?project=${projectId}` : '#/'))}
          aria-label="Close new chat"
          title="Close new chat"
        >
          <X className="size-7" />
        </Button>
      ) : null}
      {!isNew && <MobileChatHeader id={conversationId} name={title?.trim() || agentName} status={`${creator?.displayName ?? ''} · ${liveStatus || status} · ${visibility}`} onBack={() => onNavigate(backHash ?? (projectId ? `#/?project=${projectId}` : '#/'))} onComputer={onOpenBrowser}>
        {sideChatButton && canSend && <DropdownMenuItem onSelect={() => onNavigate(withSideParam(window.location.hash, 'open'))}>Side chat</DropdownMenuItem>}
        {canSend && <DropdownMenuItem onSelect={() => liveVoice.open(conversationId)}>Talk with this bot</DropdownMenuItem>}
        {canChangeVisibility && <DropdownMenuItem disabled={menuBusy} onSelect={() => setVisibilityDialogOpen(true)}>Change visibility · {visibility}</DropdownMenuItem>}
        <DropdownMenuItem disabled={menuBusy} onSelect={() => void markUnread()}>Mark as unread</DropdownMenuItem>
        {canManage && <DropdownMenuItem disabled={menuBusy} onSelect={() => void toggleArchive()}>{archived ? 'Restore chat' : 'Archive chat'}</DropdownMenuItem>}
                <ChatHeaderMenuItems
                  labels={headerMenuLabels}
                  pinned={pinned}
                  compaction={{
                    supported: compactionSupported,
                    disabled: menuBusy || working || archived || !compactionSupported,
                    busy: compacting,
                    disabledReason: archived ? 'Restore this chat before compacting its context.' : undefined,
                  }}
                  onInfo={() => setContextDialogOpen(true)}
                  onRename={openRenameDialog}
                  onCopyLink={() => {
                    void copyChatShareUrl(
                      navigator.clipboard,
                      window.location,
                      conversationId,
                      projectId,
                    )
                      .then(() => onToast('Link copied'))
                      .catch(() => onToast('Could not copy link'));
                  }}
                  onOpenBrowser={onOpenBrowser}
                  onCompact={() => void compactContext()}
                  onTogglePin={() => void togglePin()}
                  onMove={() => setMoveDialogOpen(true)}
                  moveDisabled={menuBusy || working}
                  onDelete={() => setDeleteDialogOpen(true)}
                />
      </MobileChatHeader>}
      <header
        className={cn(
          'hidden shrink-0 items-center gap-2 border-b px-3 py-2.5 md:flex',
          isNew && 'hidden',
        )}
      >
        <Button
          variant="ghost"
          size="icon-lg"
          // md:hidden — on desktop the chat sits in a split view with the
          // list beside it, so there is nowhere to go "back" to.
          className="-m-1.5 size-12 rounded-full md:hidden"
          // Back to the Chats list — re-expanded on this chat's project, if any.
          onPointerUp={() => onNavigate(backHash ?? (projectId ? `#/?project=${projectId}` : '#/'))}
          aria-label="Back"
        >
          <ChevronLeft className="size-5" />
        </Button>
        {backHash === '#/bots' && <BotAvatar id={conversationId} name={title || agentName} />}
        <div className="min-w-0 flex-1">
          {backHash === '#/bots' && <BotPresence id={conversationId} state={status === 'working' ? 'working' : status === 'failed' ? 'failed' : 'available'} />}
          {isNew ? (
            <>
              {/* No title yet — lead with the agent so the picker choice reads back. */}
              <p className="flex items-center gap-1.5 truncate font-medium">
                {isPlatformDev ? <Wrench className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                {agentName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {projectName ? `New chat · ${projectName}` : 'New chat'}
              </p>
            </>
          ) : (
            <>
              <p className="flex min-w-0 items-center gap-2 font-medium">
                <ChatContextDialog
                  conversationId={conversationId}
                  trigger="mobile-title"
                  mobileTitle={title?.trim() || 'Untitled chat'}
                  onNavigate={onNavigate}
                />
                <span className="truncate max-md:hidden">{title?.trim() || 'Untitled chat'}</span>
                {pinned ? (
                  <span className="inline-flex shrink-0 text-brand" title="Pinned" aria-label="Pinned chat">
                    <Pin className="size-4 fill-current" aria-hidden="true" />
                  </span>
                ) : null}
              </p>
              <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                {creator ? <CreatorAvatar name={creator.displayName} className="size-4 text-[9px]" /> : null}
                <span className="truncate">
                  {creator?.displayName ?? 'Unknown user'}
                  {' · '}
                  {isPlatformDev ? <Wrench className="mr-1 inline size-3" /> : null}
                  {agentName}
                  {liveStatus ? ` · ${liveStatus}` : ''}
                </span>
              </p>
            </>
          )}
        </div>
        {!isNew ? (
          <div className="flex shrink-0 items-center gap-1">
            {sideChatButton && canSend ? (
              <Button
                variant="ghost"
                size="icon-lg"
                className="relative rounded-full text-muted-foreground"
                onPointerUp={() => onNavigate(withSideParam(window.location.hash, 'open'))}
                aria-label={`Side chat about this conversation`}
                title="Side chat — ask without interrupting"
              >
                <MessagesSquare className="size-4" aria-hidden="true" />
                <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
              </Button>
            ) : null}
            {backHash === '#/bots' && canManage ? (
              <Button
                variant="ghost"
                size="icon-lg"
                className="relative rounded-full text-muted-foreground"
                onPointerUp={() => liveVoice.open(conversationId)}
                aria-label={`Talk with ${title?.trim() || agentName}`}
                title="Talk with this bot"
              >
                <Phone className="size-4" aria-hidden="true" />
                <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
              </Button>
            ) : null}
            {canChangeVisibility ? (
              <Button
                variant="ghost"
                size="icon-lg"
                className="relative rounded-full text-muted-foreground"
                onPointerUp={() => setVisibilityDialogOpen(true)}
                disabled={menuBusy}
                aria-label={`Change chat visibility. Current setting: ${visibility === 'private' ? 'Private' : 'Team'}`}
                title={visibility === 'private' ? 'Private — only you can see this chat' : 'Team — everyone can see this chat'}
              >
                {visibility === 'private' ? (
                  <HatGlasses className="size-4" aria-hidden="true" />
                ) : (
                  <UsersRound className="size-4" aria-hidden="true" />
                )}
                <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
              </Button>
            ) : visibility === 'private' ? (
              <span
                className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground"
                title="Private — only you can see this chat"
                aria-label="Private — only you can see this chat"
              >
                <HatGlasses className="size-4" aria-hidden="true" />
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-lg"
              className="relative rounded-full text-muted-foreground"
              onPointerUp={() => void markUnread()}
              disabled={menuBusy}
              aria-label="Mark as unread"
              title="Mark as unread"
            >
              <Mail className="size-4" aria-hidden="true" />
              <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
            </Button>
            <ChatArchiveButton
              archived={archived}
              canManage={canManage}
              busy={menuBusy}
              onArchive={() => void toggleArchive()}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="relative rounded-full text-muted-foreground"
                  disabled={menuBusy}
                  aria-label="More chat actions"
                  title="More chat actions"
                >
                  <Ellipsis className="size-4" />
                  <span
                    className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <ChatHeaderMenuItems
                  labels={headerMenuLabels}
                  pinned={pinned}
                  compaction={{
                    supported: compactionSupported,
                    disabled: menuBusy || working || archived || !compactionSupported,
                    busy: compacting,
                    disabledReason: archived ? 'Restore this chat before compacting its context.' : undefined,
                  }}
                  onInfo={() => setContextDialogOpen(true)}
                  onRename={openRenameDialog}
                  onCopyLink={() => {
                    void copyChatShareUrl(
                      navigator.clipboard,
                      window.location,
                      conversationId,
                      projectId,
                    )
                      .then(() => onToast('Link copied'))
                      .catch(() => onToast('Could not copy link'));
                  }}
                  onOpenBrowser={onOpenBrowser}
                  onCompact={() => void compactContext()}
                  onTogglePin={() => void togglePin()}
                  onMove={() => setMoveDialogOpen(true)}
                  moveDisabled={menuBusy || working}
                  onDelete={() => setDeleteDialogOpen(true)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
        {!isNew ? (
          <ChatContextDialog
            conversationId={conversationId}
            open={contextDialogOpen}
            onOpenChange={setContextDialogOpen}
            onNavigate={onNavigate}
          />
        ) : null}
      </header>

      {!isNew && automation ? (
        <AutomationStrip
          automation={automation}
          onOpen={() => onNavigate(`#/automations?task=${encodeURIComponent(automation.taskId)}`)}
        />
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
      <ImageLightboxContext.Provider value={setExpandedToolImage}>
      <MarkdownImageSourcesContext.Provider value={imageSources}>
      <MessageScrollerProvider
        autoScroll={!isNew && status !== 'needs_you'}
        defaultScrollPosition={isNew ? 'start' : status === 'needs_you' ? 'last-anchor' : 'end'}
      >
        {/* Force a locally-sent prompt into view even when the reader had
            scrolled up. Using scrollToEnd keeps normal document height;
            scrollAnchor would add a viewport-sized spacer below the prompt. */}
        <ScrollToLatestSend pendingId={pendingSends.at(-1)?.id} />
        <ScrollToPendingQuestion messageId={status === 'needs_you' ? pendingQuestionId : undefined} />
        <ScrollToLinkedMessage messageId={focusedMessageKey} ready={focusedMessageReady} />
        <MessageScroller className="flex-1" onClick={onTranscriptClick}>
          <MessageScrollerViewport>
            <MessageScrollerContent
              className={cn('gap-3 px-4 dark:pb-6', isNew ? 'py-0 md:py-4' : 'py-4')}
            >
              {isNew && transcript.items.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe text-center md:flex-none md:justify-start md:py-8">
                  <p className="text-lg font-semibold text-foreground md:text-xl">Let’s work on something together!</p>
                  <div className="mt-3 w-full max-w-sm text-left">
                    <div
                      role="radiogroup"
                      aria-label="Chat visibility"
                      className="grid grid-cols-2 rounded-2xl border bg-card p-1.5 shadow-sm"
                    >
                      <button
                        type="button"
                        role="radio"
                        disabled={creatingNewChat}
                        aria-checked={visibility === 'team'}
                        onClick={() => setVisibility('team')}
                        className={cn(
                          'flex min-h-12 items-center rounded-xl p-3 text-left transition-colors',
                          visibility === 'team'
                            ? 'bg-accent text-foreground shadow-sm ring-1 ring-foreground/10'
                            : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        <span className="flex items-center gap-2 font-semibold">
                          <UsersRound className="size-5" aria-hidden="true" />
                          Team
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        disabled={creatingNewChat}
                        aria-checked={visibility === 'private'}
                        onClick={() => setVisibility('private')}
                        className={cn(
                          'flex min-h-12 items-center rounded-xl p-3 text-left transition-colors',
                          visibility === 'private'
                            ? 'bg-accent text-foreground shadow-sm ring-1 ring-foreground/10'
                            : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        <span className="flex items-center gap-2 font-semibold">
                          <HatGlasses className="size-5" aria-hidden="true" />
                          Private
                        </span>
                      </button>
                    </div>
                  </div>
                  {projects.length > 0 ? (
                    <label className="mt-3 flex w-full max-w-xs flex-col gap-1.5 text-left md:mt-5 md:gap-2">
                      <span className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Project
                      </span>
                      <select
                        value={projectId ?? ''}
                        disabled={creatingNewChat}
                        onChange={(event) => chooseProject(event.target.value || null)}
                        className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                        aria-label="Project"
                      >
                        <option value="">No project</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {agentTypes.length > 1 ? (
                    <div className="mt-3 w-full max-w-xs text-left md:mt-5">
                      <p className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground md:mb-2">Choose an agent</p>
                      <div className="flex flex-col gap-0.5 rounded-2xl border bg-card p-1 md:gap-1 md:p-1.5">
                        {agentTypes.map((agent) => (
                          <button
                            key={agent.slug}
                            type="button"
                            disabled={creatingNewChat}
                            onPointerUp={() => chooseAgent(agent.slug)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-xl px-3 py-1 text-sm font-medium transition-colors md:px-4 md:py-2.5',
                              assistantSlug === agent.slug
                                ? 'bg-accent text-foreground'
                                : 'text-muted-foreground hover:bg-accent/50',
                            )}
                          >
                            {agent.slug === 'platform-dev' ? <Wrench className="size-4 shrink-0" /> : null}
                            {agent.slug === 'app-creator' ? <AppWindow className="size-4 shrink-0" /> : null}
                            {agent.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Mermaid and image rows stay mounted so diagrams and images
                  can finish loading after the transcript arrives. */}
              {frozenSegments.map((segment) => (
                segment.kind === 'static' ? (
                  <MessageScrollerItem key={segment.key}>
                    <FrozenStaticSegment
                      items={segment.items}
                      firstPromptKey={firstPromptKey}
                      mostRecentPromptKey={mostRecentPromptKey}
                      onClick={onFrozenClick}
                    />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={segment.key} messageId={segment.item.key}>
                    <ChatRow item={segment.item} live={false} collapsePrompt={false} />
                  </MessageScrollerItem>
                )
              ))}

              {liveItems.map((item) => (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.key}
                  className="data-[linked-focus=true]:rounded-xl data-[linked-focus=true]:bg-brand/5 data-[linked-focus=true]:ring-1 data-[linked-focus=true]:ring-brand/30"
                  scrollAnchor={isAnchoredPendingQuestion(item)}
                >
                  <ChatRow
                    item={item}
                    live={!historicalKeysRef.current.has(item.key)}
                    collapsePrompt={shouldCollapsePrompt(item, firstPromptKey, mostRecentPromptKey)}
                  />
                </MessageScrollerItem>
              ))}

              {transcript.streamingText ? (
                <MessageScrollerItem>
                  <Message data-vp-mermaid-row={containsMermaidFence(revealedStreamingText) ? '' : undefined}>
                    <MessageContent>
                      <Bubble variant="ghost">
                        <BubbleContent data-message-quote="assistant" className="text-base">
                          <Markdown markdown={revealedStreamingText} mode="streaming" />
                          <span className="vp-caret" />
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ) : status === 'working' || compacting ? (
                <MessageScrollerItem>
                  <AgentWorkingMarker
                    thinking={transcript.items.at(-1)?.kind === 'user'}
                    compacting={compacting}
                  />
                </MessageScrollerItem>
              ) : null}

              {!isNew && canSend
                ? queued.map((item, index) => (
                    <MessageScrollerItem key={`queued-${item.id}`}>
                      <QueuedMessageRow
                        item={{ id: item.id, text: visiblePromptText(item.text), origin: item.origin }}
                        index={index}
                        count={queued.length}
                        canManage={canManage}
                        draftBlocked={!!draft.trim() || !!messageQuote}
                        sendingId={sendingQueuedId}
                        onSend={sendQueuedNow}
                        onEdit={editQueued}
                        onRemove={removeQueued}
                        onMove={moveQueued}
                      />
                    </MessageScrollerItem>
                  ))
                : null}

              {pendingSends.map((p, i) => (
                <MessageScrollerItem key={p.id}>
                  <PendingUserRow
                    text={p.text}
                    queued={p.queued}
                    collapsePrompt={
                      i < pendingSends.length - 1 &&
                      (firstPromptKey !== null || i > 0) &&
                      isLongPrompt(visiblePromptText(p.text))
                    }
                    canSendNow={i === 0 && p.queued && working}
                    onSendNow={() => void api.interrupt(conversationId).catch(() => undefined)}
                  />
                </MessageScrollerItem>
              ))}
              {!isNew&&<MessageScrollerItem><BotCommunication key={conversationId} conversationId={conversationId}/><VoiceSessions key={`voice-${conversationId}`} conversationId={conversationId}/></MessageScrollerItem>}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" className="size-11 rounded-full border bg-background shadow-sm" />
        </MessageScroller>
      </MessageScrollerProvider>
      </MarkdownImageSourcesContext.Provider>
      </ImageLightboxContext.Provider>

      {messageThread&&<MessageThreadDialog key={conversationId+JSON.stringify(messageThread)} conversationId={conversationId} anchor={messageThread} onClose={()=>setMessageThread(null)}/>}
      {overlayImage ? (
        <div
          className="absolute inset-0 z-10 flex flex-col bg-background/97 backdrop-blur-sm"
          onPointerUp={closeOverlay}
        >
          <img
            src={overlayImage.src}
            alt={overlayImage.name}
            className="min-h-0 w-full flex-1 object-contain p-4"
          />
          <p className="shrink-0 pb-3 text-center text-xs text-muted-foreground">
            {overlayImage.name} — tap to close
          </p>
        </div>
      ) : null}

      </div>

      <div
        className={cn(
          'shrink-0 px-3 pt-2',
          composerFocused ? 'pb-[0.6rem]' : 'pb-[calc(env(safe-area-inset-bottom)+0.6rem)]',
        )}
      >
        {sendError ? <p className="px-2 pb-1.5 text-sm text-destructive">{sendError}</p> : null}
        {!isNew ? (
          <ArtifactsStrip
            conversationId={conversationId}
            artifacts={artifacts}
            sessionFiles={sessionFiles}
            onOpenArtifact={onOpenArtifact}
            onOpenSessionFile={setPreviewFile}
          />
        ) : null}
        {attachments.length ? (
          <CollapsibleAttachments
            className="px-1 pb-1.5"
            items={attachments}
            getKey={(a) => a.id}
            label={(n) => `${n} files`}
            renderChip={(a) => (
              <Attachment size="sm" state={a.status}>
                <AttachmentMedia variant={a.previewUrl ? 'image' : 'icon'}>
                  {a.previewUrl ? <img src={a.previewUrl} alt="" /> : <FileText />}
                </AttachmentMedia>
                {a.previewUrl ? (
                  // Full-chip tap target (the ✕ action sits above it at z-20).
                  <AttachmentTrigger
                    aria-label={`Expand ${a.name}`}
                    onPointerUp={() => setExpandedId(a.id)}
                  />
                ) : null}
                <AttachmentContent>
                  <AttachmentTitle>{a.name}</AttachmentTitle>
                  <AttachmentDescription>
                    {a.status === 'uploading'
                      ? 'Uploading…'
                      : a.status === 'error'
                        ? (a.error ?? 'Upload failed')
                        : formatBytes(a.size)}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction aria-label={`Remove ${a.name}`} onPointerUp={() => removeAttachment(a.id)}>
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            )}
            renderRow={(a) => (
              <div className="relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60">
                <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-foreground [&_svg]:size-4">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <FileText />
                  )}
                </div>
                {a.previewUrl ? (
                  <button
                    type="button"
                    aria-label={`Expand ${a.name}`}
                    onPointerUp={() => setExpandedId(a.id)}
                    className="absolute inset-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                  />
                ) : null}
                <div className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-xs font-medium">{a.name}</span>
                  <span
                    className={cn(
                      'block truncate text-[11px]',
                      a.status === 'error' ? 'text-destructive/80' : 'text-muted-foreground',
                    )}
                  >
                    {a.status === 'uploading'
                      ? 'Uploading…'
                      : a.status === 'error'
                        ? (a.error ?? 'Upload failed')
                        : formatBytes(a.size)}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onPointerUp={() => removeAttachment(a.id)}
                  className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
                >
                  <X />
                </button>
              </div>
            )}
          />
        ) : null}
        {!isNew && canManage && failedTurn ? (
          <div className="mx-1 mb-1.5 rounded-2xl border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-medium">A message could not resume after {failedTurn.attempts} runner restarts.</p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={failedTurn.prompt}>
              {failedTurn.prompt}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="rounded-full" onPointerUp={() => resolveFailedTurn('retry')}>
                Retry message
              </Button>
              <Button size="sm" variant="secondary" className="rounded-full" onPointerUp={() => resolveFailedTurn('skip')}>
                Skip and continue
              </Button>
            </div>
          </div>
        ) : null}
        {!isNew && canSend && wakeups.length ? (
          <div className="px-1 pt-1 pb-2.5">
            <WakeupChip
              wakeups={wakeups}
              canManage={canManage}
              onFire={fireWakeup}
              onCancel={cancelWakeup}
              onReschedule={rescheduleWakeup}
            />
          </div>
        ) : null}
        {recording ? <DictationWaveform /> : null}
        {transcribing ? (
          <p role="status" className="mb-2 px-3 text-center text-sm text-muted-foreground">
            Finishing dictation…
          </p>
        ) : null}
        {isNew && todoId ? (
          <div
            role="status"
            className="mx-1 mb-1.5 flex items-center gap-1.5 rounded-lg bg-brand/[0.07] px-3 py-1.5 text-xs"
          >
            <Sparkles className="size-3.5 shrink-0 text-brand" />
            <p>
              <span className="font-semibold">First turn: planning only.</span>
              <span className="text-muted-foreground"> The agent will understand and clarify before acting.</span>
            </p>
          </div>
        ) : null}
        <div className={cn('relative', !showComposer && 'hidden')}>
          {skillDetailsOpen && composerSkill && activeProvider ? (
            <ComposerSkillDetails
              command={composerSkill.command}
              provider={providerLabel(activeProvider)}
              onClose={() => setSkillDetailsOpen(false)}
              onRemove={removeComposerSkill}
            />
          ) : showSkills ? (
            <SkillCommandPicker items={skillItems} activeIndex={skillActive} onSelect={insertSkill} />
          ) : showMentions ? (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-48 overflow-y-auto rounded-xl border bg-popover p-1 shadow-md">
              {mentionItems.map((item, i) => {
                const rowClass = `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${i === mentionActive ? 'bg-accent' : ''}`;
                if (item.kind === 'connector') {
                  const display = item.install.label
                    ? `${item.connector.name} — ${item.install.label}`
                    : item.connector.name;
                  return (
                    <button
                      key={`connector-${item.install.id}`}
                      type="button"
                      onPointerUp={() => insertMention(item)}
                      className={rowClass}
                    >
                      <ConnectorGlyph slug={item.connector.slug} name={display} className="size-4" />
                      <span className="min-w-0 flex-1 truncate font-medium">{display}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">Connector</span>
                    </button>
                  );
                }
                const c = item.conv;
                return (
                  <button key={c.id} type="button" onPointerUp={() => insertMention(item)} className={rowClass}>
                    <ChatMentionOption
                      conversation={c}
                      projectName={c.projectId ? (mentionProjectNames.get(c.projectId) ?? null) : null}
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
          <div
            className={cn(
              'composer-fill flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-[calc(var(--radius-3xl)-2px)] px-2 py-2 transition-shadow',
              dragActive && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
            )}
            onDragOver={(e) => {
              // Only react to actual files, not internal text/selection drags.
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!dragActive) setDragActive(true);
            }}
            onDragLeave={(e) => {
              // dragleave also fires when moving onto a child element — ignore
              // those so the highlight doesn't flicker.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragActive(false);
            }}
            onDrop={(e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              setDragActive(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            {messageQuote ? <ComposerQuote quote={messageQuote} onRemove={() => {
              setMessageQuote(null);
              textareaRef.current?.focus();
            }} /> : null}
            <div className="flex min-w-0 items-start gap-1.5">
              {composerSkill ? (
                <ComposerSkillChip
                  command={composerSkill.command}
                  open={skillDetailsOpen}
                  onToggle={() => setSkillDetailsOpen((open) => !open)}
                />
              ) : null}
              <div className="relative min-w-0 flex-1">
                {/* Same box, font, padding, and wrapping as the textarea so lines
                    align 1:1; transparent text, only the mention pills paint. The
                    trailing zero-width space materialises a trailing empty line the
                    same way the textarea renders one. */}
                <div
                  ref={composerHighlightRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap wrap-break-word px-2.5 py-1.5 text-[16px] text-transparent"
                >
                  {segmentMentions(composerDraft, connectedMentions, chatMentionMapRef.current).map((seg, i) =>
                    seg.kind !== 'text' ? (
                      <span key={i} className="rounded-md bg-brand/20">
                        {seg.text}
                      </span>
                    ) : (
                      seg.text
                    ),
                  )}
                  {'​'}
                </div>
                <textarea
                  ref={textareaRef}
                  autoFocus={isNew}
                  readOnly={creatingNewChat}
                  aria-label="Message"
                  aria-busy={creatingNewChat}
                  value={composerDraft}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={restoreChatViewport}
                  onChange={(e) => {
                    followDictationScrollRef.current = false;
                    setSkillDetailsOpen(false);
                    setDraft(
                      composerSkill ? draftForComposerSkill(composerSkill.command, e.target.value) : e.target.value,
                    );
                  }}
                  onPaste={(e) => {
                    handleComposerImagePaste(e, addFiles);
                  }}
                  onScroll={(e) => {
                    if (composerHighlightRef.current)
                      composerHighlightRef.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                  onKeyDown={(e) => {
                    const submitsComposer = isComposerSubmitKey(e);
                    if (
                      composerSkill &&
                      e.key === 'Backspace' &&
                      e.currentTarget.selectionStart === 0 &&
                      e.currentTarget.selectionEnd === 0
                    ) {
                      e.preventDefault();
                      removeComposerSkill();
                      return;
                    }
                    if (skillDetailsOpen && e.key === 'Escape') {
                      e.preventDefault();
                      setSkillDetailsOpen(false);
                      return;
                    }
                    if (showSkills) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSkillActive((i) => Math.max(0, Math.min(i + 1, skillItems.length - 1)));
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSkillActive((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setSkillDismissedFor(skillQuery);
                        return;
                      }
                      if (submitsComposer && skillItems.length > 0) {
                        e.preventDefault();
                        insertSkill(skillItems[skillActive] ?? skillItems[0]!);
                        return;
                      }
                    } else if (showMentions) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setMentionActive((i) => Math.min(i + 1, mentionItems.length - 1));
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setMentionActive((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setMentionDismissedFor(mentionQuery);
                        return;
                      }
                      if (submitsComposer) {
                        e.preventDefault();
                        insertMention(mentionItems[mentionActive] ?? mentionItems[0]!);
                        return;
                      }
                    }
                    // Enter-to-send on hardware keyboards only — the iOS soft
                    // keyboard's return key must insert a newline.
                    if (submitsComposer && !IS_TOUCH) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  // Height is set from scrollHeight (see the auto-grow effect); the
                  // max-h caps it at roughly a third of the screen, then it scrolls.
                  // text-[16px] (not text-base): with the 15px root scale, anything
                  // under 16px absolute makes iOS zoom the page when focused.
                  // relative: paints the real glyphs above the absolutely-positioned
                  // highlight backdrop.
                  className="relative max-h-[min(35dvh,16rem)] min-h-[2.5rem] w-full resize-none bg-transparent px-2.5 py-1.5 text-[16px] outline-none"
                />
              </div>
            </div>
          {/* The file picker itself stays hidden; the paperclip triggers it.
              On iOS this offers photo library / camera / Files. */}
          <input
            ref={fileInputRef}
            type="file"
            disabled={creatingNewChat}
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="flex min-w-0 items-center justify-between gap-1.5">
<button
            // pointerup, not click: the iOS spell-check callout eats taps
            // that mousedown/click would need (Veneer lesson).
            type="button"
            onClick={event => { if(event.detail === 0) fileInputRef.current?.click(); }}
            onPointerUp={() => fileInputRef.current?.click()}
            disabled={creatingNewChat}
            aria-label="Attach files"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-5 w-5" />
          </button>
          {/* LEFT: model/thinking and approval-mode chips. Platform Dev stays
              elevated and intentionally has no approval control. */}
          {showChatControls && (chipLabel !== null || !isPlatformDev) ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {chipLabel !== null ? (
                <button
                  // pointerup, not click: the iOS spell-check callout eats taps
                  // that mousedown/click would need (Veneer lesson).
                  type="button"
                  onPointerUp={() => {
                    // iOS does not move focus from a textarea to a tapped button,
                    // and this dialog intentionally suppresses Radix's autofocus.
                    // Blur explicitly so the keyboard closes before the fixed
                    // dialog is positioned in the visual viewport.
                    textareaRef.current?.blur();
                    setModelPickerOpen(true);
                  }}
                  disabled={chipDisabled}
                  aria-label="Agent model and thinking"
                  className="flex min-w-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {activeProvider ? (
                    <ProviderIcon provider={activeProvider} className="size-3.5 shrink-0" />
                  ) : null}
                  <span className="min-w-0 truncate">{chipLabel}</span>
                  <ChevronDown className="size-3.5 shrink-0" />
                </button>
              ) : null}
              {!isPlatformDev ? (
                <div
                  role="group"
                  aria-label="Tool approvals"
                  title={
                    hasFullAccess
                      ? 'Full Access bypasses approval settings'
                      : shownApprovalMode === 'auto'
                      ? 'Allow: runs tools without asking — deny rules still apply'
                      : 'Ask: waits for your approval before running tools'
                  }
                  className={`flex shrink-0 items-center rounded-full border bg-muted/40 p-0.5 text-xs ${hasFullAccess ? 'opacity-50' : ''}`}
                >
                  {(['ask', 'auto'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onPointerUp={() => setChatApprovalMode(option)}
                      aria-pressed={shownApprovalMode === option}
                      disabled={hasFullAccess}
                      className={`rounded-full px-2 py-0.5 transition-colors ${
                        shownApprovalMode === option
                          ? 'bg-card font-medium text-foreground shadow-sm ring-1 ring-foreground/10'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {option === 'ask' ? 'Ask' : 'Allow'}
                    </button>
                  ))}
                </div>
              ) : null}
              {contextLabel ? (
                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground/70"
                  aria-label="Context used"
                  title="Context used / available (updates after each turn)"
                >
                  {contextLabel}
                </span>
              ) : null}
            </div>
          ) : (
            <span />
          )}
          {/* RIGHT: attach + dictate + send as one group. Empty composers hide
              send so the mic sits in the rightmost tap target; typing slides
              send back in. */}
          <div className="flex shrink-0 items-center gap-0.5">

          <button
            // pointerup, not click: the iOS spell-check callout eats taps
            // that mousedown/click would need (Veneer lesson).
            type="button"
            onPointerUp={() => toggleDictation()}
            aria-label={transcribing ? 'Finishing dictation' : recording ? 'Stop dictation' : 'Dictate message'}
            aria-pressed={recording}
            disabled={transcribing || creatingNewChat || !!liveVoice.pinnedId}
            className={cn(
              'relative flex shrink-0 items-center justify-center rounded-full transition-[width,height,color] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              enlargeMic ? 'size-10' : 'size-9',
              recording ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
              transcribing && 'animate-pulse opacity-60',
            )}
          >
            {recording ? <span className="absolute inset-1.5 animate-ping rounded-full bg-destructive/40" /> : null}
            <Mic
              className={cn(
                'relative transition-[width,height] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
                enlargeMic ? 'size-6' : 'size-5',
              )}
            />
          </button>
          <button type="button" aria-label="Live voice" title={conversationId === 'new' ? 'Send a message to create this conversation first' : 'Live voice'}
            disabled={conversationId === 'new' || recording || transcribing || creatingNewChat}
            onPointerUp={() => liveVoice.open(conversationId)}
            onClick={event => { if (event.detail === 0) liveVoice.open(conversationId); }}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40">
            <AudioLines className="size-5" />
          </button>
          {/* While the agent is working with nothing staged to send, the send
              button quietly becomes a stop button — a turn is interruptible
              right where the thumb already is. Type anything and it flips back
              to send (queueing the message mid-turn). */}
          <div
            className={cn(
              'transition-[width] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              trailingAction === 'hidden' ? 'w-0 overflow-hidden pointer-events-none' : 'w-10 overflow-visible',
            )}
            data-composer-trailing={trailingAction}
            aria-hidden={trailingAction === 'hidden'}
            inert={trailingAction === 'hidden' || undefined}
          >
            <div
              className={cn(
                'origin-center motion-reduce:animate-none motion-reduce:transition-none',
                trailingAction === 'hidden' && 'vp-composer-send-out',
                trailingAction === 'send' && 'vp-composer-send-in',
              )}
            >
          {trailingAction === 'stop' ? (
            <AgentWorkingStopButton
              onPointerUp={() => {
                // queueDraft() clears the draft mid-hold, which can flip the
                // send arrow into this Stop button before the physical
                // pointer-up. Swallow that stray up so a long-press queue never
                // fires an interrupt. Shares the same latch as the send arrow.
                if (lpFired.current) {
                  lpFired.current = false;
                  return;
                }
                void api.interrupt(conversationId).catch(() => undefined);
              }}
            />
          ) : (
            <Button
              // pointerup, not click: the iOS spell-check callout eats taps
              // that mousedown/click would need (Veneer lesson).
              size="icon-lg"
              tabIndex={trailingAction === 'hidden' ? -1 : undefined}
              className="size-10 shrink-0 select-none rounded-full text-xl [-webkit-touch-callout:none] disabled:opacity-30"
              onPointerDown={onSendPointerDown}
              onPointerMove={onSendPointerMove}
              onPointerUp={onSendPointerUp}
              onPointerLeave={cancelLp}
              onPointerCancel={cancelLp}
              disabled={
                trailingAction === 'hidden' ||
                creatingNewChat ||
                sendingAfterDictation ||
                !hasSendableContent ||
                (isNew && !assistantSlug)
              }
              aria-label={sendingAfterDictation ? 'Finishing dictation and sending' : 'Send'}
            >
              ↑
            </Button>
          )}
            </div>
          </div>
          </div>
          </div>
          </div>
        </div>
      </div>

      {previewFile ? (
        <SessionFileDialog
          conversationId={conversationId}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}

      {projectMarkdownPreview ? (
        <ProjectMarkdownDialog
          projectId={projectMarkdownPreview.projectId}
          path={projectMarkdownPreview.path}
          onClose={() => setProjectMarkdownPreview(null)}
        />
      ) : null}

      {/* Model + thinking picker, opened by the composer chip. One dialog for
          both modes: a new chat (cross-provider pick + effort) or an existing
          one (single-provider switch). Selections apply immediately and the
          dialog stays open so both can be set in one visit. */}
      {isNew ? (
        <ModelThinkingPicker
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
          choices={modelChoices}
          value={{ ...pick, effort: pickEffort }}
          defaultEffort={defaultEffortRef.current}
          onChange={(next) => {
            newChatSelectionTouchedRef.current = true;
            setPick({ provider: next.provider, model: next.model });
            setPickEffort(next.effort);
          }}
        />
      ) : null}
      {!isNew && activeProvider ? (
        <ModelThinkingPicker
          open={modelPickerOpen}
          onOpenChange={(open) => { if (!modelSaving) setModelPickerOpen(open); }}
          choices={modelChoices}
          value={chatPick}
          defaultEffort={defaultEffortRef.current}
          onChange={setChatPick}
          onApply={() => void applyChatModel()}
          busy={modelSaving}
          error={modelError}
          description={chatPick.provider !== activeProvider
            ? 'Keep this chat and its history. The next reply starts a fresh provider session with recorded context; internal session state does not transfer.'
            : `Applies to the next reply.${lastAnsweredModel ? ` Last answered by ${modelLabel(lastAnsweredModel) ?? lastAnsweredModel}.` : ''}`}
        />
      ) : null}

      <AlertDialog open={visibilityDialogOpen} onOpenChange={(open) => !menuBusy && setVisibilityDialogOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {visibility === 'team' ? 'Make this chat Private?' : 'Share this chat with the Team?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {visibility === 'team'
                ? 'Only you will be able to see and use this chat.'
                : 'Everyone on your team will be able to see the full chat and use its controls.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={menuBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={menuBusy}
              onPointerUp={() => void toggleVisibility()}
            >
              {menuBusy ? 'Saving…' : visibility === 'team' ? 'Make Private' : 'Share with Team'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renameDialogOpen} onOpenChange={(open) => !menuBusy && setRenameDialogOpen(open)}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void renameChat();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>Give this chat a name that reflects what you are working on.</DialogDescription>
            </DialogHeader>
            <Input
              className="mt-4"
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={300}
              autoFocus
              aria-label="Chat name"
              placeholder="Chat name"
              disabled={menuBusy}
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" disabled={menuBusy} onClick={() => setRenameDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={menuBusy || !renameDraft.trim()}>
                {menuBusy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <MoveChatDialog
        conversation={moveDialogOpen && !isNew ? { id: conversationId, title, projectId } : null}
        onOpenChange={setMoveDialogOpen}
        onMoved={(moved) => setProjectId(moved.projectId)}
        onToast={onToast}
      />
      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => !menuBusy && setDeleteDialogOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteConfirmation.title}</AlertDialogTitle>
            <AlertDialogDescription>{deleteConfirmation.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={menuBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={menuBusy} onPointerUp={() => void deleteChat()}>
              {menuBusy ? 'Deleting…' : deleteConfirmation.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

function joinDictation(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition;
  return base.endsWith(' ') || base.endsWith('\n') ? base + addition : `${base} ${addition}`;
}

type TranscriptItem = TranscriptState['items'][number];
type RenderItem = ActivityRenderItem;

// A secret request belongs in transcript flow. The question anchor adds a
// spacer that can keep resolved cards parked above the composer.
function isAnchoredPendingQuestion(item: RenderItem): boolean {
  return item.kind === 'question'
    && item.status === 'pending'
    && item.questions[0]?.kind !== 'secret'
    && item.questions[0]?.kind !== 'reveal';
}

// Memoized so parent re-renders (composer keystrokes, streaming updates) skip
// untouched rows. Also rendered by renderToStaticMarkup for
// the frozen transcript — everything below must stay renderable statically:
// expansion is native <details>, images are delegated data-lightbox-* clicks.
// A compact wall-clock time (e.g. "3:45 PM") for the send-time shown under a
// user prompt. Empty string for a missing/unparseable timestamp so the caller
// can skip rendering it.
function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Wake-up deliveries arrive as ordinary user-role messages, so the only marker
// the transcript carries is the scheduler's own prompt wrapper. Matching it
// keeps a self-scheduled continuation from reading as something the user typed.
const WAKEUP_PROMPT_PREFIX = 'Hey, can you pick this back up for me?';
const WAKEUP_PROMPT_SUFFIX = 'Please check what changed while you were away before you continue.';

function isWakeupPrompt(text: string): boolean {
  return text.trimStart().startsWith(WAKEUP_PROMPT_PREFIX);
}

function wakeupReasonText(text: string): string {
  let body = text.trimStart().slice(WAKEUP_PROMPT_PREFIX.length).trim();
  if (body.endsWith(WAKEUP_PROMPT_SUFFIX)) body = body.slice(0, -WAKEUP_PROMPT_SUFFIX.length).trim();
  return body || text;
}

function isCollapsibleUserPrompt(
  item: TranscriptItem | RenderItem,
): item is Extract<TranscriptItem, { kind: 'user' }> {
  return (
    item.kind === 'user' &&
    !isBuildQueuePrompt(item) &&
    !isTaskNotification(item.text) &&
    !isSkillContent(item.text) &&
    !isWakeupPrompt(item.text)
  );
}

function shouldCollapsePrompt(
  item: RenderItem,
  firstPromptKey: string | null,
  mostRecentPromptKey: string | null,
): boolean {
  if (item.kind === 'user' && isBuildQueuePrompt(item)) {
    return shouldCollapseEligiblePrompt(
      item,
      visiblePromptText(item.text),
      firstPromptKey,
      mostRecentPromptKey,
    );
  }
  if (!isCollapsibleUserPrompt(item)) return false;
  return shouldCollapseEligiblePrompt(
    item,
    visiblePromptText(item.text),
    firstPromptKey,
    mostRecentPromptKey,
  );
}

// Copy a prompt to the clipboard and flash the button's check state. Driven by
// a DOM attribute (not React state) so the same helper works for both live rows
// and frozen static-HTML rows (reached via the delegated onFrozenClick).
function copyPromptText(btn: HTMLElement, text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  btn.dataset.copied = 'true';
  window.setTimeout(() => {
    btn.removeAttribute('data-copied');
  }, 1200);
}

const MEMORY_POPOVER_MARGIN = 16;
const MEMORY_POPOVER_GAP = 8;
const MEMORY_POPOVER_MAX_WIDTH = 576;

function positionMemoryPopover(trigger: HTMLElement): void {
  const popoverId = trigger.dataset.memoryPopover;
  const popover = popoverId ? document.getElementById(popoverId) : null;
  if (!(popover instanceof HTMLElement)) return;

  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(0, Math.min(MEMORY_POPOVER_MAX_WIDTH, viewportWidth - MEMORY_POPOVER_MARGIN * 2));
  const maxLeft = Math.max(MEMORY_POPOVER_MARGIN, viewportWidth - MEMORY_POPOVER_MARGIN - width);
  const left = Math.min(maxLeft, Math.max(MEMORY_POPOVER_MARGIN, rect.right - width));
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - MEMORY_POPOVER_GAP - MEMORY_POPOVER_MARGIN);
  const spaceAbove = Math.max(0, rect.top - MEMORY_POPOVER_GAP - MEMORY_POPOVER_MARGIN);
  const placeBelow = spaceBelow >= spaceAbove;

  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.right = 'auto';
  if (placeBelow) {
    popover.dataset.placement = 'below';
    popover.style.top = `${rect.bottom + MEMORY_POPOVER_GAP}px`;
    popover.style.bottom = 'auto';
    popover.style.maxHeight = `${spaceBelow}px`;
  } else {
    popover.dataset.placement = 'above';
    popover.style.top = 'auto';
    popover.style.bottom = `${viewportHeight - rect.top + MEMORY_POPOVER_GAP}px`;
    popover.style.maxHeight = `${spaceAbove}px`;
  }
}

// Footnote under a user prompt listing the memories Supermemory recalled for it.
// Native popover targeting keeps it interactive in frozen static-HTML rows and
// promotes the panel into the top layer, outside the scroller's paint clipping.
function MemoryRecallChip({
  memories,
  popoverId,
}: {
  memories: NonNullable<Extract<ChatItem, { kind: 'user' }>['memories']>;
  popoverId: string;
}) {
  const count = memories.length;
  const label = `${count} recalled ${count === 1 ? 'memory' : 'memories'}`;
  return (
    <>
      <button
        type="button"
        popoverTarget={popoverId}
        data-memory-popover={popoverId}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className="group/memory inline-flex cursor-pointer items-center justify-center rounded-lg text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height: 44, minWidth: 44, marginBlock: -10 }}
      >
        <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 transition-colors group-hover/memory:bg-accent group-hover/memory:text-foreground" aria-hidden="true">
          <Sparkles className="h-3 w-3" />
          <span>{count}</span>
        </span>
      </button>
      <div
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-label={`${label} details`}
        className="fixed inset-auto z-50 m-0 max-w-none space-y-1.5 overflow-y-auto overscroll-contain rounded-lg border bg-background p-2 text-left text-xs text-foreground shadow-lg"
      >
        {memories.map((m, i) => (
          <div key={i} className="flex flex-col gap-1">
            <span className="whitespace-pre-wrap text-foreground">{m.content}</span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide">{m.scope}</span>
              <span>{m.source === 'profile' ? 'standing profile' : m.source === 'search' ? 'search' : 'legacy recall'}</span>
              {m.relevance === 'semantic' ? <span>· semantic match</span> : null}
              {m.relevance === 'direct' ? <span>· direct match</span> : null}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Sent-message text with @mentions rendered as chips: connector mentions get
 *  the brand logo, chat mentions become links to that chat. Both come from the
 *  message text alone (catalog matching + the send-time id footer), so frozen
 *  static-HTML rows render identically — the chat chip is a plain <a>. */
function UserTextWithMentions({ text, tone = 'contrast' }: { text: string; tone?: 'contrast' | 'subtle' }) {
  const unmarked = splitSkillInvocationMarker(text).visible;
  const { visible, chatTokens } = splitChatMentionFooter(unmarked);
  const segments = segmentMentions(visible, undefined, chatTokens);
  if (!segments.some((seg) => seg.kind !== 'text')) return visible;
  const pill = cn(
    'mx-0.5 inline-flex translate-y-0.5 items-center gap-1 rounded-md px-1.5',
    tone === 'contrast' ? 'bg-primary-foreground/15' : 'bg-foreground/6',
  );
  return segments.map((seg, i) => {
    if (seg.kind === 'mention') {
      return (
        <span key={i} className={pill}>
          <ConnectorGlyph slug={seg.slug} className="size-3.5" />
          {seg.text}
        </span>
      );
    }
    if (seg.kind === 'chat') {
      return (
        // data-app-route keeps the delegated transcript click handler on the
        // in-app onNavigate path; without it the fallback window.open()s a
        // whole new window (a fresh PWA instance on desktop).
        <a
          key={i}
          href={`#/chat/${seg.id}`}
          data-app-route={`#/chat/${seg.id}`}
          className={cn(pill, tone === 'contrast' ? 'hover:bg-primary-foreground/25' : 'hover:bg-foreground/10')}
        >
          <MessageSquare className="size-3.5 shrink-0" />
          {seg.text}
        </a>
      );
    }
    return seg.text;
  });
}

/** The clean prompt for copy buttons and collapsed views — footer stripped. */
function visiblePromptText(text: string): string {
  return splitChatMentionFooter(splitSkillInvocationMarker(text).visible).visible;
}

function agentPromptText(text: string, wakeup: boolean): string {
  const unmarked = splitSkillInvocationMarker(text).visible;
  return wakeup ? wakeupReasonText(unmarked) : unmarked;
}

type UserTranscriptItem = Extract<TranscriptItem, { kind: 'user' }>;
type AuthenticatedMessageOrigin = NonNullable<UserTranscriptItem['origin']>;

function AgentPromptRow({
  item,
  origin,
  collapsePrompt,
}: {
  item: UserTranscriptItem;
  origin: AuthenticatedMessageOrigin;
  collapsePrompt: boolean;
}) {
  const displayText = agentPromptText(item.text, origin.kind === 'wakeup');
  const copyText = visiblePromptText(displayText);
  const scheduled = origin.kind === 'wakeup';
  const sourceChat = origin.kind === 'agent' ? origin.sourceChat : undefined;
  const fallbackLabel = origin.from === 'Remote agent' ? 'Remote agent message' : 'Agent message';
  const footer = (
    <MessageFooter className="gap-1.5">
      {item.memories?.length ? (
        <MemoryRecallChip
          memories={item.memories}
          popoverId={`memory-recall-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
        />
      ) : null}
      {item.at ? <time dateTime={item.at}>{formatClockTime(item.at)}</time> : null}
      <button
        type="button"
        data-copy={copyText}
        onClick={(event) => copyPromptText(event.currentTarget, copyText)}
        aria-label="Copy agent message"
        title="Copy agent message"
        className="group/copy relative inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Copy className="size-3.5 group-data-[copied=true]/copy:hidden" />
        <Check className="hidden size-3.5 text-brand group-data-[copied=true]/copy:block" />
        <span
          className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
          aria-hidden="true"
        />
      </button>
    </MessageFooter>
  );

  if (isLocalAgentOrigin(origin)) {
    return (
      <Message>
        <MessageContent>
          <Bubble variant="subtle" className="w-full max-w-[88%] sm:max-w-[80%]">
            <BubbleContent className="w-full rounded-2xl rounded-bl-md border-0 p-0 text-base">
              <AgentMessagePromptDisclosure origin={origin}>
                <UserTextWithMentions text={displayText} tone="subtle" />
              </AgentMessagePromptDisclosure>
            </BubbleContent>
          </Bubble>
          {footer}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message>
      <MessageContent>
        <Bubble variant="subtle" className="max-w-[88%] sm:max-w-[80%]">
          <BubbleContent className="rounded-2xl rounded-bl-md border-0 px-4 py-3 text-base">
            <div className="flex min-w-0 items-center gap-1.5 pb-1.5 text-sm font-medium text-foreground/70">
              <Bot className="size-4 shrink-0" aria-hidden="true" />
              {sourceChat ? (
                <a
                  href={`#/chat/${sourceChat.id}`}
                  data-app-route={`#/chat/${sourceChat.id}`}
                  aria-label={`Agent message from ${sourceChat.title}. Open source chat`}
                  title="Open source chat"
                  className="min-w-0 truncate rounded-sm underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {sourceChat.title}
                </a>
              ) : (
                <span className="truncate">
                  {fallbackLabel}
                  {scheduled ? <span className="sr-only">, scheduled follow-up</span> : null}
                </span>
              )}
            </div>
            <div className="whitespace-pre-wrap">
              {collapsePrompt ? (
                <PromptDisclosure text={copyText} />
              ) : (
                <UserTextWithMentions text={displayText} tone="subtle" />
              )}
            </div>
          </BubbleContent>
        </Bubble>
        {footer}
      </MessageContent>
    </Message>
  );
}

const ChatRow = memo(function ChatRow({
  item,
  live,
  collapsePrompt,
}: {
  item: RenderItem;
  live: boolean;
  collapsePrompt: boolean;
}) {
  if (item.kind === 'user') {
    if (isTaskNotification(item.text)) {
      return <TaskNotificationRow text={item.text} />;
    }
    if (isSkillContent(item.text)) {
      return <SkillContentRow text={item.text} />;
    }
    if (item.origin && item.origin.kind !== 'build_queue') {
      return <AgentPromptRow item={item} origin={item.origin} collapsePrompt={collapsePrompt} />;
    }
    if (isWakeupPrompt(item.text)) {
      return (
        <AgentPromptRow
          item={item}
          origin={{ kind: 'wakeup', from: 'Agent', to: 'Agent' }}
          collapsePrompt={false}
        />
      );
    }
    return (
      <Message align="end">
        <MessageContent>
          <Bubble align="end">
            <BubbleContent data-message-quote="user" className="whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-base">
              {collapsePrompt ? (
                <PromptDisclosure text={visiblePromptText(item.text)} />
              ) : (
                <UserTextWithMentions text={item.text} />
              )}
            </BubbleContent>
          </Bubble>
          <MessageFooter className="gap-1.5">
            {item.memories?.length ? (
              <MemoryRecallChip
                memories={item.memories}
                popoverId={`memory-recall-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
              />
            ) : null}
            {item.at ? (
              <time dateTime={item.at}>{formatClockTime(item.at)}</time>
            ) : null}
            {/* data-copy carries the exact text so frozen (static-HTML) rows copy
                through the delegated onFrozenClick handler; live rows use onClick. */}
            <button
              type="button"
              data-copy={visiblePromptText(item.text)}
              onClick={(e) => copyPromptText(e.currentTarget, visiblePromptText(item.text))}
              aria-label="Copy prompt"
              title="Copy prompt"
              className="group/copy inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5 group-data-[copied=true]/copy:hidden" />
              <Check className="hidden h-3.5 w-3.5 text-brand group-data-[copied=true]/copy:block" />
            </button>
          </MessageFooter>
        </MessageContent>
      </Message>
    );
  }
  if (item.kind === 'assistant') {
    const citations = extractCitations(item.markdown);
    const hasMermaid = containsMermaidFence(item.markdown);
    return (
      <Message data-vp-mermaid-row={hasMermaid ? '' : undefined}>
        <MessageContent>
          <Bubble variant="muted" className="w-fit max-w-[94%]">
            <BubbleContent className="rounded-3xl border-0 px-4 py-3 text-base leading-relaxed">
              <div data-message-quote="assistant">
                <AssistantMarkdown markdown={item.markdown} live={live} citations={citations} />
              </div>
              {item.turnId&&item.at&&<div className="-mx-2 mt-1 flex flex-wrap items-center font-sans" role="group" aria-label="Result discussion and reactions">
                <button type="button" data-message-listen={JSON.stringify({turn:item.turnId,at:item.at})} aria-label="Listen to full message" className="min-h-[44px] min-w-[44px] rounded-full px-2 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring hover:bg-foreground/5 active:bg-foreground/10 disabled:opacity-50">▶ Listen</button>
                <button type="button" data-result-thread={JSON.stringify({turn:item.turnId,at:item.at})} aria-label="Reply in thread" className="min-h-[44px] min-w-[44px] rounded-full px-2 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring hover:bg-foreground/5 active:bg-foreground/10 disabled:opacity-50 data-[unread=true]:bg-blue-600/10 data-[unread=true]:font-semibold data-[unread=true]:text-foreground">Reply</button>
                {['👍','❤️','👀'].map(emoji=><button key={emoji} type="button" data-result-reaction={emoji} data-result-anchor={JSON.stringify({turn:item.turnId,at:item.at})} aria-label={`React ${emoji} · does not approve`} aria-pressed={false} className="min-h-[44px] min-w-[44px] rounded-full px-2 text-xs hover:bg-foreground/5 active:bg-foreground/10 disabled:opacity-50 aria-pressed:bg-blue-600/10 focus-visible:outline-2 focus-visible:outline-ring">{emoji}</button>)}
              </div>}
            </BubbleContent>
          </Bubble>
          {citations.length ? (
            <MessageFooter className="gap-1.5">
              <CitationChip citations={citations} />
            </MessageFooter>
          ) : null}
          <AssistantResponseMetadata at={item.at} usage={item.usage} />
        </MessageContent>
      </Message>
    );
  }
  if (item.kind === 'tool-group') {
    return <ToolGroupRow tools={item.tools} />;
  }
  if (item.kind === 'connection-tool') {
    return <ConnectionToolRow item={item.tool} />;
  }
  if (item.kind === 'subagent-group') {
    return <SubagentGroupRow agents={item.agents} />;
  }
  if (item.kind === 'approval') {
    return <ApprovalCard item={item} />;
  }
  if (item.kind === 'question') {
    if (item.questions[0]?.kind === 'secret') return <SecretCard item={item} />;
    if (item.questions[0]?.kind === 'reveal') return <RevealSecretCard item={item} />;
    return <QuestionCard item={item} />;
  }
  if (item.kind === 'notice') {
    // A neutral confirmation (e.g. "Stopped.") — muted, never the alarming red
    // reserved for genuine failures.
    return (
      <Marker className="text-muted-foreground">
        <MarkerContent>{item.message}</MarkerContent>
      </Marker>
    );
  }
  return (
    <Marker className="text-destructive">
      <MarkerContent>{item.message}</MarkerContent>
      {CLAUDE_LOGIN_ERROR_RE.test(item.message) ? (
        <Button asChild size="sm" variant="outline" className="ml-auto shrink-0 border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive">
          <a href="#/settings/providers?tab=providers" data-app-route="#/settings/providers?tab=providers">
            Connect Claude
          </a>
        </Button>
      ) : null}
    </Marker>
  );
});

function frozenItemVersion(
  item: RenderItem,
  firstPromptKey: string | null,
  mostRecentPromptKey: string | null,
): string {
  if (item.kind === 'subagent-group') {
    return item.agents
      .map((agent) => `${agent.key}:${agent.status}:${agent.label}:${agent.model ?? ''}:${agent.role ?? ''}:${agent.effort ?? ''}:${agent.startedAt ?? ''}:${agent.durationMs ?? ''}:${agent.currentAction ?? ''}:${agent.actionCount ?? ''}:${agent.filesChanged ?? ''}:${agent.linesAdded ?? ''}:${agent.linesRemoved ?? ''}:${agent.resultLabel ?? ''}`)
      .join('|');
  }
  if (item.kind === 'user') {
    return `${item.key}:${item.origin?.kind ?? 'human'}:${item.origin?.local ? 'local' : 'nonlocal'}:${item.origin?.from ?? ''}:${item.origin?.to ?? ''}:${item.origin?.sourceChat?.id ?? ''}:${item.origin?.sourceChat?.title ?? ''}:${shouldCollapsePrompt(item, firstPromptKey, mostRecentPromptKey) ? 'collapsed' : 'open'}`;
  }
  if (item.kind === 'assistant') {
    return `${item.key}:${item.at ?? ''}:${item.usage?.totalTokens ?? ''}`;
  }
  return `${item.key}:${shouldCollapsePrompt(item, firstPromptKey, mostRecentPromptKey) ? 'collapsed' : 'open'}`;
}

const FrozenStaticSegment = memo(function FrozenStaticSegment({
  items,
  firstPromptKey,
  mostRecentPromptKey,
  onClick,
}: {
  items: RenderItem[];
  firstPromptKey: string | null;
  mostRecentPromptKey: string | null;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const keysRef = useRef<string[]>([]);
  const versionsRef = useRef<string[]>([]);

  // Append only the newly frozen rows. Existing static DOM stays untouched,
  // preserving long-chat scroll position and the prior freezing fast path.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const keys = keysRef.current;
    const versions = versionsRef.current;
    const intact = keys.length <= items.length && keys.every((key, index) => (
      items[index]!.key === key
      && versions[index] === frozenItemVersion(items[index]!, firstPromptKey, mostRecentPromptKey)
    ));
    if (!intact) {
      keys.length = 0;
      versions.length = 0;
      el.replaceChildren();
    }
    if (items.length === keys.length) return;

    const template = document.createElement('template');
    template.innerHTML = items
      .slice(keys.length)
      .map((item) => renderToStaticMarkup(
        <div
          data-message-id={item.key}
          className="min-w-0 data-[linked-focus=true]:rounded-xl data-[linked-focus=true]:bg-brand/5 data-[linked-focus=true]:ring-1 data-[linked-focus=true]:ring-brand/30"
        >
          <ChatRow
            item={item}
            live={false}
            collapsePrompt={shouldCollapsePrompt(item, firstPromptKey, mostRecentPromptKey)}
          />
        </div>,
      ))
      .join('');
    el.append(template.content);

    for (let index = keys.length; index < items.length; index++) {
      keys.push(items[index]!.key);
      versions.push(frozenItemVersion(items[index]!, firstPromptKey, mostRecentPromptKey));
    }
  }, [firstPromptKey, items, mostRecentPromptKey]);

  return (
    <div
      ref={ref}
      data-frozen-transcript-segment
      onClick={onClick}
      className="flex min-w-0 flex-col gap-3 empty:hidden"
    />
  );
});

// Current provider adapters consume task notifications into normalized
// sub-agent events. This remains only as a privacy-safe fallback for older
// snapshots that already stored the provider envelope as a user row.
function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>');
}

// Invoking a skill makes the harness inject the skill's whole SKILL.md as a
// user turn (prefixed with its base directory). Rendered as a normal bubble it
// reads as if the user pasted the entire skill — so we collapse it to a
// one-line marker, expandable to reveal the body, like task-notifications.
const SKILL_PREFIX = 'Base directory for this skill:';

function isSkillContent(text: string): boolean {
  return text.trimStart().startsWith(SKILL_PREFIX);
}

// The base-directory line ends with the skill's own folder name, e.g.
// ".../bundled-skills/2.1.200/<hash>/claude-api" → "claude-api".
function skillNameFromContent(text: string): string {
  const firstLine = text.trimStart().split('\n', 1)[0] ?? '';
  const dir = firstLine.slice(firstLine.indexOf(SKILL_PREFIX) + SKILL_PREFIX.length).trim();
  const name = dir.split('/').filter(Boolean).pop();
  return name || 'skill';
}

function SkillContentRow({ text }: { text: string }) {
  const name = skillNameFromContent(text);
  return (
    <details className="group/note">
      <summary className={cn(SUMMARY_ROW, 'group/marker text-sm text-muted-foreground')}>
        <MarkerIcon>
          <Wrench className="h-3.5 w-3.5" />
        </MarkerIcon>
        <span className="min-w-0 flex-1 truncate">
          Skill loaded: <span className="text-foreground">{name}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/note:rotate-180" />
      </summary>
      <pre className="mt-1 ml-6 max-h-96 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

// Hides the ▸ marker and makes a <summary> line look like our row buttons.
const SUMMARY_ROW =
  'flex w-full min-w-0 cursor-pointer list-none items-center gap-2 text-left [&::-webkit-details-marker]:hidden';

function TaskNotificationRow({ text }: { text: string }) {
  const rawStatus = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim().toLowerCase();
  const status = rawStatus === 'completed'
    ? 'Finished'
    : rawStatus === 'killed' || rawStatus === 'stopped' || rawStatus === 'interrupted'
      ? 'Stopped'
      : rawStatus === 'failed' || rawStatus === 'errored'
        ? 'Failed'
        : null;

  return (
    <Marker className="text-sm text-muted-foreground">
      <MarkerIcon>
        <Bell className="h-3.5 w-3.5" />
      </MarkerIcon>
      <MarkerContent className="min-w-0 flex-1 truncate">Background task update</MarkerContent>
      {status ? <span className="shrink-0 text-xs text-muted-foreground">{status}</span> : null}
    </Marker>
  );
}

// A message the user just sent, shown before the server has confirmed it —
// dimmed with a status caption so a send never silently vanishes. `queued`
// distinguishes "waiting behind the current turn" from the brief moment
// before the in-flight turn even starts.
function PendingUserRow({
  text,
  queued,
  collapsePrompt,
  canSendNow,
  onSendNow,
}: {
  text: string;
  queued: boolean;
  collapsePrompt: boolean;
  canSendNow: boolean;
  onSendNow: () => void;
}) {
  return (
    <Message align="end" className="opacity-60">
      <MessageContent>
        <Bubble align="end">
          <BubbleContent data-message-quote="user" className="whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-base">
            {collapsePrompt ? (
              <PromptDisclosure text={visiblePromptText(text)} />
            ) : (
              <UserTextWithMentions text={text} />
            )}
          </BubbleContent>
        </Bubble>
        <MessageFooter className="gap-1">
          <Clock className="size-3 shrink-0" />
          <span>{queued ? 'Queued — sends after current reply' : 'Sending…'}</span>
          {canSendNow ? (
            <button
              type="button"
              onPointerUp={onSendNow}
              className="font-medium text-foreground underline underline-offset-2"
            >
              Send now
            </button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

// `live` is true only for a message that just finished streaming in this
// session (not one loaded from history) — it continues the typewriter reveal
// seamlessly from wherever the streaming bubble above left off.
function AssistantMarkdown({
  markdown,
  live,
  citations,
}: {
  markdown: string;
  live: boolean;
  citations: Citation[];
}) {
  const revealed = useTypewriter(markdown, live);
  return <Markdown markdown={revealed} citations={citations} mode={live ? 'streaming' : 'static'} />;
}

function ToolStatusDot({ running, ok }: { running: boolean; ok: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full align-middle ${
        running ? 'bg-brand' : ok ? 'bg-border' : 'bg-destructive'
      }`}
    />
  );
}

function ToolMarkerIcon({
  source,
  running,
  ok,
}: {
  source: ToolChatItem['source'];
  running: boolean;
  ok: boolean;
}) {
  if (!source) return <ToolStatusDot running={running} ok={ok} />;
  return <ConnectorGlyph slug={source.slug} name={source.name} className="size-5 dark:brightness-125" />;
}

function subagentStatusLabel(status: SubagentChatItem['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working';
    case 'completed':
      return 'Finished';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
  }
}

function subagentModelName(model: string | undefined): string | null {
  if (!model) return null;
  const label = modelLabel(model) ?? model;
  return /^(opus|sonnet|haiku|fable)$/i.test(label)
    ? label[0]!.toUpperCase() + label.slice(1).toLowerCase()
    : label;
}

function SubagentGroupRow({ agents }: { agents: SubagentChatItem[] }) {
  const active = agents.some((agent) => agent.status === 'queued' || agent.status === 'running');
  const timedActive = agents.some(
    (agent) => (agent.status === 'queued' || agent.status === 'running') && Boolean(agent.startedAt),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timedActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timedActive]);
  const summary = subagentGroupSummary(agents);

  return (
    <details className="group/agents">
      <summary className={cn(SUMMARY_ROW, 'group/marker text-sm text-muted-foreground')}>
        <MarkerIcon>
          <GitFork className={cn('h-3.5 w-3.5', active && 'text-brand')} />
        </MarkerIcon>
        <span className={cn('min-w-0 flex-1 truncate', active && 'shimmer')}>{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/agents:rotate-180" />
      </summary>
      <div className="mt-0.5 ml-2 flex flex-col gap-1 border-l border-border pl-3 sm:mt-1 sm:gap-1.5">
        {agents.map((agent) => {
          const model = subagentModelName(agent.model);
          const role = agent.role && agent.role.toLowerCase() !== 'claude' ? agent.role : null;
          const effort = agent.effort
            ? `${agent.effort[0]!.toUpperCase()}${agent.effort.slice(1).toLowerCase()} effort`
            : null;
          const detail = [model, role, effort].filter(Boolean).join(' · ');
          const progress = subagentProgressSummary(agent, now);
          return (
            <div key={agent.key} className="flex min-w-0 items-start gap-1.5 text-[11px] leading-[14px] text-muted-foreground sm:gap-2 sm:text-xs sm:leading-4">
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full sm:mt-1.5',
                  agent.status === 'queued' || agent.status === 'running'
                    ? 'bg-brand'
                    : agent.status === 'failed'
                      ? 'bg-destructive'
                      : 'bg-border',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{agent.label}</span>
                  {detail ? <span className="min-w-0 max-w-28 truncate sm:max-w-48">{detail}</span> : null}
                  <span className={cn('shrink-0', agent.status === 'failed' && 'text-destructive')}>
                    {subagentStatusLabel(agent.status)}
                  </span>
                </div>
                {progress ? <div className="mt-px text-[10px] leading-[13px] text-muted-foreground/80 sm:mt-0.5 sm:text-[11px] sm:leading-4">{progress}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// A run of consecutive tool calls collapses to one line showing the latest
// call and a count, expandable to reveal each call (which is itself
// expandable to show its input/result detail).
function ToolGroupRow({ tools }: { tools: ToolChatItem[] }) {
  if (tools.length === 1) {
    return <ToolRow item={tools[0]!} />;
  }

  const latest = tools[tools.length - 1]!;
  const running = tools.some((t) => t.running);
  const ok = tools.every((t) => t.ok);
  const agentMessageLabel = agentMessageGroupLabel(tools);
  const sharedSource = latest.source && tools.every((tool) => tool.source?.mention === latest.source?.mention)
    ? latest.source
    : undefined;

  return (
    <div>
      <details className="peer group/run">
        <summary className={cn(SUMMARY_ROW, 'group/marker text-sm text-muted-foreground')}>
          <MarkerIcon className={latest.source ? 'size-5' : undefined}>
            <ToolMarkerIcon source={latest.source} running={running} ok={ok} />
          </MarkerIcon>
          <span className={cn('min-w-0 flex-1 truncate', running && 'shimmer')}>
            {agentMessageLabel ?? latest.label}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tools.length}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/run:rotate-180" />
        </summary>
        <div className="mt-1 ml-2 flex flex-col gap-1 border-l border-border pl-3">
          {sharedSource ? (
            <div className="flex flex-wrap items-center gap-x-1.5 pb-0.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Connection</span>
              <span>{connectorDetail(sharedSource)}</span>
            </div>
          ) : null}
          {tools.map((tool) => (
            <ToolRow key={tool.key} item={tool} grouped showConnection={!sharedSource} />
          ))}
        </div>
      </details>
      {/* Collapsed: still surface every image the run produced — a screenshot
          shouldn't hide behind the fold. Expanded (peer-open), each ToolRow
          shows its own instead. */}
      <ToolImages
        images={tools.flatMap((t) => t.images.map((id) => ({ id, name: t.label })))}
        className="ml-6 peer-open:hidden"
      />
    </div>
  );
}

// Always-visible thumbnails for images a tool result carried (screenshots
// etc.) — shown even while the row's text detail is collapsed, since the
// image usually IS the interesting output. Tap → chat-level lightbox.
function ToolImages({ images, className }: { images: { id: string; name: string }[]; className?: string }) {
  const openImage = useContext(ImageLightboxContext);
  if (!images.length) return null;
  return (
    <div className={cn('mt-1.5 flex flex-wrap gap-2', className)}>
      {images.map((img, i) => (
        <button
          key={`${img.id}-${i}`}
          type="button"
          // data-lightbox-* serves frozen (static-HTML) rows via the delegated
          // container click; onClick serves live rows. Same overlay either way.
          data-lightbox-src={`/api/media/${img.id}`}
          data-lightbox-name={img.name}
          onClick={() => openImage({ src: `/api/media/${img.id}`, name: img.name })}
          className="overflow-hidden rounded-lg border border-border focus-visible:outline-2"
          aria-label={`Expand image: ${img.name}`}
        >
          <img
            src={`/api/media/${img.id}`}
            alt={img.name}
            loading="lazy"
            className="block h-28 max-w-60 object-cover"
          />
        </button>
      ))}
    </div>
  );
}

function connectorDetail(source: NonNullable<ToolChatItem['source']>): string {
  const identity = [source.name, source.label, source.sharing === 'shared' ? 'Shared' : null].filter(Boolean).join(' · ');
  return `${identity} · @${source.mention}`;
}

function ToolRow({
  item,
  grouped = false,
  showConnection = true,
}: {
  item: ToolChatItem;
  grouped?: boolean;
  showConnection?: boolean;
}) {
  const agentMessageLabel = agentMessageActivityLabel(item);
  const hasDetail = Boolean(agentMessageLabel || (showConnection && item.source) || item.inputPreview || item.resultPreview);
  const label = agentMessageLabel ?? (grouped && item.source ? item.actionLabel : item.label);
  const line = (
    <>
      <Marker className="min-w-0 flex-1">
        <MarkerIcon className={item.source ? 'size-5' : undefined}>
          <ToolMarkerIcon source={item.source} running={item.running} ok={item.ok} />
        </MarkerIcon>
        <MarkerContent className={item.running ? 'shimmer' : undefined}>{label}</MarkerContent>
      </Marker>
      {hasDetail ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/message-disclosure:rotate-180 group-open/tool:rotate-180" />
      ) : null}
    </>
  );

  return (
    <div>
      {agentMessageLabel ? (
        <CollapsedMessageDisclosure summary={line}>
          <AgentMessageToolDetails item={item} />
        </CollapsedMessageDisclosure>
      ) : hasDetail ? (
        <details className="group/tool">
          <summary className={SUMMARY_ROW}>{line}</summary>
          <div className="mt-1 ml-6 max-h-64 overflow-auto rounded-md bg-muted/50 text-xs text-muted-foreground">
            {showConnection && item.source ? (
              <div className="flex flex-wrap items-center gap-x-1.5 border-b border-border/60 px-2 py-1.5">
                <span className="font-medium text-foreground/80">Connection</span>
                <span>{connectorDetail(item.source)}</span>
              </div>
            ) : null}
            {item.inputPreview || item.resultPreview ? (
              <pre className="p-2 whitespace-pre-wrap">
                {[item.inputPreview && `Input: ${item.inputPreview}`, item.resultPreview && `Result: ${item.resultPreview}`]
                  .filter(Boolean)
                  .join('\n\n')}
              </pre>
            ) : null}
          </div>
        </details>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-2">{line}</div>
      )}
      <ToolImages images={item.images.map((id) => ({ id, name: item.label }))} className="ml-6" />
    </div>
  );
}

// Preview overlay for a file the agent created: images render inline, CSV/TSV
// render as a table, other text files as plain text, and remaining binaries
// fall back to download-only.
function SessionFileDialog({
  conversationId,
  file,
  onClose,
}: {
  conversationId: string;
  file: SessionFile;
  onClose: () => void;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    error?: string;
    content?: string;
    truncated?: boolean;
    binary?: boolean;
  }>({ loading: true });
  const isImage = SESSION_IMAGE_RE.test(file.name);
  const isOffice = SESSION_OFFICE_RE.test(file.name);
  const isHtml = isHtmlFileName(file.name);
  const isMarkdown = isMarkdownFileName(file.name);
  const isCode = isCodeFileName(file.name);

  useEffect(() => {
    if (isImage || isOffice || isHtml) return;
    let stop = false;
    setState({ loading: true });
    void api
      .conversationFilePreview(conversationId, file.path)
      .then((r) => {
        if (!stop) setState({ loading: false, content: r.content, truncated: r.truncated, binary: r.binary });
      })
      .catch((err: Error) => {
        if (!stop) setState({ loading: false, error: err.message });
      });
    return () => {
      stop = true;
    };
  }, [conversationId, file.path, isHtml, isImage, isOffice]);

  const isTable = /\.(csv|tsv)$/i.test(file.name);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={`flex max-h-[85dvh] flex-col ${isOffice || isHtml || isCode ? 'sm:max-w-5xl' : 'sm:max-w-2xl'}`}>
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{file.name}</DialogTitle>
          <DialogDescription>
            {formatBytes(file.size)} · updated {new Date(file.mtime).toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        <div className={`min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border bg-card ${isOffice || isHtml || isCode ? 'flex h-[70dvh]' : ''}`}>
          {isImage ? (
            <img
              src={api.conversationFileInlineUrl(conversationId, file.path)}
              alt={file.name}
              className="mx-auto max-h-[70dvh] w-auto object-contain"
            />
          ) : isOffice ? (
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Preparing document preview…</p>}>
              <OfficePreview
                fileName={file.name}
                url={api.conversationFileInlineUrl(conversationId, file.path)}
              />
            </Suspense>
          ) : isHtml ? (
            <HtmlFilePreview
              key={file.path}
              title={file.name}
              url={api.conversationFileInlineUrl(conversationId, file.path)}
              loadSource={() => api.conversationFilePreview(conversationId, file.path)}
            />
          ) : state.loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>
          ) : state.error ? (
            <p className="p-4 text-sm text-destructive">{state.error}</p>
          ) : state.binary || state.content === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">No preview for this file type — download it instead.</p>
          ) : isTable ? (
            <CsvTable text={state.content} delimiter={delimiterFor(file.name)} />
          ) : isMarkdown ? (
            <MarkdownFilePreview content={state.content} imageBaseUrl={api.conversationFileMarkdownImageUrl(conversationId, file.path, '')} />
          ) : isCode ? (
            <CodeFilePreview
              fileName={file.name}
              content={state.content}
              cacheKey={`conversation:${conversationId}:${file.path}:${file.mtime}`}
            />
          ) : (
            <pre className="p-3 text-xs whitespace-pre-wrap">{state.content}</pre>
          )}
        </div>
        {!isHtml && state.truncated ? (
          <p className="text-xs text-muted-foreground">Preview shows the first part of this file — download for all of it.</p>
        ) : null}
        <DialogFooter>
          <FileDownloadLink
            href={api.conversationFileDownloadUrl(conversationId, file.path)}
            name={file.name}
            buttonVariant="default"
            buttonSize="default"
            className="h-11 w-full rounded-xl"
            iconClassName="size-4"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectMarkdownDialog({
  projectId,
  path,
  onClose,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: true });

  useEffect(() => {
    let stop = false;
    setState({ loading: true });
    void api
      .fileRead(`project:${projectId}`, path)
      .then((result) => {
        if (!stop) setState({ loading: false, content: result.content });
      })
      .catch((error: Error) => {
        if (!stop) setState({ loading: false, error: error.message });
      });
    return () => {
      stop = true;
    };
  }, [path, projectId]);

  const name = path.split('/').pop() || path;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{name}</DialogTitle>
          <DialogDescription className="truncate">Rendered Markdown preview · {path}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border bg-card">
          {state.loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>
          ) : state.error ? (
            <p className="p-4 text-sm text-destructive">Couldn&apos;t load this Markdown file: {state.error}</p>
          ) : state.content === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">No Markdown preview is available.</p>
          ) : (
            <MarkdownFilePreview content={state.content} imageBaseUrl={api.projectFileMarkdownImageUrl(projectId, path, '')} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const APPROVAL_OUTCOME_LABELS = {
  pending: 'Approval needed',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Timed out — automatically declined',
} as const;

function ApprovalCard({ item }: { item: Extract<ChatItem, { kind: 'approval' }> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = (outcome: 'approved' | 'denied') => {
    if (item.approvalId === null || busy) return;
    setBusy(true);
    setError(null);
    // On success the WS approval_resolved event flips item.status; keep busy
    // until then so the buttons can't double-fire.
    api.resolveApproval(item.approvalId, outcome).catch((err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };

  const pending = item.status === 'pending';
  return (
    <Message>
      <MessageContent>
        <Bubble variant="outline" className="w-full max-w-full">
          <BubbleContent className={`w-full space-y-2 px-4 py-3 ${pending ? 'border-amber-500/60' : ''}`}>
            <p className="text-sm font-medium">{pending ? 'Approval needed' : APPROVAL_OUTCOME_LABELS[item.status]}</p>
            <p className="text-sm text-muted-foreground">{item.displayName}</p>
            {item.inputPreview ? (
              <p className="overflow-x-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                {item.inputPreview}
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {pending ? (
              <div className="flex gap-2 pt-1">
                <Button size="lg" disabled={busy || item.approvalId === null} onPointerUp={() => resolve('approved')}>
                  Approve
                </Button>
                <Button
                  size="lg"
                  variant="destructive"
                  disabled={busy || item.approvalId === null}
                  onPointerUp={() => resolve('denied')}
                >
                  Deny
                </Button>
              </div>
            ) : null}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
