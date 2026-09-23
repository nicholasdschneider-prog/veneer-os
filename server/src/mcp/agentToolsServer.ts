import { ROOM_TOOL_DEFINITIONS, callRoomTool } from './roomTools.js';
import { BOT_TOOL_DEFINITIONS, callBotTool } from './botTools.js';
import { HUDDLE_TOOL_DEFINITIONS, callHuddleTool } from './huddleTools.js';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULT_SCHEDULE_TIME_ZONE } from '../scheduled/schedule.js';
import { resolveCurrentAgentToken } from '../runtime/agentTokenFile.js';
import {
  callConversationDiscoveryTool,
  CONVERSATION_DISCOVERY_TOOL_DEFINITIONS,
} from './conversationDiscoveryTools.js';
import { summarizeConversation } from './conversationSummary.js';
import { callProjectTool, PROJECT_TOOL_DEFINITIONS } from './projectTools.js';
import { callProjectSettingsTool, PROJECT_SETTINGS_TOOL } from './projectSettingsTool.js';
import { callRenameConversationTool, RENAME_CONVERSATION_TOOL } from './renameConversationTool.js';
import { callChatLinkTool, CHAT_LINK_TOOL } from './chatLinkTool.js';
import { callTodoTool, TODO_TOOL_DEFINITIONS } from './todoTools.js';
import { callGmailDraftTool, GMAIL_DRAFT_TOOL } from './gmailDraftTools.js';

/**
 * Built-in MCP server: gives every agent native Veneer operations such as
 * project management, cross-chat coordination, Todos, and publishing.
 * Hand-rolled JSON-RPC-over-stdio
 * (same NDJSON style as the Claude wire protocol in providers/claude/wire.ts)
 * rather than pulling in the MCP SDK, so the wire shape stays small and
 * predictable.
 *
 * This process has no direct DB/runtime access — it forwards to the already-
 * authorized REST API over loopback, authenticating as the conversation's
 * owner via a short-lived token (server/src/runtime/agentTokens.ts). That
 * means every existing isolation rule (member/owner/consultant scoping)
 * applies with no new authorization logic here.
 */

const token = process.env.VP_AGENT_TOKEN ?? '';
const baseUrl = process.env.VP_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3100';
// The chat this spawn belongs to — ask_user surfaces its question here. Empty
// during the boot seed spawn (no live conversation), where ask_user is unusable.
const spawnConversationId = process.env.VP_CONVERSATION_ID ?? '';
const tokenFile = process.env.VP_AGENT_TOKEN_FILE ?? '';
// Set by toolbox/materialize.ts when the turn actor is a member (Doppler is an
// administrator surface) or when no authenticated Doppler CLI exists on this
// machine. Either way request_secret and reveal_secret cannot complete, so they
// are omitted from tools/list and refused if a cached list still names them.
const secretToolsDisabled = process.env.VP_SECRET_TOOLS_DISABLED === '1';
const SECRET_TOOL_NAMES = new Set(['request_secret', 'reveal_secret']);
const SECRET_TOOLS_UNAVAILABLE =
  'Secrets tooling is not available in this chat: either Doppler is not connected on this machine, or your account does not have Doppler access. Ask the user to connect Doppler in Settings, or to have an administrator run this. Never ask them to paste a secret into chat.';
// Host published pages are served from (config.pages.publicBase, forwarded by
// toolbox/materialize.ts). Empty when page publishing is not configured, in
// which case the publish_page description stays generic instead of naming a
// host this installation does not own.
const pagesPublicHost = (() => {
  const base = process.env.VP_PAGES_PUBLIC_BASE ?? '';
  if (!base) return '';
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
})();
// Page HTML size cap, mirrored from the /api/pages route (2 MiB).
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
// Portable Mini App module cap, mirrored from /api/apps.
const MAX_APP_BYTES = 1024 * 1024;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Shared domain facts for the skill tool descriptions. A skill is a reusable,
// step-by-step playbook an assistant follows when a task fits it. ONE authored
// skill works for Claude, Codex, and Grok automatically — there is nothing
// provider-specific to do. Scope key grammar (verbatim, from list_skills):
//   global          — reaches every chat (both providers, everywhere)
//   source          — the platform's own source checkout (admins)
//   project:<id>    — only chats in that one project's folder
// Skill names are lowercase letters, numbers and hyphens (e.g. "run-tests").
const SCOPE_GRAMMAR =
  'Scope key grammar: "global" (every chat), "source" (platform source), or "project:<id>" (only that project\'s chats) — use the exact scope keys from list_skills. Names are lowercase letters, numbers and hyphens. One skill works for Claude, Codex, and Grok automatically.';

