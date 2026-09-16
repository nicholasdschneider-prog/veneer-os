import { execFile, type ExecFileException } from 'node:child_process';

export interface ProviderRuntimeVersion {
  runtime: string;
  version: string | null;
  supportsConciseOutputStyle: boolean;
}

export interface ProviderRuntimeVersions {
  claude: ProviderRuntimeVersion;
  openrouter: ProviderRuntimeVersion;
  codex: ProviderRuntimeVersion;
  grok: ProviderRuntimeVersion;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

const VERSION_TIMEOUT_MS = 5_000;
const SEMVER_PATTERN = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;
export const MIN_CONCISE_OUTPUT_STYLE_VERSION = '2.1.237';

export function supportsConciseOutputStyle(version: string | null): boolean {
  if (!version) return false;
  const current = version.split(/[+-]/, 1)[0]!.split('.').map(Number);
  const minimum = MIN_CONCISE_OUTPUT_STYLE_VERSION.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

export function probeProviderVersion(bin: string | null | undefined, run: ExecFileLike = execFile): Promise<string | null> {
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    run(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      const match = SEMVER_PATTERN.exec(`${stdout}\n${stderr}`);
      resolve(match?.[1] ?? null);
    });
  });
}

export async function readProviderRuntimeVersions(
  bins: { claudeBin?: string | null; codexBin?: string | null; grokBin?: string | null },
  run: ExecFileLike = execFile,
): Promise<ProviderRuntimeVersions> {
  const [claude, codex, grok] = await Promise.all([
    probeProviderVersion(bins.claudeBin, run),
    probeProviderVersion(bins.codexBin, run),
    probeProviderVersion(bins.grokBin, run),
  ]);
  const claudeSupportsConcise = supportsConciseOutputStyle(claude);
  return {
    claude: { runtime: 'Claude Code', version: claude, supportsConciseOutputStyle: claudeSupportsConcise },
    openrouter: { runtime: 'Claude Code harness', version: claude, supportsConciseOutputStyle: false },
    codex: { runtime: 'Codex CLI', version: codex, supportsConciseOutputStyle: false },
    grok: { runtime: 'Grok CLI', version: grok, supportsConciseOutputStyle: false },
  };
}
