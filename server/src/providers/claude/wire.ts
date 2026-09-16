import { z } from 'zod';

/**
 * zod schemas for the claude CLI `--output-format stream-json` wire format,
 * verified against Claude Code 2.1.200 (see docs/protocol-notes.md).
 * Unknown message types / subtypes are log-and-skip, never a crash.
 */

export const SystemInitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
});
export type SystemInit = z.infer<typeof SystemInitSchema>;

const ContentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const AssistantMessageSchema = z.object({
  type: z.literal('assistant'),
  error: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
  apiErrorStatus: z.number().optional(),
  message: z.object({
    id: z.string().optional(),
    role: z.literal('assistant'),
    model: z.string().optional(),
    content: z.array(ContentBlockSchema),
    // Per-API-call usage: input + cache_* here is THIS call's context-window
    // occupancy — unlike the result message's usage, which aggregates every
    // call in the turn (a tool-heavy turn re-reads the cache per round trip,
    // so that sum can exceed the window several times over).
    usage: z
      .object({
        input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/** Tool results echo back as `user` messages on the stream. */
export const UserMessageSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  }),
  toolUseResult: z
    .object({
      status: z.string().optional(),
      description: z.string().optional(),
      resolvedModel: z.string().optional(),
      totalDurationMs: z.number().optional(),
      totalTokens: z.number().optional(),
      totalToolUseCount: z.number().optional(),
      toolStats: z
        .object({
          readCount: z.number().optional(),
          searchCount: z.number().optional(),
          bashCount: z.number().optional(),
          editFileCount: z.number().optional(),
          linesAdded: z.number().optional(),
          linesRemoved: z.number().optional(),
          otherToolCount: z.number().optional(),
        })
        .passthrough()
        .optional(),
      exitCode: z.number().optional(),
    })
    .passthrough()
    .optional(),
  parent_tool_use_id: z.string().nullable().optional(),
});
export type UserWireMessage = z.infer<typeof UserMessageSchema>;

export const StreamEventSchema = z.object({
  type: z.literal('stream_event'),
  event: z
    .object({
      type: z.string(),
      index: z.number().optional(),
      delta: z
        .object({ type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional() })
        .passthrough()
        .optional(),
      content_block: ContentBlockSchema.optional(),
    })
    .passthrough(),
  parent_tool_use_id: z.string().nullable().optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ResultMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().nullable().optional(),
  session_id: z.string().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
  total_cost_usd: z.number().optional(),
});
export type ResultMessage = z.infer<typeof ResultMessageSchema>;

/**
 * Approval request (`--permission-prompt-tool stdio`), verified on 2.1.200:
 * `request_id` is TOP-LEVEL and the payload field is `input` (not `tool_input`).
 * See docs/protocol-notes.md §Approval round-trip for the exact samples.
 */
export const ControlRequestSchema = z.object({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: z
    .object({
      subtype: z.string(),
      tool_name: z.string().optional(),
      display_name: z.string().optional(),
      input: z.unknown().optional(),
      tool_use_id: z.string().optional(),
    })
    .passthrough(),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/**
 * Subscription rate-limit telemetry the CLI emits on the stream (verified live
 * 2026-07-06). Each event carries exactly ONE window (the binding one) — its
 * `rateLimitType` ("five_hour" | "seven_day" observed) — so consumers key
 * snapshots by type and keep the newest of each. `utilization` is a fraction
 * (0.83 = 83%); `resetsAt` is epoch seconds. Previously log-and-skipped; now
 * surfaced so the usage endpoint can capture it passively.
 *
 * `utilization` is OPTIONAL on the wire (verified live 2026-07-06: `status:
 * "allowed"` events omit it; it appears at warning level). Requiring it made
 * the schema silently drop every low-usage event.
 *
 * Overage is EVENT METADATA, not a window (verified live 2026-07-20 on CLI
 * 2.1.200: `overageStatus`/`overageDisabledReason` ride on every event; the
 * old separate `seven_day_overage_included` rateLimitType is no longer
 * emitted — expired snapshots of it age out of the usage store).
 */
export const RateLimitInfoSchema = z
  .object({
    status: z.string().optional(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string(),
    utilization: z.number().optional(),
    isUsingOverage: z.boolean().optional(),
    overageStatus: z.string().optional(),
    overageDisabledReason: z.string().optional(),
    surpassedThreshold: z.number().optional(),
  })
  .passthrough();
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

export const RateLimitEventSchema = z
  .object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: RateLimitInfoSchema,
  })
  .passthrough();
export type RateLimitEvent = z.infer<typeof RateLimitEventSchema>;

/** The control_response we write back on stdin (double-wrapped envelope). */
export function controlResponseLine(
  requestId: string,
  decision: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string },
): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision },
  });
}

const EnvelopeSchema = z.object({ type: z.string() }).passthrough();

export type WireMessage =
  | { kind: 'init'; msg: SystemInit }
  | { kind: 'assistant'; msg: AssistantMessage }
  | { kind: 'user'; msg: UserWireMessage }
  | { kind: 'stream_event'; msg: StreamEvent }
  | { kind: 'result'; msg: ResultMessage }
  | { kind: 'control_request'; msg: ControlRequest }
  | { kind: 'rate_limit'; msg: RateLimitEvent }
  | { kind: 'skip'; type: string };

/** Parse one NDJSON line into a typed wire message; null for unparseable lines. */
export function parseWireLine(line: string): WireMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) return null;
  const type = env.data.type;

  switch (type) {
    case 'system': {
      const init = SystemInitSchema.safeParse(raw);
      if (init.success) return { kind: 'init', msg: init.data };
      return { kind: 'skip', type: `system:${String((env.data as Record<string, unknown>).subtype ?? '?')}` };
    }
    case 'assistant': {
      const p = AssistantMessageSchema.safeParse(raw);
      return p.success ? { kind: 'assistant', msg: p.data } : { kind: 'skip', type };
    }
    case 'user': {
      const p = UserMessageSchema.safeParse(raw);
      return p.success ? { kind: 'user', msg: p.data } : { kind: 'skip', type };
    }
    case 'stream_event': {
      const p = StreamEventSchema.safeParse(raw);
      return p.success ? { kind: 'stream_event', msg: p.data } : { kind: 'skip', type };
    }
    case 'result': {
      const p = ResultMessageSchema.safeParse(raw);
      return p.success ? { kind: 'result', msg: p.data } : { kind: 'skip', type };
    }
    case 'control_request': {
      const p = ControlRequestSchema.safeParse(raw);
      if (p.success && p.data.request.subtype === 'can_use_tool') return { kind: 'control_request', msg: p.data };
      // Other control subtypes (none observed on 2.1.200): log-and-skip.
      return { kind: 'skip', type: `control_request:${String((env.data as { request?: { subtype?: string } }).request?.subtype ?? '?')}` };
    }
    case 'rate_limit_event': {
      // Malformed/empty telemetry (missing rateLimitType/utilization) still skips,
      // exactly as before it was parsed — only well-formed windows are surfaced.
      const p = RateLimitEventSchema.safeParse(raw);
      return p.success ? { kind: 'rate_limit', msg: p.data } : { kind: 'skip', type };
    }
    default:
      // hooks, status, and any future types — log-and-skip per spec.
      return { kind: 'skip', type };
  }
}