const TOOLS: ToolDef[] = [
  CHAT_LINK_TOOL,
  PROJECT_SETTINGS_TOOL,
  ...PROJECT_TOOL_DEFINITIONS,
  ...CONVERSATION_DISCOVERY_TOOL_DEFINITIONS,
  ...BOT_TOOL_DEFINITIONS,
  ...HUDDLE_TOOL_DEFINITIONS,
  ...ROOM_TOOL_DEFINITIONS,
  ...TODO_TOOL_DEFINITIONS,
  GMAIL_DRAFT_TOOL,
  {
    name: 'list_skills',
    description: `List every skill placement across all scopes: name, scope key, original/link relationship, enabled/off, per-provider state, and any issues. ${SCOPE_GRAMMAR} Call this first to learn which scopes/projects exist and their exact keys before using the other skill tools.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_skill',
    description: `Read one skill: its description, scope, provider state, issues, and full SKILL.md content. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope key, e.g. "global" or "project:abc123".' },
        name: { type: 'string', description: 'The skill name (its directory / slash-command name).' },
      },
      required: ['scope', 'name'],
    },
  },
  {
    name: 'create_skill',
    description: `Create a new skill. The body is the SKILL.md content (imperative, step-by-step, with concrete triggers); name and description are stored as frontmatter for you — write a description specific enough that an assistant knows WHEN to use it (max 1024 chars). ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Where to create it: "global", "source", or "project:<id>".' },
        name: { type: 'string', description: 'Lowercase letters, numbers and hyphens. Becomes the /command name.' },
        description: { type: 'string', description: 'When should an assistant use this skill? (required, max 1024 chars)' },
        body: { type: 'string', description: 'The SKILL.md instructions (markdown after the frontmatter).' },
      },
      required: ['scope', 'name', 'description', 'body'],
    },
  },
  {
    name: 'update_skill',
    description: `Update an existing skill. Provide description and/or body to edit those fields, OR raw to replace the entire SKILL.md verbatim (repair path) — not both. There is no version check: always read_skill first and edit from the freshest content. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The skill\'s scope key.' },
        name: { type: 'string', description: 'The skill name.' },
        description: { type: 'string', description: 'New description (optional; not with raw).' },
        body: { type: 'string', description: 'New instructions body (optional; not with raw).' },
        raw: { type: 'string', description: 'Full SKILL.md verbatim (optional; not with description/body).' },
      },
      required: ['scope', 'name'],
    },
  },
  {
    name: 'move_skill',
    description: `Move a skill's single canonical folder from one scope to another (e.g. make a project skill global). Use this for "make global" — it never leaves a copy behind. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The skill\'s current scope key.' },
        name: { type: 'string', description: 'The skill name.' },
        toScope: { type: 'string', description: 'The destination scope key (must differ from scope).' },
      },
      required: ['scope', 'name', 'toScope'],
    },
  },
  {
    name: 'copy_skill',
    description: `Copy a skill's whole folder into another scope (an intentional fork — e.g. add a global skill to one project). Both copies then exist independently. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The source scope key.' },
        name: { type: 'string', description: 'The skill name.' },
        toScope: { type: 'string', description: 'The destination scope key (must differ from scope).' },
      },
      required: ['scope', 'name', 'toScope'],
    },
  },
  {
    name: 'sync_skill',
    description: `Fix a skill so it works for both providers: adopts a Claude-only skill into the shared location, repairs a broken link, and injects any missing name/description frontmatter. Idempotent. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The skill\'s scope key.' },
        name: { type: 'string', description: 'The skill name.' },
      },
      required: ['scope', 'name'],
    },
  },
  {
    name: 'delete_skill',
    description: `Remove one skill placement. A linked placement removes only its link and keeps the original safe. An original cannot be deleted while other placements link to it. Deleting an unlinked original removes its folder and files and is irreversible — CONFIRM with the user in chat before calling. ${SCOPE_GRAMMAR}`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'The skill\'s scope key.' },
        name: { type: 'string', description: 'The skill name.' },
      },
      required: ['scope', 'name'],
    },
  },
  {
    name: 'read_conversation',
    description:
      "Check another of the user's chats: its title, agent, status (working/idle/needs_you/failed), and recent messages.",
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'The chat id.' },
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'send_message',
    description:
      "Send guidance into another of the user's chats. A working chat is steered live — the agent reads the message inside its current turn — and an idle one starts a new turn. The reply states how the message was delivered. This does not wait for a response.",
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'The chat id.' },
        text: { type: 'string', description: 'The message to send.' },
        interrupt: {
          type: 'boolean',
          description:
            "Stop the chat's current turn so this message runs immediately. Discards that turn's in-progress work; use only when the user asked for it or the chat appears hung.",
        },
      },
      required: ['conversationId', 'text'],
    },
  },
  RENAME_CONVERSATION_TOOL,
  {
    name: 'save_memory',
    description:
      'Save a durable fact about the user, their preferences, or a project decision in shared memory. Use this especially when the user says “remember this”. NEVER store secrets, API keys, passwords, tokens, credentials, or other sensitive authentication data.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The concise durable fact or decision to remember.' },
        project_id: {
          type: 'string',
          description: 'Optional project id when the memory belongs to a specific project; omit for user-wide facts.',
        },
        permanent: {
          type: 'boolean',
          description:
            'Set true ONLY for permanent identity-level facts (name, role, employer, hometown). Leave unset for preferences, decisions, and anything that may evolve — those are kept current automatically.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description:
      'Search the user’s shared memory for durable facts, preferences, and prior project decisions relevant to the current task.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What remembered information to look for.' } },
      required: ['query'],
    },
  },
  {
    name: 'forget_memory',
    description: 'Forget one stored memory by id. Use search_memory first if you do not already have the id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The memory id returned by search_memory.' } },
      required: ['id'],
    },
  },
  {
    name: 'enqueue_build',
    description:
      'Put shared project or platform source work into this workspace\'s durable build queue. Project workspaces have independent queues; only an unfiled Platform Dev chat uses the Veneer Pro source queue. Call this early by default before changing shared files unless the user explicitly says to start immediately, skip the line, or not use the queue. Do not use it for a standalone Veneer page or Mini App because those are isolated published deliverables; if the same request also changes shared files, queue that source work. Unfiled non-Platform-Dev chats cannot queue. Do not use it for purely read-only work. After enqueueing, do not change files or run validation in the current turn; when waiting, use the remainder only for read-only preparation. The queue itself starts a new turn in this chat when the slot is active, so never call `schedule_wakeup`, `schedule_task`, or any other timer to wait for your own build slot.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short recognizable name for the queued build.' },
        brief: {
          type: 'string',
          description: 'Self-contained implementation brief, including requirements and relevant decisions from this chat.',
        },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'list_build_queue',
    description: 'Show active and waiting builds by workspace queue, including failed jobs that pause only their own queue.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_build_queue',
    description:
      'Retry or skip a failed/queued workspace build. You may retry or skip THIS chat\'s own failed or stopped build on your own judgment (for example after list_build_queue shows it blocking the queue). Only touch another chat\'s queue item when the user explicitly asks.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'Numeric job id from enqueue_build or list_build_queue.' },
        action: { type: 'string', enum: ['retry', 'skip'] },
      },
      required: ['job_id', 'action'],
    },
  },
  {
    name: 'handoff',
    description:
      "Hand a task off to a NEW agent: this starts a fresh chat, fires the new agent off to work on its own, and returns the new chat's id. A chat's project folder is fixed, so this is also how to work in a different project: call list_projects, create_project natively if needed, then pass the exact project id to handoff. Never use browser automation to create or select a project. The new agent is told it was handed off from you and given the task as its first message, so the two chats stay traceable. It runs independently and does NOT reply here — afterwards use read_conversation(newChatId) to check its progress or result, or send_message(newChatId, …) to steer it. Leave provider/model/effort/assistant/project unset to use the default agent at its default thinking level. If the user asked for a SPECIFIC engine, model, or agent type, call list_agent_options first to resolve exactly what they meant.",
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: "What the new agent should do — a clear, self-contained instruction. Becomes the new chat's first message.",
        },
        provider: {
          type: 'string',
          enum: ['claude', 'openrouter', 'codex', 'grok'],
          description: "Which engine to run the new agent on. Omit for the default provider.",
        },
        model: {
          type: 'string',
          description: 'A specific model id for that provider (see list_agent_options). Omit for the provider default.',
        },
        effort: {
          type: 'string',
          description: "Reasoning/thinking effort (e.g. 'low', 'medium', 'high' — valid values vary by model; see list_agent_options). Omit for the default.",
        },
        assistant: {
          type: 'string',
          description: "The agent type to start (an assistant slug from list_agent_options, e.g. 'assistant'). Omit for the default assistant.",
        },
        project: {
          type: 'string',
          description:
            'Start the new chat in this project — prefer the exact id from list_projects or create_project. Omit to use the default workspace.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_agent_options',
    description:
      'List providers, models, agent types, and existing project targets for handoff. For project-only discovery use list_projects; if a project does not exist, create it with create_project rather than browser automation. A chat cannot move project folders, so use handoff to start a new chat in the target project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_wakeup',
    description:
      'Persist a one-time wake-up for THIS chat so unfinished work can continue in a new turn after a wait. Use this for monitoring, backoff, or a delayed re-check. Provide exactly one of delay_seconds or run_at. Reusing the same key replaces the prior pending wake with that key, which prevents stale stacked polls. After this succeeds, briefly report the wake time and end the turn. Never use provider-native ScheduleWakeup, Cron*, or Monitor for this purpose.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Concise checkpoint: what is pending and exactly what to check or do after the wake.',
        },
        key: {
          type: 'string',
          description: 'Stable purpose key. Defaults to "default"; reuse it to replace the prior pending wake.',
        },
        delay_seconds: {
          type: 'number',
          description: 'Whole seconds from now, from 1 second through 30 days. Do not provide with run_at.',
        },
        run_at: {
          type: 'string',
          description: 'Future ISO 8601 timestamp with an offset. Do not provide with delay_seconds.',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'list_wakeups',
    description:
      'List wake-ups created by THIS chat, with exact ids, keys, times, reasons, and states. Use before cancelling when the exact wake id is unknown.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_wakeup',
    description:
      'Cancel one pending wake-up for THIS chat by exact wake id. Use list_wakeups first when the id is unknown. Delivered or already-cancelled wakes cannot be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        wakeup_id: { type: 'string', description: 'Exact wake id returned by schedule_wakeup or list_wakeups.' },
      },
      required: ['wakeup_id'],
    },
  },
  {
    name: 'schedule_task',
    description:
      'Create a scheduled agent/automation for the current user. Only call after the user clearly asks for a schedule and the timing is unambiguous; otherwise ask first. The default timezone is America/New_York (Eastern Time). Each occurrence is kept as a run under the persistent automation. Use cron for advanced schedules such as hourly windows or selected days. For repeated checks until work completes, prefer schedule_wakeup in the current chat (it replaces pending wakes by key); if a separate automation is required, create ONE cron automation whose prompt tells the agent to pause the automation (update_scheduled_task, enabled=false) when the work is done. Never chain one-time tasks to simulate a recurring schedule. The result includes the exact task id used by every read, edit, run-history, run-now, and delete tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short recognizable name for the automation.' },
        prompt: { type: 'string', description: 'Complete instructions the agent should execute on every run.' },
        schedule_type: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly', 'cron'] },
        time: { type: 'string', description: 'Local 24-hour HH:MM time; required for recurring schedules.' },
        weekday: { type: 'number', description: 'For weekly only: 0=Sunday through 6=Saturday.' },
        run_at: { type: 'string', description: 'For once only: future ISO 8601 timestamp with an offset.' },
        cron: {
          type: 'string',
          description: 'For cron only: standard five-field cron expression (minute hour day-of-month month day-of-week), for example 0 8-17 * * 1-5.',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone. Defaults to America/New_York (Eastern Time).',
        },
        assistant: {
          type: 'string',
          description: 'Exact agent slug from list_agent_options. Omit to use this chat\'s agent type.',
        },
        provider: {
          type: 'string',
          enum: ['claude', 'openrouter', 'codex', 'grok'],
          description: 'Provider from list_agent_options. Omit to use this chat model.',
        },
        model: {
          type: ['string', 'null'],
          description: 'Model id from list_agent_options. Omit or null for the selected provider default.',
        },
        effort: {
          type: ['string', 'null'],
          description: 'Thinking level supported by the selected model. Null uses the provider default.',
        },
        project_id: {
          type: ['string', 'null'],
          description: 'Exact project id from list_projects, or null for the Automations workspace. Omit to inherit this chat\'s project.',
        },
      },
      required: ['name', 'prompt', 'schedule_type'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description:
      "List the current user's existing scheduled agents/automations with their exact task ids, schedules, prompts, model, workspace, pin, and status. Start here whenever the exact task id is unknown. The id can then be used to read or edit the task, run it now, inspect/delete past runs, or delete the scheduled agent. Never guess between similar matches; ask the user which task they mean.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_scheduled_task',
    description:
      "Inspect one scheduled agent/automation by exact task id, including its full prompt, schedule, timezone, status, model, workspace, pin, and next runs. Use list_scheduled_tasks first if the task id is unknown. Use list_scheduled_task_runs for complete past-run history.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_scheduled_task',
    description:
      "Edit any supported field on one scheduled agent/automation by exact task id: name, complete prompt, schedule, timezone, pause/resume state, pin, workspace project, agent type, provider, model, or thinking level. Only provided fields change; omitted fields are preserved. Use list_scheduled_tasks/read_scheduled_task first and never guess an ambiguous target. To change timing, provide schedule_type plus its complete required timing fields; timezone may change by itself.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
        name: { type: 'string', description: 'New recognizable automation name. Omit to preserve it.' },
        prompt: { type: 'string', description: 'Complete new run instructions. Omit to preserve the current prompt.' },
        schedule_type: {
          type: 'string',
          enum: ['once', 'daily', 'weekdays', 'weekly', 'cron'],
          description: 'Required only when replacing the schedule/timing.',
        },
        time: { type: 'string', description: 'Local 24-hour HH:MM time; required for recurring schedules.' },
        weekday: { type: 'number', description: 'For weekly only: 0=Sunday through 6=Saturday.' },
        run_at: { type: 'string', description: 'For once only: future ISO 8601 timestamp with an offset.' },
        cron: {
          type: 'string',
          description: 'For cron only: complete standard five-field cron expression, for example 0 8-17 * * 1-5.',
        },
        timezone: { type: 'string', description: 'New IANA timezone. Omit to preserve the current timezone.' },
        enabled: { type: 'boolean', description: 'Set false to pause or true to resume. Omit to preserve status.' },
        pinned: { type: 'boolean', description: 'Set true to pin the automation in Chats or false to unpin it.' },
        project_id: {
          type: ['string', 'null'],
          description: 'Exact project id from list_projects, or null for the Automations workspace. Omit to preserve it.',
        },
        assistant: {
          type: 'string',
          description: 'New exact agent slug from list_agent_options. Omit to preserve the current agent type.',
        },
        provider: {
          type: 'string',
          enum: ['claude', 'openrouter', 'codex', 'grok'],
          description: 'New provider from list_agent_options. Omit to preserve the current provider.',
        },
        model: {
          type: ['string', 'null'],
          description: 'New model id from list_agent_options. Null uses the selected provider default; omit to preserve it.',
        },
        effort: {
          type: ['string', 'null'],
          description: 'New thinking level supported by the selected model. Null uses the provider default.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_scheduled_task_runs',
    description:
      "List the complete run history for one of the current user's scheduled agents by exact task id. Returns exact run ids, status, trigger, timestamps, errors, importance, and linked chat ids. Use this before changing or deleting a past run when the run id is unknown.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_scheduled_task_run',
    description:
      "Mark one past run important or not important by exact task id and run id. Important runs also surface in Chats. Use list_scheduled_task_runs first if the run id is unknown.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
        run_id: { type: 'string', description: 'Exact run id returned by list_scheduled_task_runs.' },
        important: { type: 'boolean', description: 'True surfaces the run in Chats; false removes that mark.' },
      },
      required: ['task_id', 'run_id', 'important'],
    },
  },
  {
    name: 'run_scheduled_task_now',
    description:
      "Start one scheduled agent immediately by exact task id without changing its future schedule. Returns the new run id and chat id. Use list_scheduled_tasks first if the task id is unknown.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_scheduled_task_run',
    description:
      "Permanently remove one completed, failed, or skipped run from a scheduled agent's history by exact task id and run id. Its linked run chat is preserved in Archived chats. Active, queued, or needs-you runs cannot be deleted. Only call after the user clearly asks to delete that exact past run; use list_scheduled_task_runs first if the run id is unknown.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
        run_id: { type: 'string', description: 'Exact terminal run id returned by list_scheduled_task_runs.' },
      },
      required: ['task_id', 'run_id'],
    },
  },
  {
    name: 'delete_scheduled_task',
    description:
      "Permanently delete one scheduled agent/automation and all of its run-history records by exact task id. Previous run chats are preserved in Archived chats, and active runs are stopped. Only call after the user clearly asks to delete that exact scheduled agent. Use list_scheduled_tasks first when the id is unknown; never guess an ambiguous target.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Exact task id returned by list_scheduled_tasks.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'publish_page',
    description:
      `Publish a self-contained HTML page to ${pagesPublicHost ? `a live public ${pagesPublicHost} URL` : 'a public page URL'}. This is the default for browser-viewable deliverables, including reports, presentations, dashboards, calculators, forms, games, and pages with client-side interaction. Before designing, read project_settings with no arguments so current appearance is loaded only for this task. Use publish_app only when the user explicitly asks for an app or interactive tool that needs server behavior. Local files and loopback URLs are internal verification only: when the user needs to open, test, use, or share the result, publish it and return the reachable URL. Anyone with the link can view the page until it expires seven days after its latest publish. Pass page_id with updated HTML to keep the URL and renew its lifetime.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title for the page.' },
        html: {
          type: 'string',
          description: 'A complete, self-contained HTML document — inline all CSS and JS (no external files).',
        },
        html_file: {
          type: 'string',
          description: 'Path to an HTML file to publish instead of inline html (resolved relative to the working directory).',
        },
        page_id: { type: 'string', description: 'Update this existing page in place (its URL stays the same).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_pages',
    description: 'List active pages previously published from this Veneer instance (title, URL, page_id, project, expiry).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'publish_app',
    description:
      'Publish or update a private interactive app at this client\'s Cloudflare Access-protected /tools URL. Use this when the user explicitly asks for an app or interactive tool that needs server behavior; browser-viewable deliverables otherwise use publish_page, even when they include client-side interaction. Before designing, read project_settings with no arguments so current appearance is loaded only for this task. If server behavior is required and the user did not ask for an app or interactive tool, ask before changing the output type. A localhost URL is internal verification only, never the link returned for the user to test or share. runtime defaults to "cloudflare"; choose "local" only when the app must execute on this Veneer host or reach local machine resources. Source is a self-contained JavaScript ES module exporting `async function handle(request, context)` with no imports. Pass app_id to update in place.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short app title.' },
        slug: {
          type: 'string',
          description: 'Stable URL slug for a new app: 2–48 lowercase letters, numbers, or hyphens.',
        },
        source: {
          type: 'string',
          description:
            'Self-contained ES module exporting async function handle(request, context) and returning a Response.',
        },
        source_file: {
          type: 'string',
          description: 'Path to a JavaScript module to publish instead of inline source (resolved relative to cwd).',
        },
        app_id: { type: 'string', description: 'Update this existing app in place; slug and URL stay fixed.' },
        runtime: {
          type: 'string',
          enum: ['cloudflare', 'local'],
          description:
            'Deployment target. New apps default to cloudflare. Omit when updating to preserve the existing runtime.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_apps',
    description: 'List the private mini apps published from this Veneer instance, including URL, app_id, and status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a question in THIS chat and wait for their answer, shown as a structured choice card. Use this when you need the user to choose among a small set of specific options before you can continue. Set allowOther only when a short free-form alternative is useful. Never ask for passwords, tokens, API keys, or private keys here; use request_secret for those. This blocks until the user answers or the question times out.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask (plain text).' },
        options: {
          type: 'array',
          description: 'The choices to offer the user (1–20). Each is a short button label.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short button text the user taps.' },
              value: {
                type: 'string',
                description: 'Optional value handed back to you if the user picks this; defaults to the label.',
              },
              description: {
                type: 'string',
                description: 'Optional one-sentence explanation of the choice or its tradeoff.',
              },
            },
            required: ['label'],
          },
        },
        multi: { type: 'boolean', description: 'Allow the user to pick more than one option (default false).' },
        allowOther: { type: 'boolean', description: 'Offer a short free-form Other answer (default false).' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'request_secret',
    description:
      'Ask the user for a secret (API key, token, password, private key) through a secure input card in THIS chat and save it straight to Doppler. You never receive the value; the card shows the user the secret name it will be stored under. Use this instead of ask_user or a chat message whenever you need a credential. Afterwards read the secret at use time through Doppler like any other secret; never ask the user to paste it in chat and never print it. Blocks until the user saves, dismisses, or the request times out.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Doppler secret name in SCREAMING_SNAKE_CASE, for example STRIPE_API_KEY.',
        },
        purpose: {
          type: 'string',
          description:
            'One or two plain sentences shown to the user: what the secret is for and where to get it.',
        },
        project: {
          type: 'string',
          description:
            'Doppler project to write to. Only used on the main Pro instance, which has full Doppler access; ignored on client instances.',
        },
        config: {
          type: 'string',
          description: 'Doppler config to write to. Same rule as project.',
        },
      },
      required: ['name', 'purpose'],
    },
  },
  {
    name: 'reveal_secret',
    description:
      'Show a Doppler secret value to the user on their screen only. You never receive the value. Use when the user asks to see or copy a secret. A card appears in THIS chat with a Reveal button; only they can read what it shows. Blocks until the user reveals it, dismisses the card, or the request times out.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Doppler secret name in SCREAMING_SNAKE_CASE, for example STRIPE_API_KEY.',
        },
        project: {
          type: 'string',
          description:
            'Doppler project to read from. Only used on the main Pro instance, which has full Doppler access; ignored on client instances.',
        },
        config: {
          type: 'string',
          description: 'Doppler config to read from. Same rule as project.',
        },
      },
      required: ['name'],
    },
  },
];

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function authenticatedToken(): string {
  return resolveCurrentAgentToken(token, spawnConversationId, tokenFile);
}

