/** No caller-provided flag, profile file, or shared adapter can open this gate.
 * The isolated native host has not been implemented/accepted on this install.
 * Keep this separate from provider discovery and ordinary chat materialization.
 */
export const FIXTURE_BLOCKERS = [
  'ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE',
  'NONSHARED_PROVIDER_AUTH_UNAVAILABLE',
  'FIXTURE_ONLY_NATIVE_TOOL_TRANSPORT_UNAVAILABLE',
  'PINNED_TRAINING_PROFILE_NOT_MATERIALIZED',
] as const;

export function fixtureReadiness() {
  return {
    schema: 'veneer-fixture-readiness/v1',
    status: 'STAGED_PREPARATION_ONLY',
    ready: false, execute: false, nativeRuntimeAvailable: false,
    blockers: [...FIXTURE_BLOCKERS],
    providerAcceptanceMs: null, carrierDeliveryMs: null,
  } as const;
}

export function denyFixtureAdmission(): never {
  throw new Error('ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE');
}
