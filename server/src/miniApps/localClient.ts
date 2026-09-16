import type { LocalAppStatusView } from './types.js';

export interface LocalAppRunnerClient {
  deploy(appId: string): Promise<void>;
  remove(appId: string): Promise<void>;
  statuses(appIds: string[]): Promise<Record<string, LocalAppStatusView>>;
}

interface RunnerEnvelope {
  ok?: boolean;
  error?: string;
}

export function createLocalAppRunnerClient(baseUrl: string): LocalAppRunnerClient {
  async function rpc<T extends RunnerEnvelope>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(`local app runner unreachable: ${(error as Error).message}`);
    }
    const result = (await response.json().catch(() => ({}))) as T;
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `local app runner failed (${response.status})`);
    }
    return result;
  }

  return {
    deploy: (appId) => rpc('/rpc/deploy', { appId }).then(() => undefined),
    remove: (appId) => rpc('/rpc/remove', { appId }).then(() => undefined),
    statuses: (appIds) =>
      rpc<RunnerEnvelope & { statuses: Record<string, LocalAppStatusView> }>('/rpc/statuses', { appIds }).then(
        (result) => result.statuses,
      ),
  };
}
