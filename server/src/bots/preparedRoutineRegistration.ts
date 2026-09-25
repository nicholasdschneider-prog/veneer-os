import type { RoutineSetupPacket } from './routineOwnerSetup.js';

// Nonsecret operator preparation only. Null evidence must never become a guessed registration.
export const preparedRoutineRegistration: RoutineSetupPacket = {
  business_id: '5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86',
  account_id: 'orderops-routine-source-5a12b745-9946-44ad-98bf-195fba5d5f30',
  source_origin: 'https://orderops-dev-web-production.up.railway.app',
  client_id: 'fce7a52e84390d9436868abcf769feb1.access',
  audience: '442ea59304e8e0e8da17f18f7f5bdf72645c74398457c9a769ca812586fece82',
  policy_key: 'orderops-product-label-photo-v1',
  policy_request_key: 'routine-photo-policy-339-v1',
  trust_request_key: 'routine-source-registration-v1-5a12b745',
  source_reference: 'BUILD339 routine delivery rollout; existing OrderOps custodian a4bc7b0c-e56a-4b90-b4bc-cb71cbc88e68; new routine source registration',
  policy_text: 'Allow the named bot to send the fixed product-label-photo request only when a complete, current source review establishes that the photo is missing and needed for the current question. Preserve recipient identity, source ownership and lease, relevant human holds, duplicate prevention, uncertain-delivery reconciliation and provider receipt verification. No tracking reply, model-number request, installation-photo request, fit guarantee, refund, replacement, return, financial action or remedy promise is authorized. Sending this request does not resolve the customer case.',
  // Filled only after the source custodian returns reviewed deployment/runtime evidence
  // and the selected executor supplies its own current authenticated identity receipt.
  source: null,
};
