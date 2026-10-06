import type { ConversationDiscoveryToolDefinition } from './conversationDiscoveryTools.js';
const str = {
    type: 'string'
}, uuid = {
    type: 'string', format: 'uuid'
}, num = {
    type: 'integer', minimum: 1
}, yes = {
    const: true
};
const object = (properties: Record<string, unknown>) => ({
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false
});
const array = (items: unknown) => ({
    type: 'array', items
});
const citation = object({
    kind: {
        enum: ['direct_message', 'result_reply', 'decision_discussion', 'voice_dispatch', 'decision_event']
    }, id: str, text: str
});
const input = {
    source_owner_id: uuid, source_kind: {
        enum: ['direct_message', 'result_reply']
    }, source_id: uuid, executor_id: uuid, draft_id: uuid, draft_version: num
};
const capture = {
    ...input, registration_id: uuid, capture_id: uuid, canonical_case: uuid, canonical_customer: uuid, canonical_order: uuid
};
const review = object({
    reviewed_full_context: yes, interpretation: {
        const: 'unconditional_compose_and_send'
    }, instruction: citation, composition_explanation: str, send_explanation: str, later_context: array(object({
        citation, classification: {
            enum: ['unrelated', 'status_only', 'supersedes', 'ambiguous']
        }, explanation: str
    })), records: array(object({
        key: str, revision: str, classification: {
            enum: ['unrelated', 'current_action', 'blocking']
        }, explanation: str
    })), body_parts: array(object({
        start: {
            type: 'integer', minimum: 0
        }, end: num, human_ids: array(str), evidence: str
    })), unresolved_choices: {
        type: 'array', items: str, maxItems: 0
    }
});
const consume = {
    authority_id: uuid, capture_id: uuid, request_key: str, payload_hash: str
};
const define = (name: string, description: string, p: Record<string, unknown>): ConversationDiscoveryToolDefinition => ({
    name, description, inputSchema: object(p)
});
export const CUSTOMER_EMAIL_TOOLS = [
    define('read_customer_email_direction_context', 'Staged customer-email contract: original registered source-owning bot only. Read exact authenticated direct human/result source, full bounded original owner/executor human/result/shared voice/correction context and original executor draft. Independent of withdrawn purchasing decisions; never reopen or retrofit. Business inventory hashes do not certify unrelatedness. Missing media/context fails closed. No caller-private voice or builder source access.', input),
    define('inspect_customer_email_direction', 'Original source owner only after separate actual-owner technical enrollment and source custody. Supply genuine authenticated canonical case/customer/order and persisted own-source capture UUID; no descriptive-ticket aliases. Read entire native/context/source package. No authority or send. Missing source setup is not missing human consent.', capture),
    define('bind_customer_email_direction', 'Original source owner only: semantic unconditional composition AND send review of full human source, every later human/voice/correction, every authenticated inventory relation and all contiguous exact body spans. Stable original key and exact inspection hash. Append separate prospective authority; ordinary authorized_by, draft/version, retired audit and withdrawn purchase decision stay unchanged. Never keyword consent, bind as builder or borrow identity. UNKNOWN never frees source/action/recipient fence.', {
        ...capture, inspection_hash: str, request_key: str, review
    }),
    define('read_customer_email_direction', 'Original source owner or named executor only: exact authority/reservation/association/provider-acceptance readback and revocation audit. Always execute:false; no fresh key, claim or replay after uncertainty.', {
        authority_id: uuid
    }),
    define('lookup_customer_email_direction', 'Lost bind response: original source owner reads by exact original source kind/ID, draft and unchanged request key. Read-only, no retry entitlement.', {
        source_owner_id: uuid, source_kind: {
            enum: ['direct_message', 'result_reply']
        }, source_id: uuid, draft_id: uuid, request_key: str
    }),
    define('accept_customer_email_direction', 'Original named Grant executor only. Fresh own-principal authenticated source capture and unchanged full payload/version/context/lease/ownership/account/recipient required. Separate acceptance preserves null ordinary authorization. No send.', consume),
    define('claim_customer_email_direction', 'Original named executor only after exact acceptance. Fresh own-principal capture. Native reservation ALWAYS execute:false. Only FIRST authenticated accepted dedicated source service association entitles its fenced intent; never generic Gmail, ordinary draft claim or automatic resend. Lost response uses read only with original key.', consume),
    define('record_customer_email_direction_delivery', 'Original claiming executor only: requests native authenticated source readback of exact original associated intent. No caller provider ID or proof accepted. Exact real Gmail acceptance is SENT_ACCEPTED, not delivery. UNKNOWN/save loss/timeout stays fenced, never another attempt.', {
        authority_id: uuid, claim_id: uuid
    }),
    define('revoke_customer_email_direction', 'Original source owner only: append revocation with stable request key/reason, preserving every source/action/recipient/UNKNOWN fence. Cannot cancel existing reservation/association or grant replacement.', {
        authority_id: uuid, request_key: str, reason: str
    }),
];
export const CUSTOMER_EMAIL_TOOL_ROUTES: Record<string, string> = {
    read_customer_email_direction_context: 'context', inspect_customer_email_direction: 'inspect', bind_customer_email_direction: 'bind', read_customer_email_direction: 'read', lookup_customer_email_direction: 'lookup', accept_customer_email_direction: 'accept', claim_customer_email_direction: 'claim', record_customer_email_direction_delivery: 'receipt', revoke_customer_email_direction: 'revoke'
};
