import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { runProjectDopplerCli, type ProjectDopplerCli } from './projectDopplerCli.js';

/**
 * One place that decides where a named secret lives, and one place that reads
 * its value. Both the HTTP reveal card (routes/api.ts) and the browser fill
 * tools (veneerBrowser/secretFill.ts) go through here.
 *
 * Nothing in this file ever puts a value in an error, a log, or a return type
 * other than the value itself.
 */

/** Where a caller-supplied Doppler path segment is allowed to point. */
export const DopplerPathSegment = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i);

export interface SecretAccessDeps {
  db: Database.Database;
  /** The interactive user's authenticated Doppler CLI wrapper. */
  projectDopplerCli: ProjectDopplerCli | null;
}

export type SecretTargetResolution =
  | { ok: true; project: string | null; config: string | null; exists?: boolean }
  | { ok: false; status: number; error: string };

/** A named secret that is simply not there. Never carries a value. */
export class SecretNotFoundError extends Error {
  constructor(name: string, project: string | null, config: string | null) {
    super(`${name} was not found in ${[project, config].filter(Boolean).join(' / ') || 'the connected Doppler config'}.`);
    this.name = 'SecretNotFoundError';
  }
}

// `doppler secrets --only-names --json` has returned both a name array and a
// name-keyed object across CLI versions; treat either as a plain name list.
function dopplerSecretNames(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed.map((name) => String(name));
    if (parsed && typeof parsed === 'object') return Object.keys(parsed);
  } catch {
    // A non-JSON response just means "presence unknown".
  }
  return [];
}

/** Where a named secret lives for this instance, plus a best-effort presence hint. */
export async function resolveSecretTarget(
  deps: SecretAccessDeps,
  name: string,
  requestedProject?: string,
  requestedConfig?: string,
): Promise<SecretTargetResolution> {
  {
    const cli = deps.projectDopplerCli;
    if (!cli) return { ok: false, status: 409, error: 'Doppler CLI is not available on this instance.' };
    const target = z
      .object({ project: DopplerPathSegment, config: DopplerPathSegment })
      .safeParse({ project: requestedProject, config: requestedConfig });
    if (!target.success) {
      return { ok: false, status: 400, error: 'project and config are required on this instance.' };
    }
    const { project, config } = target.data;
    // Presence is a hint for the card ("replace" vs "add"), never a blocker.
    let exists: boolean | undefined;
    try {
      const result = await runProjectDopplerCli(
        path.join(cli.binDir, 'doppler'),
        ['secrets', '--only-names', '--project', project, '--config', config, '--json'],
        os.tmpdir(),
      );
      if (result.code === 0) exists = dopplerSecretNames(result.stdout).includes(name);
    } catch {
      // Leave exists undefined.
    }
    return { ok: true, project, config, ...(exists === undefined ? {} : { exists }) };
  }
}

export interface SecretValue {
  name: string;
  project: string | null;
  config: string | null;
  value: string;
}

/**
 * The value of a named secret, scoped exactly like the reveal card: any
 * project/config the caller names (both required).
 */
export async function readSecretValue(
  deps: SecretAccessDeps,
  input: { name: string; project?: string; config?: string },
): Promise<SecretValue> {
  const name = input.name;
  {
    const cli = deps.projectDopplerCli;
    if (!cli) throw new Error('Doppler CLI is not available on this instance.');
    const target = z
      .object({ project: DopplerPathSegment, config: DopplerPathSegment })
      .safeParse({ project: input.project, config: input.config });
    if (!target.success) throw new Error('project and config are required on this instance.');
    const { project, config } = target.data;
    const result = await runProjectDopplerCli(
      path.join(cli.binDir, 'doppler'),
      ['secrets', 'get', name, '--project', project, '--config', config, '--plain'],
      os.tmpdir(),
    );
    // A missing secret is an ordinary CLI failure, not a server error. The CLI
    // output is not echoed: it can repeat neighbouring secret names.
    const value = result.code === 0 ? result.stdout.replace(/\n$/, '') : '';
    if (!value) throw new SecretNotFoundError(name, project, config);
    return { name, project, config, value };
  }
}
