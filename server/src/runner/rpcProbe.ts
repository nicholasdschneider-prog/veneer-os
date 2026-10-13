/**
 * Authenticated runner RPC reachability, reported apart from /healthz.
 * The runner's GET /healthz needs no secret and no request body, so it can stay
 * green while the authenticated POST /rpc/* path web actually uses fails.
 * The probe calls the read-only /rpc/status for an id that matches no chat.
 */
export const RUNNER_RPC_PROBE_ID = '__runner_rpc_probe__';

export interface RunnerRpcProbeResult {
  ok: boolean;
  runner_rpc: 'healthy' | 'unavailable';
  latency_ms: number;
  error?: string;
}

export async function probeRunnerRpc(
  statusOf: (convId: string) => Promise<unknown>,
  timeoutMs = 2_000,
  now: () => number = Date.now,
): Promise<RunnerRpcProbeResult> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      statusOf(RUNNER_RPC_PROBE_ID),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runner RPC timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, runner_rpc: 'healthy', latency_ms: now() - started };
  } catch (error) {
    return { ok: false, runner_rpc: 'unavailable', latency_ms: now() - started, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
