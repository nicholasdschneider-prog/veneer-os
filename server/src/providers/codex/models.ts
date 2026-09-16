import type { ModelOption } from '../types.js';
import { AppServerClient } from '../codexAppServer/protocol.js';

const REQUEST_TIMEOUT_MS = 8_000;

interface RawCodexModel {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string }[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

/**
 * Maps a `model/list` JSON-RPC result to the picker's shape. Verified live
 * 2026-07-05 against Codex CLI 0.142.5, 2026-07-14 against 0.144.4, and
 * 2026-09-04 against 0.153.4
 * (`codex app-server --stdio`) — the same call the Codex TUI itself uses to
 * populate its own model-selection UI. Since GPT-5.6 (CLI ≥0.143) the effort
 * vocabulary is per-model, so it rides along on each option instead of the UI
 * assuming one static set per provider.
 */
export function toModelOptions(result: unknown): ModelOption[] {
  const data = (result as { data?: RawCodexModel[] } | undefined)?.data ?? [];
  return data
    .filter((m) => m.hidden !== true)
    .map((m) => {
      const option: ModelOption = { id: m.id ?? m.model ?? '', label: m.displayName ?? m.id ?? m.model ?? '' };
      const efforts = (m.supportedReasoningEfforts ?? [])
        .map((e) => e.reasoningEffort ?? '')
        .filter((e) => e.length > 0);
      if (efforts.length > 0) option.efforts = efforts;
      if (m.defaultReasoningEffort) option.defaultEffort = m.defaultReasoningEffort;
      if (m.isDefault === true) option.isDefault = true;
      return option;
    })
    .filter((m) => m.id.length > 0);
}

/** Calls `model/list` on an already-running client, never hanging past `REQUEST_TIMEOUT_MS`. */
export function requestModelList(client: AppServerClient): Promise<ModelOption[]> {
  const result = client.request('model/list', {}).then(toModelOptions).catch(() => [] as ModelOption[]);
  const timeout = new Promise<ModelOption[]>((resolve) => setTimeout(() => resolve([]), REQUEST_TIMEOUT_MS));
  return Promise.race([result, timeout]);
}

/**
 * One-shot `codex app-server` spawn just to call `model/list`, then exit. Used
 * by callers that do not already own the canonical Codex adapter's persistent
 * App Server RPC channel.
 */
export async function listCodexModelsStandalone(codexBin: string): Promise<ModelOption[]> {
  const client = new AppServerClient({ codexBin, log: { warn: () => undefined, error: () => undefined } });
  try {
    return await requestModelList(client);
  } finally {
    client.shutdown();
  }
}