async function callApi(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'X-VP-Agent-Token': authenticatedToken(), 'content-type': 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(typeof body.error === 'string' ? body.error : `request failed (${res.status})`);
  }
  return body;
}

type QuestionOutcome =
  | { status: 'answered'; answer: string }
  | { status: 'dismissed' }
  | { status: 'expired' }
  | { status: 'timeout' }
  | { status: 'gone' };

/**
 * Block until the user acts on a question card. The server auto-expires the
 * question after its own timeout (~10 min); we poll until then, with a
 * wall-clock backstop and tolerance for the turn being torn down mid-wait.
 */
async function awaitQuestion(convPath: string, questionId: string): Promise<QuestionOutcome> {
  const deadline = Date.now() + 15 * 60_000;
  let misses = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let poll: Record<string, unknown>;
    try {
      poll = await callApi(`/api/conversations/${convPath}/questions/${encodeURIComponent(questionId)}`);
      misses = 0;
    } catch {
      // Question gone (cleaned up) or turn ending — give up after a few misses.
      if (++misses > 5) return { status: 'gone' };
      continue;
    }
    if (poll.pending) {
      if (Date.now() > deadline) return { status: 'timeout' };
      continue;
    }
    if (poll.dismissed) return { status: 'dismissed' };
    if (poll.expired) return { status: 'expired' };
    return { status: 'answered', answer: String(poll.answer ?? '') };
  }
}

