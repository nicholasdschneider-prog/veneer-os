/**
 * Optional workspace branding: set VP_CLIENT_NAME in the env file to override
 * the generic "Veneer" browser title with the workspace's own name.
 */
export function clientDisplayName(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.VP_CLIENT_NAME?.trim() || null;
}
