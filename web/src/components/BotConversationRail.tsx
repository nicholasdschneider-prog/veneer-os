import { useChatOrganization, OrganizationEditor } from "./ChatOrganization";
import { isPeopleConversation } from "@/lib/teamRooms";
import { ChatUnread } from "./ChatUnread";
import { NewGroupChat } from "./NewGroupChat";
import { GroupConversationRow } from "./GroupConversationRow";
import { useBotGroups, mergeBotGroups, botSections } from "@/lib/botGroups";
import { api } from "@/lib/api";
import { BusinessSelector, useBusinessSelection } from "./BusinessSelector";
import type { BusinessTeam } from "@/lib/bots";
import { useEffect, useState } from "react";
import { botsApi, type Bot } from "@/lib/bots";
import { BotAvatar } from "./BotIdentity";
import { cn } from "@/lib/utils";
import { Hand, Users, Bot as BotIcon, ChevronDown } from "lucide-react";
import { BotActions, BOT_PREFERENCES_CHANGED } from "./BotActions";

export function BotConversationRail({
  selectedId,
  selectedGroup,
  restricted = false,
  onNavigate,
}: {
  selectedId?: string | null;
  selectedGroup?: string;
  restricted?: boolean;
  onNavigate: (hash: string) => void;
}) {
  const { business: savedBusiness, select } = useBusinessSelection();
  const business = restricted ? "" : savedBusiness;
  const organization = useChatOrganization(business);
  const [teams, setTeams] = useState<BusinessTeam[]>([]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void api
      .conversation(selectedId)
      .then((r) => {
        if (active && r.conversation.businessTeamId)
          select(r.conversation.businessTeamId);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [selectedId]);
  const [bots, setBots] = useState<Bot[]>([]);
  const { groups, error: groupError } = useBotGroups(business, restricted);
  const [query, setQuery] = useState("");
  const [draggingBot, setDraggingBot] = useState(false),
    [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("chats:sections") || "{}");
    } catch {
      return {};
    }
  });
  const toggle = (section: string) =>
    setCollapsed((old) => {
      const next = { ...old, [section]: !old[section] };
      try {
        localStorage.setItem("chats:sections", JSON.stringify(next));
      } catch {
        /* Storage may be unavailable. */
      }
      return next;
    });
  const people = groups.filter(isPeopleConversation);
  const botGroups = groups.filter((g) => !isPeopleConversation(g));
  const peopleUnread = people.filter((g) => g.unread > 0).length;
  const botUnread =
    bots.filter((b) => b.unread).length +
    botGroups.filter((g) => g.unread > 0).length;
  const pendingQuestions = bots.reduce((sum, bot) => sum + bot.questions, 0);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void botsApi
        .list("all", business)
        .then((result) => {
          if (active) {
            setBots(result.bots);
            setTeams(result.teams ?? []);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Could not refresh bots");
        });
    refresh();
    window.addEventListener(BOT_PREFERENCES_CHANGED, refresh);
    const timer = setInterval(() => {
      refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, refresh);
    };
  }, [business]);
  const entries = mergeBotGroups(bots, botGroups, query);
  const sections = organization.data
    ? [
        ...organization.data.groups.map((g) => ({
          id: g.id,
          name: g.name,
          entries: entries.filter(
            (e) =>
              e.kind === "bot" &&
              organization.data!.placements[e.bot.conversation_id] === g.id,
          ),
        })),
        {
          id: "",
          name: organization.data.fallback,
          entries: entries.filter(
            (e) =>
              e.kind !== "bot" ||
              !organization.data!.placements[e.bot.conversation_id],
          ),
        },
      ]
    : botSections(entries).map((s) => ({ ...s, id: s.name }));
  return (
    <aside
      aria-label="Chats"
      className="flex h-full min-h-0 flex-col border-r bg-card"
    >
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between">
          <button
            className="text-lg font-semibold hover:underline"
            onClick={() => onNavigate("#/bots")}
            title="All chats"
          >
            Chats
          </button>
          <NewGroupChat business={business} onNavigate={onNavigate} />
        </div>
        {!restricted && (
          <BusinessSelector
            compact
            teams={teams}
            business={business}
            onSelect={(id) => {
              select(id);
              onNavigate("#/bots");
            }}
          />
        )}
        <input
          aria-label="Find a person, bot, or group"
          placeholder="Find a person, bot, or group…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
        />
        {!restricted && teams.length === 0 && (
          <button
            className="text-sm text-primary underline"
            onClick={() => onNavigate("#/bots?register=1")}
          >
            Register an existing chat
          </button>
        )}
      </div>
      {(error || groupError) && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error || groupError}
        </p>
      )}
      <nav
        aria-label="Conversations"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        <button
          className="flex min-h-12 w-full items-center gap-2 px-3 text-sm font-medium text-muted-foreground"
          aria-expanded={!collapsed.people || !!query}
          onClick={() => toggle("people")}
        >
          <Users className="size-4 text-blue-600 dark:text-blue-300" /> People
          <ChevronDown
            className={cn("size-4", collapsed.people && !query && "-rotate-90")}
          />
          <span className="ml-auto">
            <ChatUnread people={peopleUnread} bots={0} />
          </span>
        </button>
        {(!collapsed.people || query) && (
          <div>
            {mergeBotGroups([], people, query).map(
              (entry) =>
                entry.kind !== "bot" && (
                  <GroupConversationRow
                    key={entry.id}
                    group={entry}
                    selected={selectedGroup === "room:" + entry.id}
                    onNavigate={onNavigate}
                  />
                ),
            )}
            {!people.length && (
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                Use + to start a chat with a teammate.
              </p>
            )}
          </div>
        )}
        <button
          className="mt-3 flex min-h-12 w-full items-center gap-2 px-3 text-sm font-medium text-muted-foreground"
          aria-expanded={!collapsed.bots || !!query}
          onClick={() => toggle("bots")}
        >
          <BotIcon className="size-4 text-violet-600 dark:text-violet-300" />{" "}
          Bots
          <ChevronDown
            className={cn("size-4", collapsed.bots && !query && "-rotate-90")}
          />
          <span className="ml-auto">
            <ChatUnread people={0} bots={botUnread} />
          </span>
        </button>
        {(!collapsed.bots || query) && (
          <div>
            <OrganizationEditor organization={organization} bots={bots} />
            {organization.error && (
              <p role="alert" className="px-3 text-xs text-destructive">
                {organization.error}
              </p>
            )}
            {sections.map((section) => (
              <div
                key={section.id}
                data-chat-group={section.id}
                className={cn(
                  "min-h-[44px] rounded-xl",
                  dropTarget === section.id &&
                    "bg-primary/10 ring-2 ring-primary",
                )}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setDropTarget(null);
                }}
                onDragOver={(e) => {
                  if (
                    organization.data &&
                    !organization.busy &&
                    e.dataTransfer.types.includes("application/veneer-bot")
                  ) {
                    e.preventDefault();
                    setDropTarget(section.id);
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDraggingBot(false);
                  setDropTarget(null);
                  const id = e.dataTransfer.getData("application/veneer-bot");
                  if (
                    organization.data &&
                    bots.some((b) => b.conversation_id === id)
                  )
                    void organization.save({
                      ...organization.data,
                      placements: {
                        ...organization.data.placements,
                        [id]: section.id,
                      },
                    });
                }}
              >
                {section.id === "" && section.name === null && draggingBot && (
                  <div className="min-h-[44px] rounded-xl border border-dashed p-3 text-sm">
                    Drop here for no group
                  </div>
                )}
                {section.name !== null && (
                  <button
                    className="flex min-h-[44px] w-full items-center gap-2 px-3 text-sm text-muted-foreground"
                    aria-expanded={!collapsed["bot:" + section.name] || !!query}
                    onClick={() => toggle("bot:" + section.name)}
                  >
                    {section.name}
                    <ChevronDown
                      className={cn(
                        "size-4",
                        collapsed["bot:" + section.name] &&
                          !query &&
                          "-rotate-90",
                      )}
                    />
                    <span className="ml-auto">
                      <ChatUnread
                        people={0}
                        bots={
                          section.entries.filter((e) =>
                            e.kind === "bot" ? e.bot.unread : e.unread > 0,
                          ).length
                        }
                      />
                    </span>
                  </button>
                )}
                {(!collapsed["bot:" + section.name] ||
                  query ||
                  section.name === null) &&
                  section.entries.map((entry) => {
                    if (entry.kind !== "bot")
                      return (
                        <GroupConversationRow
                          key={entry.kind + entry.id}
                          group={entry}
                          selected={
                            selectedGroup === entry.kind + ":" + entry.id
                          }
                          onNavigate={onNavigate}
                        />
                      );
                    const bot = entry.bot;
                    return (
                      <BotActions
                        key={bot.conversation_id}
                        bot={bot}
                        organization={organization}
                        onMarkedUnread={() => {
                          if (selectedId === bot.conversation_id)
                            onNavigate("#/bots");
                        }}
                      >
                        <button
                          key={bot.conversation_id}
                          draggable={!!organization.data && !organization.busy}
                          onDragEnd={() => {
                            setDraggingBot(false);
                            setDropTarget(null);
                          }}
                          onDragStart={(e) => {
                            setDraggingBot(true);
                            e.dataTransfer.setData(
                              "application/veneer-bot",
                              bot.conversation_id,
                            );
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          aria-current={
                            selectedId === bot.conversation_id
                              ? "page"
                              : undefined
                          }
                          onClick={() =>
                            onNavigate(
                              `#/chat/${bot.conversation_id}?from=bots`,
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                            selectedId === bot.conversation_id && "bg-muted",
                          )}
                        >
                          <span className="[&>svg]:size-8">
                            <BotAvatar
                              id={bot.conversation_id}
                              name={bot.name}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {bot.name}
                                {bot.title && (
                                  <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                                    {bot.title}
                                  </span>
                                )}
                              </span>
                              {bot.unread && (
                                <span
                                  aria-label="Unread messages"
                                  className="size-2 shrink-0 rounded-full bg-primary"
                                />
                              )}
                            </span>
                            <span
                              className="block truncate text-xs text-muted-foreground"
                              title={bot.last_reply?.text}
                            >
                              {bot.last_reply?.text || "No indexed reply yet"}
                            </span>
                            {bot.questions > 0 && (
                              <span className="block truncate text-[10px] text-amber-600 dark:text-amber-300">
                                {bot.questions} needs input
                              </span>
                            )}
                          </span>
                        </button>
                      </BotActions>
                    );
                  })}
              </div>
            ))}
            {!bots.length && !groups.length && !error && (
              <p className="p-3 text-sm text-muted-foreground">
                {restricted
                  ? "No bots have been assigned to your account yet."
                  : "Register an existing chat to add your operational bots here."}
              </p>
            )}
          </div>
        )}
        {/* The overview is where questions, follow-through and history live.
            Once a bot is open it is the only way back, so it gets a real row. */}
        <button
          aria-current={undefined}
          onClick={() => onNavigate("#/bots?view=work")}
          className={cn(
            "mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
            <Hand className="size-5 text-amber-600 dark:text-amber-300" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Bot work overview</span>
            <span className="block text-xs text-muted-foreground">
              Questions, follow-through, history
            </span>
          </span>
          {pendingQuestions > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-black tabular-nums">
              {pendingQuestions}
            </span>
          )}
        </button>
      </nav>
    </aside>
  );
}