// ── skill rendering (compact text, never raw JSON) ──────────────────────────
interface SkillRow {
  scope: string;
  name: string;
  description: string | null;
  enabled: boolean;
  readOnly: boolean;
  providers: { claude: string; codex: string; grok: string };
  issues: string[];
  entryKind: 'original' | 'link';
  source: { scope: string; name: string } | null;
  dependents: Array<{ scope: string; name: string }>;
  content?: string;
}
interface SkillGroup {
  scope: string;
  label: string;
  skills: SkillRow[];
}

function renderSkillLine(scope: string, s: SkillRow): string {
  const state = s.enabled ? 'enabled' : 'off';
  const providers = `claude:${s.providers.claude} codex:${s.providers.codex} grok:${s.providers.grok}`;
  const issues = s.issues.length ? ` — issues: ${s.issues.join(', ')}` : '';
  const ro = s.readOnly ? ' — read-only' : '';
  const relationship =
    s.entryKind === 'link'
      ? ` — link${s.source ? ` to ${s.source.scope}/${s.source.name}` : ' to external or missing source'}`
      : s.dependents.length
        ? ` — original; linked from ${s.dependents.map((p) => `${p.scope}/${p.name}`).join(', ')}`
        : ' — original';
  return `${s.name} — ${scope} — ${state} — ${providers}${relationship}${issues}${ro}`;
}

function renderSkillsList(scopes: SkillGroup[]): string {
  const lines: string[] = [];
  const legend: string[] = [];
  for (const group of scopes) {
    legend.push(`  ${group.scope} = ${group.label}`);
    for (const s of group.skills) lines.push(renderSkillLine(group.scope, s));
  }
  const body = lines.length ? lines.join('\n') : '(no skills yet)';
  return `Skills — one line per placement (name — scope key — state — providers):\n${body}\n\nScope keys (use these verbatim):\n${legend.join('\n')}`;
}

function renderSkillDetail(s: SkillRow): string {
  const lines = [
    `Skill: ${s.name}`,
    `Scope: ${s.scope}`,
    `Description: ${s.description ?? '(none)'}`,
    `Providers: claude:${s.providers.claude} codex:${s.providers.codex} grok:${s.providers.grok}`,
    `Enabled: ${s.enabled}${s.readOnly ? ' (read-only)' : ''}`,
    s.entryKind === 'link'
      ? `Storage: Link${s.source ? ` to ${s.source.scope}/${s.source.name}` : ' to an external or missing source'}`
      : `Storage: Original${s.dependents.length ? `; linked from ${s.dependents.map((p) => `${p.scope}/${p.name}`).join(', ')}` : ''}`,
  ];
  if (s.issues.length) lines.push(`Issues: ${s.issues.join(', ')}`);
  lines.push('', '--- SKILL.md ---', s.content && s.content.length ? s.content : '(empty)');
  return lines.join('\n');
}

/**
 * Explain the delivery precisely. "Queued" used to cover both a real dead end
 * and an ordinary busy turn, so the sender could not tell whether to wait, stop
 * the turn, or tell the user to act.
 */
function sendMessageDetail(disposition: string, steerReason: unknown, interrupted = false): string {
  // An interrupt flag on an already-live delivery is harmless but worth naming,
  // so the sender does not think it stopped a turn that was never stopped.
  const unneeded = interrupted ? ' The interrupt flag was not needed.' : '';
  if (disposition === 'steered') return `Steered into the active turn.${unneeded}`;
  if (disposition === 'delivered') {
    return 'Delivered to the live agent process; it will read it when its current tool call finishes. A durable copy is kept in case the turn ends first.';
  }
  if (disposition === 'running') return `Started the agent.${unneeded}`;
  if (disposition === 'duplicate') return `Already delivered (duplicate).${unneeded}`;
  const reason = typeof steerReason === 'string' ? steerReason : '';
  if (reason === 'failed_turn') return 'Queued behind a failed turn; the user must retry or skip it in that chat.';
  if (reason === 'other_actor') {
    return 'Queued: the live turn belongs to another user, so it runs as a fresh turn afterward.';
  }
  // Nothing is running, so there is nothing an interrupt could stop.
  if (reason === 'no_live_turn' || !reason) return 'Queued; it runs when the current turn ends.';
  const detail =
    reason === 'maintenance'
      ? 'Queued: the chat is compacting or capturing memory; it runs when that finishes.'
      : reason === 'no_steer_support'
        ? 'Queued: this provider cannot take input mid-turn; it runs after the current turn.'
        : 'Queued: the agent process did not accept the write; it runs after the current turn.';
  return `${detail} Pass interrupt: true to stop the current turn and deliver now.`;
}

function promptPreview(value: unknown, limit = 180): string {
  const prompt = String(value ?? '').replace(/\s+/g, ' ').trim();
  return prompt.length > limit ? `${prompt.slice(0, limit)}…` : prompt;
}

function renderScheduledTask(task: Record<string, unknown>, includePrompt: boolean): string {
  const status = task.enabled === false ? 'paused' : 'enabled';
  const nextRun = task.nextRunAt ? String(task.nextRunAt) : '(none)';
  const upcomingRuns = Array.isArray(task.upcomingRuns) ? task.upcomingRuns.map(String) : [];
  const lines = [
    `Automation: ${String(task.name ?? '(unnamed)')}`,
    `Task id: ${String(task.id ?? '')}`,
    `Status: ${status}`,
    `Schedule: ${String(task.scheduleText ?? '')}`,
    `Schedule spec: ${JSON.stringify(task.schedule ?? null)}`,
    `Timezone: ${String(task.timezone ?? '')}`,
    `Agent: ${String(task.assistantName ?? '(unknown)')} (${String(task.assistantSlug ?? '?')})`,
    `Model: ${String(task.provider ?? '?')} / ${String(task.model ?? '(provider default)')}`,
    `Thinking: ${String(task.effort ?? '(provider default)')}`,
    `Workspace: ${task.projectId ? `${String(task.projectName ?? '(unnamed project)')} (${String(task.projectId)})` : 'Automations workspace'}`,
    `Pinned in Chats: ${task.pinned === true ? 'yes' : 'no'}`,
    `Next run: ${nextRun}`,
    `Next runs: ${upcomingRuns.length ? upcomingRuns.join(', ') : '(none)'}`,
  ];
  if (includePrompt) lines.push('Prompt:', String(task.prompt ?? ''));
  else lines.push(`Prompt preview: ${promptPreview(task.prompt)}`);
  return lines.join('\n');
}

function renderScheduledTaskRun(run: Record<string, unknown>): string {
  return [
    `Run id: ${String(run.id ?? '')}`,
    `Status: ${String(run.status ?? '')}`,
    `Trigger: ${String(run.trigger ?? '')}`,
    `Scheduled for: ${String(run.scheduledFor ?? '')}`,
    `Started: ${String(run.startedAt ?? '')}`,
    `Finished: ${String(run.finishedAt ?? '(not finished)')}`,
    `Important: ${run.important === true ? 'yes' : 'no'}`,
    `Chat id: ${String(run.conversationId ?? '(none)')}`,
    `Chat title: ${String(run.conversationTitle ?? '(none)')}`,
    `Error: ${String(run.error ?? '(none)')}`,
  ].join('\n');
}

