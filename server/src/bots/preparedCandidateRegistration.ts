// Reviewed new candidate registration; nonsecret, no shipping authority.
export const preparedCandidateManifest = {
  "status": "PROPOSED_NEW_REGISTRATION_NOT_ENROLLED",
  "account_id": "orderops-autoship-candidates-4d9eccb6-ba10-401d-a86b-3bf607ac8a36",
  "source_origin": "https://orderops-dev-web-production.up.railway.app",
  "business_id": "5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86",
  "recipient_id": "1dcb56c5-be80-43c9-9b68-2817b931ecda",
  "runtime": {
    "project": "71cc77d6-9c0d-4770-9d6d-62b8c4bb516c",
    "environment": "530025e2-352d-443c-a8ed-e589fc20621d",
    "service": "ede1932e-b3f9-4e7b-b1be-45804dfbe842"
  },
  "provenance": "New candidate-only source-account proposal by original source custodian under Nick260/Henry303; not a historical account claim. Runtime tuple read-only verified 2026-09-24T17:31:09.774Z.",
  "missing": [
    "Dedicated candidate CF audience/client identity",
    "Genuine current owner registration receipt/source_id"
  ],
  "request_key": "orderops-candidate-registration-v1:b87535be8b1b666100ca0c06cf51a8e48411ffff5e2541e03f33f14c87adface",
  "registration_basis": "New candidate-only source-account proposal by original source custodian under Nick260/Henry303; not a historical account claim. Runtime tuple read-only verified 2026-09-24T17:31:09.774Z.",
  "boundary": {
    "project": "71cc77d6-9c0d-4770-9d6d-62b8c4bb516c",
    "environment": "530025e2-352d-443c-a8ed-e589fc20621d",
    "service": "ede1932e-b3f9-4e7b-b1be-45804dfbe842",
    "source_origin": "https://orderops-dev-web-production.up.railway.app"
  },
  "principal_evidence": "Existing native AutoShip worker; current owner, business and active registration verified at confirmation. No shipping credential is granted."
} as const;
export const preparedCandidatePayload = {
  "business_id": "5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86",
  "recipient_id": "1dcb56c5-be80-43c9-9b68-2817b931ecda",
  "account_id": "orderops-autoship-candidates-4d9eccb6-ba10-401d-a86b-3bf607ac8a36",
  "source_origin": "https://orderops-dev-web-production.up.railway.app",
  "request_key": "orderops-candidate-registration-v1:b87535be8b1b666100ca0c06cf51a8e48411ffff5e2541e03f33f14c87adface",
  "client_id": "3708f79a27190976c9eb17432c40a015.access",
  "audience": "c0ada1a091ec82e0db0f1a80637f1055a1c2b9bdf1b19da451727ebbdb0e756d"
} as const;
