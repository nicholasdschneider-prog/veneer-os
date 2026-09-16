import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Link2, Plus } from 'lucide-react';
import {
  skillsApi,
  groupByName,
  mergeProviders,
  type AggregatedSkill,
  type SkillMeta,
  type SkillsList,
} from '../lib/skills';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProviderBadges, IssueBadge } from '../components/skills/badges';
import { SkillPage } from '../components/skills/SkillPage';

const EMPTY_TEXT =
  'No skills yet. A skill is a step-by-step playbook your assistant follows when it fits the task. It works for Claude, Codex, and Grok. Tap “New skill” and an assistant will help you set one up.';

export function SkillsScreen({
  role,
  onBack,
  onNavigate,
  onToast,
  embedded = false,
}: {
  role: string;
  onBack: () => void;
  onNavigate: (hash: string) => void;
  onToast: (message: string) => void;
  embedded?: boolean;
}) {
  const [data, setData] = useState<SkillsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ name: string } | null>(null);
  const [showBuiltins, setShowBuiltins] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const isAdmin = role !== 'member';

  const load = useCallback(() => {
    setError(null);
    skillsApi
      .list()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const aggregated: AggregatedSkill[] = data ? groupByName(data) : [];

  // Scope id -> human label ("project:<id>" -> project name), from the same list payload.
  const scopeLabels = new Map<string, string>((data?.scopes ?? []).map((g) => [g.scope, g.label]));
  const globalSkills = aggregated.filter((a) => a.global);
  const workspaceSkills = aggregated.filter((a) => !a.global);

  if (detail) {
    const agg = aggregated.find((a) => a.name === detail.name);
    if (agg) {
      return (
        <SkillPage
          name={agg.name}
          groups={data?.scopes ?? []}
          initialPlacements={agg.placements}
          role={role}
          onClose={(changed) => {
            setDetail(null);
            if (changed) load();
          }}
          onToast={onToast}
        />
      );
    }
    // The skill vanished (e.g. deleted elsewhere) — fall back to the list.
    setDetail(null);
  }

  // "New skill" hands the user to a dedicated Skill Builder chat.
  const newSkill = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      const { assistants } = await api.assistants();
      const hasSkillBuilder = assistants.some((assistant) => assistant.slug === 'skill-smith');
      const fallbackAgent = assistants.find((assistant) => !assistant.adminOnly);
      const launchAgent = hasSkillBuilder ? { slug: 'skill-smith', name: 'Skill Builder' } : fallbackAgent;
      if (!launchAgent) throw new Error('No regular agent is available for guided skill setup.');
      const { conversation } = await api.createConversation(
        hasSkillBuilder
          ? 'I want to set up a new skill. Interview me briefly, then create it with the skill tools.'
          : 'The dedicated Skill Builder agent has been removed. Help me set up a new skill: interview me briefly, then use the skill tools to create it.',
        { assistantSlug: launchAgent.slug },
      );
      if (!hasSkillBuilder) onToast(`Skill Builder is unavailable; using ${launchAgent.name} instead.`);
      onNavigate(`#/chat/${conversation.id}`);
    } catch (e) {
      setCreateErr((e as Error).message);
      setCreating(false);
    }
  };

  const openSkill = (a: AggregatedSkill) => setDetail({ name: a.name });

  return (
    <div className={embedded ? 'flex flex-col' : 'mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]'}>
      {!embedded ? (
        <header className="flex items-center gap-2 border-b px-3 py-2.5">
          <Button variant="ghost" size="icon-lg" className="rounded-full" onPointerUp={onBack} aria-label="Back">
            <ChevronLeft className="size-5" />
          </Button>
          <p className="min-w-0 flex-1 truncate font-medium">Skills</p>
          {isAdmin ? (
            <Button className="rounded-xl" onPointerUp={() => void newSkill()} disabled={creating}>
              <Plus />
              {creating ? 'Starting…' : 'New skill'}
            </Button>
          ) : null}
        </header>
      ) : isAdmin ? (
        <div className="mt-4 mb-4 flex justify-end">
          <Button className="rounded-xl" onPointerUp={() => void newSkill()} disabled={creating}>
            <Plus />
            {creating ? 'Starting…' : 'New guided skill'}
          </Button>
        </div>
      ) : null}

      <div
        className={
          embedded
            ? 'space-y-6'
            : 'flex-1 overflow-y-auto px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+2rem)]'
        }
      >
        {error ? (
          <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
        ) : null}
        {createErr ? (
          <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{createErr}</div>
        ) : null}

        {data === null ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <section className="mb-7">
              <div className="mb-2">
                <h2 className="text-lg font-semibold">Skills</h2>
                <p className="text-sm text-muted-foreground">
                  Playbooks your assistants follow. Open one to see where it’s active.
                </p>
              </div>
              {aggregated.length === 0 ? (
                <Empty text={EMPTY_TEXT} />
              ) : (
                <div className="flex flex-col">
                  {globalSkills.length ? (
                    <>
                      <GroupHeader label="Global" count={globalSkills.length} />
                      {globalSkills.map((a) => (
                        <SkillRow
                          key={a.name}
                          skill={a}
                          scopeLabels={scopeLabels}
                          onOpen={() => openSkill(a)}
                          onNavigate={onNavigate}
                        />
                      ))}
                    </>
                  ) : null}
                  {workspaceSkills.length ? (
                    <>
                      <GroupHeader label="Workspace" count={workspaceSkills.length} />
                      {workspaceSkills.map((a) => (
                        <SkillRow
                          key={a.name}
                          skill={a}
                          scopeLabels={scopeLabels}
                          onOpen={() => openSkill(a)}
                          onNavigate={onNavigate}
                        />
                      ))}
                    </>
                  ) : null}
                </div>
              )}
            </section>

            {data.builtins.length ? (
              <section className="mb-7">
                <button
                  type="button"
                  onPointerUp={() => setShowBuiltins((v) => !v)}
                  className="mb-2 flex w-full items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={`size-4 text-muted-foreground transition-transform ${showBuiltins ? 'rotate-90' : ''}`}
                  />
                  <div>
                    <h2 className="text-lg font-semibold">Built-in Codex skills</h2>
                    <p className="text-sm text-muted-foreground">Read-only skills that ship with Codex.</p>
                  </div>
                </button>
                {showBuiltins ? (
                  <div className="flex flex-col gap-2">
                    {data.builtins.map((s) => (
                      <BuiltinRow key={s.name} skill={s} />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function trailingTag(a: AggregatedSkill): string | null {
  if (a.placements.every((p) => p.readOnly)) return 'read-only';
  return null;
}

/** Section header: "GLOBAL · 2 ────────" */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1 mt-4 flex items-center gap-2.5 first:mt-0">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        {label} · {count}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const PROJECT_CHIP =
  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none ring-1 ring-amber-600/40 bg-amber-500/5 text-amber-700 dark:text-amber-300/90';

/**
 * The gold placement chip: one project shows its name and opens it; several
 * show a count that drops down the full list. Global skills get a muted
 * "All projects" chip. Clicks never bubble into the row's open-detail.
 */
function ProjectChip({
  skill,
  scopeLabels,
  onNavigate,
}: {
  skill: AggregatedSkill;
  scopeLabels: Map<string, string>;
  onNavigate: (hash: string) => void;
}) {
  if (skill.global) {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
        All projects
      </span>
    );
  }
  const projects = skill.placements
    .filter((p) => p.scope.startsWith('project:'))
    .map((p) => ({ scope: p.scope, label: scopeLabels.get(p.scope) ?? p.scope.slice('project:'.length) }));
  if (projects.length === 0) {
    if (skill.placements.some((p) => p.scope === 'source')) {
      return (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          Platform
        </span>
      );
    }
    return null;
  }
  const openProject = (scope: string) => onNavigate(`#/project/${scope.slice('project:'.length)}`);
  const only = projects.length === 1 ? projects[0] : undefined;
  if (only) {
    return (
      <button
        type="button"
        className={`${PROJECT_CHIP} max-w-24 truncate hover:bg-amber-500/15 sm:max-w-40`}
        onPointerUp={(e) => {
          e.stopPropagation();
          openProject(only.scope);
        }}
      >
        {only.label}
      </button>
    );
  }
  return (
    <span onPointerUp={(e) => e.stopPropagation()} className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={`${PROJECT_CHIP} hover:bg-amber-500/15`}>
            {projects.length} projects ▾
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {projects.map((p) => (
            <DropdownMenuItem key={p.scope} onSelect={() => openProject(p.scope)}>
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function SkillRow({
  skill,
  scopeLabels,
  onOpen,
  onNavigate,
}: {
  skill: AggregatedSkill;
  scopeLabels: Map<string, string>;
  onOpen: () => void;
  onNavigate: (hash: string) => void;
}) {
  const tag = trailingTag(skill);
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerUp={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent/50 active:bg-accent"
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${skill.enabledAnywhere ? 'bg-brand' : 'bg-muted-foreground/30'}`}
      />
      <span className="max-w-[45%] shrink-0 truncate text-sm font-medium sm:max-w-[55%]">{skill.name}</span>
      {skill.description ? (
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
          {skill.description}
        </span>
      ) : null}
      <span className={`min-w-0 flex-1 ${skill.description ? 'sm:hidden' : ''}`} />
      {skill.placements.some((placement) => placement.entryKind === 'link') ? (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-1 text-xs font-medium text-muted-foreground"
          title="One or more placements link to an original stored elsewhere."
        >
          <Link2 className="size-4 h-lh shrink-0" />
          Linked
        </span>
      ) : null}
      <ProjectChip skill={skill} scopeLabels={scopeLabels} onNavigate={onNavigate} />
      <ProviderBadges providers={mergeProviders(skill.placements)} />
      <IssueBadge count={skill.issues.length} />
      {tag ? (
        <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>
      ) : (
        <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
      )}
    </div>
  );
}

function BuiltinRow({ skill }: { skill: SkillMeta }) {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{skill.name}</p>
        {skill.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{skill.description}</p>
        ) : null}
      </div>
      <ProviderBadges providers={skill.providers} />
      <span className="shrink-0 text-xs text-muted-foreground">Built-in</span>
    </div>
  );
}