function renderWakeup(wakeup: Record<string, unknown>): string {
  return [
    `Wake id: ${String(wakeup.id ?? '')}`,
    `Key: ${String(wakeup.wake_key ?? '')}`,
    `Status: ${String(wakeup.status ?? '')}`,
    `Scheduled for: ${String(wakeup.scheduled_for ?? '')}`,
    `Reason: ${String(wakeup.reason ?? '')}`,
  ].join('\n');
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    if (name === 'project_settings') {
      return await callProjectSettingsTool(args, callApi);
    }
    const projectResult = await callProjectTool({ name, args, callApi });
    if (projectResult) return projectResult;
    const botResult = await callBotTool({ name, args, callApi });
    if (botResult) return botResult;
    const conversationDiscoveryResult = await callConversationDiscoveryTool({ name, args, callApi });
    if (conversationDiscoveryResult) return conversationDiscoveryResult;
    const chatLinkResult = await callChatLinkTool({ name, args, callApi, sourceConversationId: spawnConversationId });
    if (chatLinkResult) return chatLinkResult;
    const renameConversationResult = await callRenameConversationTool({
      name,
      args,
      callApi,
      sourceConversationId: spawnConversationId,
    });
    if (renameConversationResult) return renameConversationResult;
    const todoResult = await callTodoTool({ name, args, callApi });
    if (todoResult) return todoResult;
    const roomResult = await callRoomTool({ name, args, callApi });
    if (roomResult) return roomResult;
    const huddleResult = await callHuddleTool({ name, args, callApi });
    if (huddleResult) return huddleResult;
    const gmailDraftResult = await callGmailDraftTool({ name, args, callApi });
    if (gmailDraftResult) return gmailDraftResult;
    if (name === 'list_skills') {
      const { scopes } = (await callApi('/api/skills')) as { scopes: SkillGroup[] };
      return { content: [{ type: 'text', text: renderSkillsList(scopes) }] };
    }
    if (name === 'read_skill') {
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const nm = encodeURIComponent(String(args.name ?? ''));
      const { skill } = (await callApi(`/api/skills/${scope}/${nm}`)) as { skill: SkillRow };
      return { content: [{ type: 'text', text: renderSkillDetail(skill) }] };
    }
    if (name === 'create_skill') {
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const { skill, crossScopeDuplicates } = (await callApi(`/api/skills/${scope}`, {
        method: 'POST',
        body: JSON.stringify({ name: String(args.name ?? ''), description: String(args.description ?? ''), body: String(args.body ?? '') }),
      })) as { skill: SkillRow; crossScopeDuplicates?: string[] };
      const warn = crossScopeDuplicates?.length
        ? `\nNote: a skill named "${skill.name}" also exists in: ${crossScopeDuplicates.join(', ')} (global shadows project for Claude).`
        : '';
      return { content: [{ type: 'text', text: `Created.\n${renderSkillDetail(skill)}${warn}` }] };
    }
    if (name === 'update_skill') {
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const nm = encodeURIComponent(String(args.name ?? ''));
      const patch: Record<string, unknown> = {};
      if (args.raw !== undefined) patch.raw = String(args.raw);
      else {
        if (args.description !== undefined) patch.description = String(args.description);
        if (args.body !== undefined) patch.body = String(args.body);
      }
      const { skill } = (await callApi(`/api/skills/${scope}/${nm}`, { method: 'PUT', body: JSON.stringify(patch) })) as { skill: SkillRow };
      return { content: [{ type: 'text', text: `Updated.\n${renderSkillDetail(skill)}` }] };
    }
    if (name === 'move_skill' || name === 'copy_skill') {
      const op = name === 'move_skill' ? 'move' : 'copy';
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const nm = encodeURIComponent(String(args.name ?? ''));
      const { skill } = (await callApi(`/api/skills/${scope}/${nm}/${op}`, {
        method: 'POST',
        body: JSON.stringify({ toScope: String(args.toScope ?? '') }),
      })) as { skill: SkillRow };
      return { content: [{ type: 'text', text: `${op === 'move' ? 'Moved' : 'Copied'} to ${skill.scope}.\n${renderSkillDetail(skill)}` }] };
    }
    if (name === 'sync_skill') {
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const nm = encodeURIComponent(String(args.name ?? ''));
      const { skill } = (await callApi(`/api/skills/${scope}/${nm}/sync`, { method: 'POST' })) as { skill: SkillRow };
      return { content: [{ type: 'text', text: `Synced.\n${renderSkillDetail(skill)}` }] };
    }
    if (name === 'delete_skill') {
      const scope = encodeURIComponent(String(args.scope ?? ''));
      const nm = encodeURIComponent(String(args.name ?? ''));
      await callApi(`/api/skills/${scope}/${nm}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Deleted skill "${String(args.name ?? '')}" from ${String(args.scope ?? '')}.` }] };
    }
    if (name === 'read_conversation') {
      const conversationId = String(args.conversationId ?? '');
      const [{ conversation }, { events }] = await Promise.all([
        callApi(`/api/conversations/${encodeURIComponent(conversationId)}`) as Promise<{ conversation: Record<string, unknown> }>,
        callApi(`/api/conversations/${encodeURIComponent(conversationId)}/transcript`) as Promise<{ events: unknown[] }>,
      ]);
      return { content: [{ type: 'text', text: summarizeConversation(conversation, events) }] };
    }
    if (name === 'send_message') {
      const conversationId = String(args.conversationId ?? '');
      const result = await callApi(`/api/conversations/${encodeURIComponent(conversationId)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ text: String(args.text ?? '') }),
      });
      const disposition = String(result.disposition ?? 'queued');
      const messageId = Number(result.messageId ?? 0);
      // 'delivered' keeps its durable queue row, so send-now still works: the
      // interrupt kills the turn and that row runs first.
      if (
        args.interrupt === true
        && (disposition === 'queued' || disposition === 'delivered')
        && Number.isSafeInteger(messageId)
        && messageId > 0
      ) {
        try {
          await callApi(
            `/api/conversations/${encodeURIComponent(conversationId)}/queue/${messageId}/send-now`,
            { method: 'POST' },
          );
          return {
            content: [
              {
                type: 'text',
                text: 'Stopped the current turn; your message runs now. Call read_conversation later to see the outcome.',
              },
            ],
          };
        } catch (err) {
          // The message is still safely queued, so report that rather than failing the call.
          const detail = sendMessageDetail(disposition, result.steerReason);
          return {
            content: [
              {
                type: 'text',
                text: `${detail} The interrupt did not go through (${(err as Error).message}). Call read_conversation later to see the outcome.`,
              },
            ],
          };
        }
      }
      const detail = sendMessageDetail(disposition, result.steerReason, args.interrupt === true);
      return { content: [{ type: 'text', text: `${detail} Call read_conversation later to see the outcome.` }] };
    }
    if (name === 'save_memory') {
      const content = String(args.content ?? '').trim();
      if (!content) return { content: [{ type: 'text', text: 'save_memory needs content to remember.' }], isError: true };
      const projectId = args.project_id === undefined ? null : String(args.project_id).trim() || null;
      const body: Record<string, unknown> = { content, isStatic: args.permanent === true, projectId };
      const { memory } = (await callApi('/api/memory', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { memory: Record<string, unknown> };
      return {
        content: [
          {
            type: 'text',
            text: `Remembered: ${String(memory.content ?? content)} (memory id: ${String(memory.id ?? '')})`,
          },
        ],
      };
    }
    if (name === 'search_memory') {
      const query = String(args.query ?? '').trim();
      if (!query) return { content: [{ type: 'text', text: 'search_memory needs a query.' }], isError: true };
      const { memories } = (await callApi(`/api/memory?q=${encodeURIComponent(query)}&limit=8`)) as {
        memories: Record<string, unknown>[];
      };
      if (!memories?.length) return { content: [{ type: 'text', text: 'No matching memories found.' }] };
      return {
        content: [
          {
            type: 'text',
            text: memories
              .map((memory) => `- ${String(memory.content ?? '')} (memory id: ${String(memory.id ?? '')})`)
              .join('\n'),
          },
        ],
      };
    }
    if (name === 'forget_memory') {
      const id = String(args.id ?? '').trim();
      if (!id) return { content: [{ type: 'text', text: 'forget_memory needs a memory id.' }], isError: true };
      await callApi(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `Forgot memory ${id}.` }] };
    }
    if (name === 'enqueue_build') {
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'enqueue_build is unavailable here (no active conversation).' }], isError: true };
      }
      const { job, position, disposition } = (await callApi('/api/build-queue', {
        method: 'POST',
        body: JSON.stringify({
          sourceConversationId: spawnConversationId,
          title: String(args.title ?? ''),
          brief: String(args.brief ?? ''),
        }),
      })) as { job: Record<string, unknown>; position: number; disposition: 'enqueued' | 'merged' | 'existing' | 'requeued' };
      // Agents otherwise read "wait for your slot" as a follow-up they must
      // arrange themselves, and stack a redundant wake-up on top of the queue.
      const wakeGuarantee =
        ' The build queue starts a new turn in this chat by itself when the slot is active, so do not schedule a wake-up to wait for it.';
      const preparationGuidance =
        String(job.status) === 'queued' && position > 1
          ? ` Keep your queue place and use the remainder of this turn for read-only preparation: inspect relevant source, tests, and documentation, then leave a concrete implementation and validation plan in the chat. Do not change files or run builds, tests, installs, generators, formatters, commits, or shipping.${wakeGuarantee} The shared checkout may change, so revalidate the plan when that turn arrives.`
          : ` End this turn promptly without changing the source so the available build slot can start.${wakeGuarantee}`;
      const text =
        disposition === 'merged'
          ? `Added this request to this chat's existing waiting build #${String(job.id)} at position ${position}; no second queue slot was created.${preparationGuidance}`
          : disposition === 'requeued'
            ? `Revived this chat's earlier build #${String(job.id)} “${String(job.title)}”, which had stalled as failed or stopped, and requeued it at position ${position}; any new details were merged into its brief and no second queue slot was created.${preparationGuidance}`
            : disposition === 'existing'
              ? `This chat already has active build #${String(job.id)} “${String(job.title)}” at position ${position}. This request was NOT recorded anywhere — the queue is not holding it and will not remind you of it. Keep the full brief in this chat, finish the active build, then call enqueue_build again in a later turn to file it.${wakeGuarantee}`
              : `Queued build #${String(job.id)} “${String(job.title)}” at position ${position}.${preparationGuidance}`;
      return {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    }
    if (name === 'list_build_queue') {
      const { jobs } = (await callApi('/api/build-queue')) as { jobs: Record<string, unknown>[] };
      const lines = jobs.map((job) => {
        const error = job.error ? ` — ${String(job.error)}` : '';
        const scope = job.scopeKey === 'source' ? 'Veneer Pro source' : String(job.projectName ?? 'Project');
        return `${scope} ${String(job.position)}. #${String(job.id)} [${String(job.status)}] ${String(job.title)}${error}`;
      });
      return { content: [{ type: 'text', text: lines.length ? `Build queues:\n${lines.join('\n')}` : 'The build queues are empty.' }] };
    }
    if (name === 'resolve_build_queue') {
      const jobId = Number(args.job_id);
      const action = String(args.action ?? '');
      const { job } = (await callApi(`/api/build-queue/${jobId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })) as { job: Record<string, unknown> };
      return {
        content: [{ type: 'text', text: `Build #${String(job.id)} is now ${String(job.status)}.` }],
      };
    }
    if (name === 'handoff') {
      const task = String(args.task ?? '').trim();
      if (!task) {
        return { content: [{ type: 'text', text: 'handoff needs a task — the instruction for the new agent.' }], isError: true };
      }
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'handoff is unavailable here (no active conversation).' }], isError: true };
      }
      // Resolve an optional project reference (id, slug, or name) → projectId.
      let projectId: string | undefined;
      const projectRef = String(args.project ?? '').trim();
      if (projectRef) {
        const { projects } = (await callApi('/api/projects')) as { projects: Record<string, unknown>[] };
        const needle = projectRef.toLowerCase();
        const match = projects.find(
          (p) =>
            String(p.id ?? '') === projectRef ||
            String(p.slug ?? '').toLowerCase() === needle ||
            String(p.name ?? '').toLowerCase() === needle,
        );
        if (!match) {
          const names = projects.map((p) => `${String(p.name ?? '?')} (${String(p.id ?? '?')})`).join(', ') || '(none)';
          return {
            content: [
              {
                type: 'text',
                text:
                  `No project matches "${projectRef}". Available: ${names}. ` +
                  'Call list_projects, or create_project natively if the requested project does not exist.',
              },
            ],
            isError: true,
          };
        }
        projectId = String(match.id);
      }
      // Traceability: tell the new agent it was handed off, and how to report
      // back. Keep the task FIRST so the chat's title (first line) is meaningful
      // — the handoff note follows it.
      const origin = `[Handoff] You were started by another agent to handle this delegated task. Origin chat id: ${spawnConversationId}. Call read_conversation("${spawnConversationId}") to see the context that led here, and send_message("${spawnConversationId}", …) to report your progress or final result back to it — it will not see your work otherwise.`;
      const firstMessage = `${task}\n\n---\n${origin}`;
      const body: Record<string, unknown> = { firstMessage, originConversationId: spawnConversationId };
      if (args.provider !== undefined) body.provider = String(args.provider);
      if (args.model !== undefined) body.model = String(args.model);
      if (args.effort !== undefined) body.effort = String(args.effort);
      if (args.provider !== undefined) body.provider = String(args.provider);
      if (args.model !== undefined) body.model = String(args.model);
      if (projectId) body.projectId = projectId;
      const { conversation } = (await callApi('/api/conversations', { method: 'POST', body: JSON.stringify(body) })) as {
        conversation: Record<string, unknown>;
      };
      const id = String(conversation.id ?? '');
      const prov = String(conversation.provider ?? '');
      const mdl = conversation.model ? String(conversation.model) : '(provider default)';
      const eff = conversation.effort ? String(conversation.effort) : '(default)';
      const asst = String(conversation.assistantSlug ?? 'assistant');
      return {
        content: [
          {
            type: 'text',
            text:
              `Handed off. New chat id: ${id}\n` +
              `Running ${asst} on ${prov} — model ${mdl}, effort ${eff}.\n` +
              `The new agent is working on its own. Use read_conversation("${id}") to check its progress or result, or send_message("${id}", …) to steer it. It will not reply in this chat.`,
          },
        ],
      };
    }
    if (name === 'list_agent_options') {
      const [{ prefs }, { assistants }, { projects }] = (await Promise.all([
        callApi('/api/model-prefs'),
        callApi('/api/assistants'),
        callApi('/api/projects'),
      ])) as [
        { prefs: Record<string, unknown> },
        { assistants: Record<string, unknown>[] },
        { projects: Record<string, unknown>[] },
      ];
      const providerDefaults = (prefs.providerDefaults ?? {}) as Record<string, string | null>;
      const providers = Object.keys(providerDefaults);
      const openrouterModels = Array.isArray(prefs.openrouterModels) ? (prefs.openrouterModels as string[]) : [];
      // Live model list per provider (OpenRouter uses the configured allow-list;
      // the others are queried from the runner, which may return [] if the
      // provider isn't connected or has no listModels support).
      const modelsByProvider = new Map<string, string[]>();
      await Promise.all(
        providers.map(async (p) => {
          if (p === 'openrouter') {
            modelsByProvider.set(p, openrouterModels);
            return;
          }
          try {
            const { models } = (await callApi(`/api/models?provider=${encodeURIComponent(p)}`)) as {
              models: { id: string }[];
            };
            modelsByProvider.set(p, models.map((m) => m.id));
          } catch {
            modelsByProvider.set(p, []);
          }
        }),
      );
      const lines: string[] = ['Providers (default provider: ' + String(prefs.defaultProvider ?? '?') + `, default effort: ${String(prefs.defaultEffort ?? '(provider default)')}):`];
      for (const p of providers) {
        const def = providerDefaults[p] ?? '(provider default)';
        const models = modelsByProvider.get(p) ?? [];
        const shown = models.slice(0, 12);
        const more = models.length > shown.length ? `, …(+${models.length - shown.length} more)` : '';
        lines.push(`  ${p} — default model: ${def}${models.length ? ` — models: ${shown.join(', ')}${more}` : ' — (no model list; free-text a model id)'}`);
      }
      lines.push('', 'Agent types (assistant slug — name):');
      for (const a of assistants) {
        lines.push(`  ${String(a.slug ?? '?')} — ${String(a.name ?? '?')}${a.adminOnly ? ' (admin only)' : ''}`);
      }
      lines.push('', 'Projects (name — id — slug):');
      if (projects.length === 0) lines.push('  (none — omit project to use the default workspace)');
      for (const pr of projects) {
        lines.push(`  ${String(pr.name ?? '?')} — ${String(pr.id ?? '?')} — ${String(pr.slug ?? '')}`);
      }
      lines.push('', 'Use these with the handoff tool (provider, model, effort, assistant, project). Omit any of them to take the default.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    if (name === 'schedule_wakeup') {
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'schedule_wakeup is unavailable here (no active conversation).' }], isError: true };
      }
      const body: Record<string, unknown> = {
        reason: String(args.reason ?? ''),
        key: String(args.key ?? 'default'),
      };
      if (args.delay_seconds !== undefined) body.delaySeconds = Number(args.delay_seconds);
      if (args.run_at !== undefined) body.runAt = String(args.run_at);
      const result = (await callApi(`/api/conversations/${encodeURIComponent(spawnConversationId)}/wakeups`, {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { wakeup: Record<string, unknown>; replacedWakeupId?: string | null };
      const replacement = result.replacedWakeupId
        ? ` Replaced pending wake ${result.replacedWakeupId}.`
        : '';
      return {
        content: [
          {
            type: 'text',
            text:
              `Wake-up persisted for ${String(result.wakeup.scheduled_for ?? '')}. ` +
              `Wake id: ${String(result.wakeup.id ?? '')}.${replacement}\n` +
              'This chat will receive a trusted continuation message at that time. End this turn after a concise status update.',
          },
        ],
      };
    }
    if (name === 'list_wakeups') {
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'list_wakeups is unavailable here (no active conversation).' }], isError: true };
      }
      const { wakeups } = (await callApi(
        `/api/conversations/${encodeURIComponent(spawnConversationId)}/wakeups`,
      )) as { wakeups: Record<string, unknown>[] };
      return {
        content: [
          {
            type: 'text',
            text: wakeups.length ? wakeups.map(renderWakeup).join('\n\n') : 'This chat has no wake-ups.',
          },
        ],
      };
    }
    if (name === 'cancel_wakeup') {
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'cancel_wakeup is unavailable here (no active conversation).' }], isError: true };
      }
      const wakeupId = String(args.wakeup_id ?? '').trim();
      if (!wakeupId) {
        return { content: [{ type: 'text', text: 'cancel_wakeup needs an exact wakeup_id.' }], isError: true };
      }
      const { wakeup } = (await callApi(
        `/api/conversations/${encodeURIComponent(spawnConversationId)}/wakeups/${encodeURIComponent(wakeupId)}`,
        { method: 'DELETE' },
      )) as { wakeup: Record<string, unknown> };
      return { content: [{ type: 'text', text: `Cancelled wake ${String(wakeup.id ?? wakeupId)}.` }] };
    }
    if (name === 'schedule_task') {
      if (!spawnConversationId) {
        return { content: [{ type: 'text', text: 'schedule_task is unavailable here (no active conversation).' }], isError: true };
      }
      const type = String(args.schedule_type ?? '');
      const timezone = String(args.timezone ?? DEFAULT_SCHEDULE_TIME_ZONE);
      let schedule: Record<string, unknown>;
      if (type === 'once') schedule = { type, runAt: String(args.run_at ?? '') };
      else if (type === 'cron') schedule = { type, expression: String(args.cron ?? '') };
      else if (type === 'weekly') {
        schedule = { type, time: String(args.time ?? ''), weekday: Number(args.weekday) };
      } else if (type === 'daily' || type === 'weekdays') schedule = { type, time: String(args.time ?? '') };
      else {
        return { content: [{ type: 'text', text: 'Unknown schedule_type.' }], isError: true };
      }
      const body: Record<string, unknown> = {
        name: String(args.name ?? ''),
        prompt: String(args.prompt ?? ''),
        timezone,
        schedule,
        sourceConversationId: spawnConversationId,
      };
      if (args.assistant !== undefined) body.assistantSlug = String(args.assistant);
      if (args.provider !== undefined) body.provider = String(args.provider);
      if (args.model !== undefined) body.model = args.model === null ? null : String(args.model);
      if (args.effort !== undefined) body.effort = args.effort === null ? null : String(args.effort);
      if (args.project_id !== undefined) body.projectId = args.project_id === null ? null : String(args.project_id);
      const { scheduledTask } = (await callApi('/api/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      })) as { scheduledTask: Record<string, unknown> };
      return {
        content: [
          {
            type: 'text',
            text:
              `Scheduled “${String(scheduledTask.name ?? '')}”.\n` +
              `Task id: ${String(scheduledTask.id ?? '')}.\n` +
              `${String(scheduledTask.scheduleText ?? '')} (${String(scheduledTask.timezone ?? '')}).\n` +
              `Next run: ${String(scheduledTask.nextRunAt ?? '')}. Use this task id with the scheduled-agent read, edit, run-history, run-now, or delete tools.`,
          },
        ],
      };
    }
    if (name === 'list_scheduled_tasks') {
      const { scheduledTasks } = (await callApi('/api/scheduled-tasks')) as {
        scheduledTasks: Record<string, unknown>[];
      };
      if (!scheduledTasks?.length) {
        return { content: [{ type: 'text', text: 'No scheduled agents or automations found.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              scheduledTasks.map((task) => renderScheduledTask(task, false)).join('\n\n') +
              '\n\nUse the exact task id with read_scheduled_task, update_scheduled_task, list_scheduled_task_runs, run_scheduled_task_now, or delete_scheduled_task. If more than one could match the user\'s request, ask which one they mean.',
          },
        ],
      };
    }
    if (name === 'read_scheduled_task') {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) {
        return { content: [{ type: 'text', text: 'read_scheduled_task needs an exact task_id.' }], isError: true };
      }
      const { scheduledTask } = (await callApi(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`)) as {
        scheduledTask: Record<string, unknown>;
      };
      return { content: [{ type: 'text', text: renderScheduledTask(scheduledTask, true) }] };
    }
    if (name === 'update_scheduled_task') {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) {
        return { content: [{ type: 'text', text: 'update_scheduled_task needs an exact task_id.' }], isError: true };
      }
      const patch: Record<string, unknown> = {};
      for (const field of ['name', 'prompt', 'timezone', 'enabled', 'pinned'] as const) {
        if (args[field] !== undefined) patch[field] = args[field];
      }
      if (args.project_id !== undefined) patch.projectId = args.project_id === null ? null : String(args.project_id);
      if (args.assistant !== undefined) patch.assistantSlug = String(args.assistant);
      if (args.provider !== undefined) patch.provider = String(args.provider);
      if (args.model !== undefined) patch.model = args.model === null ? null : String(args.model);
      if (args.effort !== undefined) patch.effort = args.effort === null ? null : String(args.effort);

      const hasTimingField =
        args.time !== undefined || args.weekday !== undefined || args.run_at !== undefined || args.cron !== undefined;
      const scheduleType = args.schedule_type === undefined ? '' : String(args.schedule_type);
      if (hasTimingField && !scheduleType) {
        return {
          content: [{ type: 'text', text: 'Provide schedule_type whenever changing time, weekday, or run_at.' }],
          isError: true,
        };
      }
      if (scheduleType) {
        if (scheduleType === 'once') {
          const runAt = String(args.run_at ?? '').trim();
          if (!runAt) {
            return { content: [{ type: 'text', text: 'A once schedule needs run_at.' }], isError: true };
          }
          patch.schedule = { type: scheduleType, runAt };
        } else if (scheduleType === 'cron') {
          const expression = String(args.cron ?? '').trim();
          if (!expression) {
            return { content: [{ type: 'text', text: 'A cron schedule needs a five-field cron expression.' }], isError: true };
          }
          patch.schedule = { type: scheduleType, expression };
        } else if (scheduleType === 'daily' || scheduleType === 'weekdays') {
          const time = String(args.time ?? '').trim();
          if (!time) {
            return { content: [{ type: 'text', text: `A ${scheduleType} schedule needs time.` }], isError: true };
          }
          patch.schedule = { type: scheduleType, time };
        } else if (scheduleType === 'weekly') {
          const time = String(args.time ?? '').trim();
          const weekday = Number(args.weekday);
          if (!time || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
            return {
              content: [{ type: 'text', text: 'A weekly schedule needs time and weekday (0=Sunday through 6=Saturday).' }],
              isError: true,
            };
          }
          patch.schedule = { type: scheduleType, time, weekday };
        } else {
          return { content: [{ type: 'text', text: 'Unknown schedule_type.' }], isError: true };
        }
      }
      if (Object.keys(patch).length === 0) {
        return {
          content: [{ type: 'text', text: 'Provide at least one field to update; omitted fields are preserved.' }],
          isError: true,
        };
      }
      const { scheduledTask } = (await callApi(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })) as { scheduledTask: Record<string, unknown> };
      return {
        content: [{ type: 'text', text: `Updated successfully.\n${renderScheduledTask(scheduledTask, true)}` }],
      };
    }
    if (name === 'list_scheduled_task_runs') {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) {
        return { content: [{ type: 'text', text: 'list_scheduled_task_runs needs an exact task_id.' }], isError: true };
      }
      const { runs } = (await callApi(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs`)) as {
        runs: Record<string, unknown>[];
      };
      if (!runs?.length) return { content: [{ type: 'text', text: `Task ${taskId} has no past runs.` }] };
      return {
        content: [{
          type: 'text',
          text:
            runs.map(renderScheduledTaskRun).join('\n\n') +
            '\n\nUse the exact task id and run id with update_scheduled_task_run or delete_scheduled_task_run. Never guess a run id.',
        }],
      };
    }
    if (name === 'update_scheduled_task_run') {
      const taskId = String(args.task_id ?? '').trim();
      const runId = String(args.run_id ?? '').trim();
      if (!taskId || !runId || typeof args.important !== 'boolean') {
        return {
          content: [{ type: 'text', text: 'update_scheduled_task_run needs exact task_id and run_id values plus important=true or false.' }],
          isError: true,
        };
      }
      const { run } = (await callApi(
        `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
        { method: 'PATCH', body: JSON.stringify({ important: args.important }) },
      )) as { run: Record<string, unknown> };
      return { content: [{ type: 'text', text: `Run updated.\n${renderScheduledTaskRun(run)}` }] };
    }
    if (name === 'run_scheduled_task_now') {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) {
        return { content: [{ type: 'text', text: 'run_scheduled_task_now needs an exact task_id.' }], isError: true };
      }
      const result = await callApi(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/run-now`, { method: 'POST' });
      return {
        content: [{
          type: 'text',
          text: `Scheduled agent started.\nRun id: ${String(result.runId ?? '')}\nChat id: ${String(result.conversationId ?? '')}`,
        }],
      };
    }
    if (name === 'delete_scheduled_task_run') {
      const taskId = String(args.task_id ?? '').trim();
      const runId = String(args.run_id ?? '').trim();
      if (!taskId || !runId) {
        return { content: [{ type: 'text', text: 'delete_scheduled_task_run needs exact task_id and run_id values.' }], isError: true };
      }
      const result = await callApi(
        `/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
        { method: 'DELETE' },
      );
      const archived = result.archivedConversationId
        ? ` Its run chat ${String(result.archivedConversationId)} was preserved in Archived chats.`
        : '';
      return { content: [{ type: 'text', text: `Deleted past run ${runId} from task ${taskId}.${archived}` }] };
    }
    if (name === 'delete_scheduled_task') {
      const taskId = String(args.task_id ?? '').trim();
      if (!taskId) {
        return { content: [{ type: 'text', text: 'delete_scheduled_task needs an exact task_id.' }], isError: true };
      }
      await callApi(`/api/scheduled-tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      return {
        content: [{ type: 'text', text: `Deleted scheduled agent ${taskId}. Its previous run chats were preserved in Archived chats.` }],
      };
    }
    if (name === 'publish_page') {
      const title = String(args.title ?? '').trim();
      if (!title) {
        return { content: [{ type: 'text', text: 'publish_page needs a title.' }], isError: true };
      }
      let html = args.html !== undefined ? String(args.html) : undefined;
      // html_file overrides inline html: read it from disk (relative to cwd).
      if (args.html_file !== undefined && String(args.html_file).trim()) {
        const filePath = path.resolve(process.cwd(), String(args.html_file));
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_PAGE_BYTES) {
            return {
              content: [{ type: 'text', text: `That HTML file is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB); the limit is 2 MB.` }],
              isError: true,
            };
          }
          html = fs.readFileSync(filePath, 'utf8');
        } catch {
          return { content: [{ type: 'text', text: `Could not read HTML file: ${String(args.html_file)}` }], isError: true };
        }
      }
      const body: Record<string, unknown> = { title };
      if (html !== undefined) body.html = html;
      if (args.page_id !== undefined) body.pageId = String(args.page_id);
      if (spawnConversationId) body.conversationId = spawnConversationId;

      // Raw fetch (not callApi) so the 503 not-configured `message` surfaces cleanly.
      const res = await fetch(`${baseUrl}/api/pages`, {
        method: 'POST',
        headers: { 'X-VP-Agent-Token': authenticatedToken(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || resBody.ok === false) {
        const msg =
          typeof resBody.message === 'string'
            ? resBody.message
            : typeof resBody.error === 'string'
              ? resBody.error
              : `Publishing failed (${res.status})`;
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
      const page = (resBody.page ?? {}) as Record<string, unknown>;
      const url = String(page.url ?? '');
      const pageId = String(page.id ?? '');
      const expiresAt = String(page.expiresAt ?? '');
      const text =
        `${url}\n\n` +
        `page_id: ${pageId}\n` +
        `expires_at: ${expiresAt}\n` +
        `Share this URL with the user and tell them it expires in seven days. To update the page and renew its seven-day lifetime (same URL), call publish_page again with page_id: ${pageId} and the updated HTML.`;
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'list_pages') {
      const { pages } = (await callApi('/api/pages')) as { pages: Record<string, unknown>[] };
      if (!pages || pages.length === 0) {
        return { content: [{ type: 'text', text: 'No pages have been published yet.' }] };
      }
      const lines = pages.map((p) => {
        const project = p.projectName ? String(p.projectName) : 'none';
        return `${String(p.title ?? '(untitled)')} — ${String(p.url ?? '')} (page_id: ${String(p.id ?? '')}, project: ${project}, expires ${String(p.expiresAt ?? '')})`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    if (name === 'publish_app') {
      const title = String(args.title ?? '').trim();
      if (!title) return { content: [{ type: 'text', text: 'publish_app needs a title.' }], isError: true };
      let source = args.source !== undefined ? String(args.source) : undefined;
      if (args.source_file !== undefined && String(args.source_file).trim()) {
        const filePath = path.resolve(process.cwd(), String(args.source_file));
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > MAX_APP_BYTES) {
            return {
              content: [{ type: 'text', text: `That app module is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB); the limit is 1 MB.` }],
              isError: true,
            };
          }
          source = fs.readFileSync(filePath, 'utf8');
        } catch {
          return { content: [{ type: 'text', text: `Could not read app module: ${String(args.source_file)}` }], isError: true };
        }
      }
      const body: Record<string, unknown> = { title };
      if (source !== undefined) body.source = source;
      if (args.slug !== undefined) body.slug = String(args.slug);
      if (args.app_id !== undefined) body.appId = String(args.app_id);
      if (args.runtime !== undefined) body.runtime = String(args.runtime);
      if (spawnConversationId) body.conversationId = spawnConversationId;

      const res = await fetch(`${baseUrl}/api/apps`, {
        method: 'POST',
        headers: { 'X-VP-Agent-Token': authenticatedToken(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || resBody.ok === false) {
        const message =
          typeof resBody.message === 'string'
            ? resBody.message
            : typeof resBody.error === 'string'
              ? resBody.error
              : `Publishing failed (${res.status})`;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
      const app = (resBody.app ?? {}) as Record<string, unknown>;
      const url = String(app.url ?? '');
      const appId = String(app.id ?? '');
      const runtime = String(app.runtime ?? 'cloudflare');
      return {
        content: [
          {
            type: 'text',
            text:
              `${url}\n\napp_id: ${appId}\nruntime: ${runtime}\n` +
              `This app is protected by the client's Cloudflare Access policy. To update it later at the same URL and runtime, call publish_app again with app_id: ${appId}.`,
          },
        ],
      };
    }
    if (name === 'list_apps') {
      const { apps } = (await callApi('/api/apps')) as { apps: Record<string, unknown>[] };
      if (!apps || apps.length === 0) return { content: [{ type: 'text', text: 'No mini apps have been published yet.' }] };
      return {
        content: [
          {
            type: 'text',
            text: apps
              .map(
                (app) =>
                  `${String(app.title ?? '(untitled)')} — ${String(app.url ?? '')} (app_id: ${String(app.id ?? '')}, runtime: ${String(app.runtime ?? 'cloudflare')}, status: ${String(app.status ?? '')})`,
              )
              .join('\n'),
          },
        ],
      };
    }
    if (name === 'ask_user') {
      if (!spawnConversationId) {
        return {
          content: [{ type: 'text', text: 'ask_user is unavailable here (no active conversation).' }],
          isError: true,
        };
      }
      const question = String(args.question ?? '').trim();
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const options = rawOptions
        .map((o): { label: string; value: string; description?: string } | null => {
          if (typeof o === 'string') return o.trim() ? { label: o.trim(), value: o.trim() } : null;
          const obj = (o ?? {}) as Record<string, unknown>;
          const label = String(obj.label ?? '').trim();
          if (!label) return null;
          const description = String(obj.description ?? '').trim();
          return {
            label,
            value: obj.value !== undefined ? String(obj.value) : label,
            ...(description ? { description } : {}),
          };
        })
        .filter((o): o is { label: string; value: string; description?: string } => o !== null);
      if (!question || options.length === 0) {
        return {
          content: [{ type: 'text', text: 'ask_user needs a question and at least one option.' }],
          isError: true,
        };
      }
      const convPath = encodeURIComponent(spawnConversationId);
      const { questionId } = (await callApi(`/api/conversations/${convPath}/ask`, {
        method: 'POST',
        body: JSON.stringify({
          question,
          options,
          multi: Boolean(args.multi),
          allowOther: Boolean(args.allowOther),
        }),
      })) as { questionId: string };
      const outcome = await awaitQuestion(convPath, questionId);
      if (outcome.status === 'gone') {
        return { content: [{ type: 'text', text: 'Could not get an answer from the user; continue without it.' }] };
      }
      if (outcome.status === 'timeout') {
        return {
          content: [{ type: 'text', text: 'The user has not answered yet; continue without their input for now.' }],
        };
      }
      if (outcome.status === 'dismissed') {
        return {
          content: [
            {
              type: 'text',
              text: 'The user replied in chat instead of choosing an option. Their message will arrive as the next message — finish your turn promptly so it can be delivered.',
            },
          ],
        };
      }
      if (outcome.status === 'expired') {
        return {
          content: [{ type: 'text', text: 'The user did not answer the question in time. Proceed without their input.' }],
        };
      }
      return { content: [{ type: 'text', text: `The user answered: ${outcome.answer}` }] };
    }
    if (SECRET_TOOL_NAMES.has(name) && secretToolsDisabled) {
      return { content: [{ type: 'text', text: SECRET_TOOLS_UNAVAILABLE }], isError: true };
    }
    if (name === 'request_secret') {
      if (!spawnConversationId) {
        return {
          content: [{ type: 'text', text: 'request_secret is unavailable here (no active conversation).' }],
          isError: true,
        };
      }
      const secretName = String(args.name ?? '').trim().toUpperCase();
      const purpose = String(args.purpose ?? '').trim();
      if (!secretName || !purpose) {
        return {
          content: [{ type: 'text', text: 'request_secret needs a secret name and a purpose.' }],
          isError: true,
        };
      }
      const convPath = encodeURIComponent(spawnConversationId);
      const saved = (await callApi(`/api/conversations/${convPath}/request-secret`, {
        method: 'POST',
        body: JSON.stringify({
          name: secretName,
          purpose,
          ...(args.project ? { project: String(args.project) } : {}),
          ...(args.config ? { config: String(args.config) } : {}),
        }),
      })) as { questionId: string; project?: string | null; config?: string | null };
      const questionId = saved.questionId;
      const outcome = await awaitQuestion(convPath, questionId);
      if (outcome.status === 'gone') {
        return {
          content: [{ type: 'text', text: `Could not confirm whether ${secretName} was saved; continue without it.` }],
        };
      }
      if (outcome.status === 'timeout') {
        return {
          content: [{ type: 'text', text: `The user has not saved ${secretName} yet; continue without it for now.` }],
        };
      }
      if (outcome.status === 'dismissed') {
        return {
          content: [
            {
              type: 'text',
              text: `The user replied in chat instead and did not save the secret. Their message will arrive as the next message — finish your turn promptly so it can be delivered.`,
            },
          ],
        };
      }
      if (outcome.status === 'expired') {
        return {
          content: [{ type: 'text', text: `The user did not save the secret in time. Proceed without ${secretName}.` }],
        };
      }
      // The value is written server-side; the answer is only ever 'saved'.
      const location = saved.project && saved.config
        ? `${saved.project}/${saved.config}`
        : 'the connected Doppler config';
      return {
        content: [
          {
            type: 'text',
            text: `The user saved ${secretName} to ${location} in Doppler. Read it at use time; never ask for or print the value.`,
          },
        ],
      };
    }
    if (name === 'reveal_secret') {
      if (!spawnConversationId) {
        return {
          content: [{ type: 'text', text: 'reveal_secret is unavailable here (no active conversation).' }],
          isError: true,
        };
      }
      const secretName = String(args.name ?? '').trim().toUpperCase();
      if (!secretName) {
        return { content: [{ type: 'text', text: 'reveal_secret needs a secret name.' }], isError: true };
      }
      const convPath = encodeURIComponent(spawnConversationId);
      const asked = (await callApi(`/api/conversations/${convPath}/reveal-secret`, {
        method: 'POST',
        body: JSON.stringify({
          name: secretName,
          ...(args.project ? { project: String(args.project) } : {}),
          ...(args.config ? { config: String(args.config) } : {}),
        }),
      })) as { questionId: string; project?: string | null; config?: string | null };
      const outcome = await awaitQuestion(convPath, asked.questionId);
      // Only ever a status: the value is delivered to the user's browser alone.
      const result = {
        status: outcome.status === 'answered' && outcome.answer === 'shown' ? 'shown' : 'dismissed',
        name: secretName,
        project: asked.project ?? null,
        config: asked.config ?? null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'veneer-pro-agents', version: '1.0.0' },
        },
      });
      break;
    case 'notifications/initialized':
      break; // notification — no response
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: secretToolsDisabled ? TOOLS.filter((tool) => !SECRET_TOOL_NAMES.has(tool.name)) : TOOLS },
      });
      break;
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      void callTool(name, args).then((result) => send({ jsonrpc: '2.0', id: msg.id, result }));
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});
