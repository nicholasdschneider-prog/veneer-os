import { useEffect, useState } from 'react';
import { ChevronLeft, Pencil, Plug, Plus, SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import type { BuildQueueJob, Conversation, Project } from '../lib/types';
import { Button } from '@/components/ui/button';
import { ConversationList, getConversationListPagination } from '../components/ConversationList';
import { EditProjectDialog } from '../components/EditProjectDialog';
import { BuildQueue } from '../components/BuildQueue';

export function ProjectView({
  projectId,
  role,
  selectedId = null,
  onOpen,
  onNewChat,
  onOpenTerminal,
  onManageConnectors,
  onBack,
  onDeleted,
  onToast,
}: {
  projectId: string;
  role: string;
  selectedId?: string | null;
  onOpen: (chatId: string) => void;
  onNewChat: (projectId: string) => void;
  onOpenTerminal: (projectId: string) => void;
  onManageConnectors: (projectId: string) => void;
  onBack: () => void;
  onDeleted: (name: string) => void;
  onToast: (message: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [buildJobs, setBuildJobs] = useState<BuildQueueJob[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const canManage = role === 'owner' || role === 'consultant';

  useEffect(() => {
    let stop = false;
    setProject(null);
    setNotFound(false);
    setShowAllChats(false);
    const load = () => {
      void api.project(projectId).then((r) => {
        if (!stop) setProject(r.project);
      }).catch(() => {
        if (!stop) setNotFound(true);
      });
      void api.conversations(false, projectId).then((r) => {
        if (!stop) setConversations(r.conversations);
      }).catch(() => undefined);
      void api.buildQueue().then((r) => {
        if (!stop) setBuildJobs(r.jobs);
      }).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [projectId]);

  const projectJobs = buildJobs.filter((job) => job.projectId === projectId);
  const queuedIds = new Set(buildJobs.map((job) => job.conversationId));
  const listedConversations = conversations?.filter((conversation) => !conversation.isBot && !queuedIds.has(conversation.id)) ?? null;
  const pagination = listedConversations === null
    ? null
    : getConversationListPagination(listedConversations, selectedId, 'created');
  const selectedChatIsOlder =
    pagination !== null && pagination.selectedTopLevelIndex >= 10;

  if (notFound) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-lg font-medium">Project not found</p>
        <Button className="h-11 rounded-xl px-5" onPointerUp={onBack}>
          Back to Chats
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon-lg" className="rounded-full" onPointerUp={onBack} aria-label="Back">
          <ChevronLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{project?.name ?? 'Project'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {project ? (project.chatCount === 0 ? 'No chats yet' : `${project.chatCount} ${project.chatCount === 1 ? 'chat' : 'chats'}`) : ' '}
          </p>
        </div>
        {canManage ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full text-muted-foreground"
            onPointerUp={() => onOpenTerminal(projectId)}
            aria-label="Terminal"
          >
            <SquareTerminal className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-lg"
          className="rounded-full text-muted-foreground"
          onPointerUp={() => setEditOpen(true)}
          aria-label="Project settings"
          disabled={!project}
        >
          <Pencil className="size-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="px-1 py-3">
          <Button className="h-11 w-full justify-center gap-2 rounded-xl" onPointerUp={() => onNewChat(projectId)}>
            <Plus className="size-5" /> New chat in this project
          </Button>
          <Button
            variant="outline"
            className="mt-2 h-11 w-full justify-center gap-2 rounded-xl"
            onPointerUp={() => onManageConnectors(projectId)}
          >
            <Plug className="size-4" /> Manage project connectors
          </Button>
        </div>

        {project && project.instructions.trim() ? (
          <div className="mb-1 rounded-xl border bg-card px-3.5 py-3">
            <p className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Context</p>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{project.instructions.trim()}</p>
          </div>
        ) : null}

        {conversations === null ? (
          <p className="px-2 py-8 text-center text-muted-foreground">Loading…</p>
        ) : (
          <ConversationList
            conversations={listedConversations ?? []}
            flat
            orderBy="created"
            maxTopLevel={showAllChats || selectedChatIsOlder ? undefined : 10}
            onOpen={onOpen}
            selectedId={selectedId}
            onToast={onToast}
            onRemoved={(id) => setConversations((prev) => prev?.filter((c) => c.id !== id) ?? prev)}
            onChanged={setConversations}
            emptyState={projectJobs.length ? null : (
              <div className="px-2 py-12 text-center">
                <p className="font-medium">No chats in this project yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Start one — it'll run in this project's folder.</p>
              </div>
            )}
          />
        )}
        {pagination && pagination.topLevelCount > 10 && !selectedChatIsOlder ? (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full px-4 text-brand"
              onPointerUp={() => setShowAllChats((current) => !current)}
            >
              {showAllChats ? 'Show recent 10' : `View all ${pagination.topLevelCount} chats`}
            </Button>
          </div>
        ) : null}
        <BuildQueue
          jobs={projectJobs}
          selectedId={selectedId}
          onOpen={(conversationId) => onOpen(conversationId)}
          onRemoved={(jobId) => setBuildJobs((jobs) => jobs.filter((job) => job.id !== jobId))}
        />
      </div>

      {project ? (
        <EditProjectDialog
          open={editOpen}
          project={project}
          canDelete={canManage}
          onOpenChange={setEditOpen}
          onSaved={(p) => {
            setProject(p);
            setEditOpen(false);
          }}
          onDeleted={() => {
            setEditOpen(false);
            onDeleted(project.name);
          }}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
