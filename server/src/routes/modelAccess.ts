import type { ModelOption } from '../providers/types.js';

/**
 * Models reserved for one named user rather than shared with everyone on this
 * install. Empty by default; add `provider:model` entries to restrict one.
 */
const USER_SCOPED_MODELS = new Map<string, { email: string; label: string }>();

function accessKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** True when a model is reserved for one user rather than shared site-wide. */
export function isUserScopedModel(provider: string, model: string | null | undefined): boolean {
  return Boolean(model && USER_SCOPED_MODELS.has(accessKey(provider, model)));
}

/** Server-side entitlement check for every path that can persist a model choice. */
export function canUserAccessModel(
  email: string,
  provider: string,
  model: string | null | undefined,
): boolean {
  if (!model) return true;
  const access = USER_SCOPED_MODELS.get(accessKey(provider, model));
  return !access || email.trim().toLowerCase() === access.email;
}

/** Remove user-scoped models before a provider catalog reaches a picker. */
export function modelsVisibleToUser(
  email: string,
  provider: string,
  models: ModelOption[],
): ModelOption[] {
  return models
    .filter((model) => canUserAccessModel(email, provider, model.id))
    .map((model) => {
      const access = USER_SCOPED_MODELS.get(accessKey(provider, model.id));
      return access ? { ...model, label: access.label } : model;
    });
}
