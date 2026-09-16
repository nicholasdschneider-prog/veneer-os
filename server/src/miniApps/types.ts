export type MiniAppRuntime = 'cloudflare' | 'local';
export type MiniAppDeploymentStatus = 'deploying' | 'deployed' | 'error';
export type LocalAppRuntimeStatus = 'starting' | 'running' | 'restarting' | 'stopped' | 'error' | 'unavailable';

export interface MiniAppRow {
  id: string;
  slug: string;
  title: string;
  source_text: string;
  source_size_bytes: number;
  script_name: string;
  route_id: string | null;
  runtime: MiniAppRuntime;
  status: MiniAppDeploymentStatus;
  last_error: string | null;
  project_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  deployed_at: string | null;
}

export interface LocalAppStatusView {
  status: LocalAppRuntimeStatus;
  error: string | null;
  pid: number | null;
}
