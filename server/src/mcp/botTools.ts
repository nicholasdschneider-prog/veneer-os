import type { ConversationDiscoveryToolDefinition } from './conversationDiscoveryTools.js';
const str = { type: 'string' };
const evidence = {
  type: 'array',
  items: {
    type: 'object',
    properties: { label: str, conversation_id: str },
    required: ['label', 'conversation_id'],
    additionalProperties: false,
  },
};
const messagePayload = {type:'object',properties:{channel:{type:'string',enum:['email','sms','slack','customer_portal']},account:str,recipients:{type:'array',items:str},subject:str,body:str,customer:str,ticket:str,context:str,attachments:{type:'array',items:{type:'object',properties:{name:str,reference:str,sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['name','reference','sha256'],additionalProperties:false}}},required:['channel','account','recipients','subject','body','customer','ticket','context','attachments'],additionalProperties:false};
const messageScope = {type:'object',properties:{canonical_case:str,executor_conversation_id:str,payload:messagePayload},required:['canonical_case','executor_conversation_id','payload'],additionalProperties:false};
const sendCheck = {type:'object',properties:{payload_hash:str,material_evidence_unchanged:{type:'boolean',enum:[true]},recipient_account_case_verified:{type:'boolean',enum:[true]},lease_and_duplicates_checked:{type:'boolean',enum:[true]},evidence:str},required:['payload_hash','material_evidence_unchanged','recipient_account_case_verified','lease_and_duplicates_checked','evidence'],additionalProperties:false};
const deliveryProof = {type:'object',properties:{provider:str,provider_message_id:str,account:str,recipients:{type:'array',items:str},canonical_case:str,payload_hash:str,idempotency_key:str,verified:{type:'boolean',enum:[true]}},required:['provider','provider_message_id','account','recipients','canonical_case','payload_hash','idempotency_key','verified'],additionalProperties:false};
const proposal = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'A short plain-English customer issue and the decision needed. Write for a customer-service teammate, not an engineer. Include the order number when known; keep case keys in source_key.' },
    recommendation: { type: 'string', description: 'In 1–3 short sentences, say what you propose to do and why. Preserve verified facts, uncertainty and meaningful dates. Do not include lease, CAS, provider, CASE LOG or execution-protocol jargon. Do not paste the full customer email here.' },
    consequence: { type: 'string', description: 'Plain-English impact and limits: exact amount/currency if relevant, what approval does and does not authorize, unresolved facts, and estimates versus confirmed dates. Keep every material condition; do not turn an estimate into a promise or task completion into case resolution.' },
    assignee_id: { type: 'integer' },
    team: str,
    deadline: {
      type: ['string', 'null'],
      description: 'Real ISO deadline, or null.',
    },
    evidence,
    message_delivery: {...messageScope, description: 'Explicit customer-message send scope reviewed as part of this proposal: exact full payload, canonical_case equal to payload.ticket, and one named executor. Used only for owner-delegated delivery after human approval. Do not add retroactively to an approved legacy proposal or infer missing account/recipient/attachments from prose. Do not simultaneously authorize the same send through a separate draft.'},
    images: { type: 'array', maxItems: 12, description: 'Attach actual retained case photos to the detailed Needs input card. Use an exact absolute path detected in the named source conversation (created/downloaded session file or supplied attachment); never URLs, guessed files, or another case’s photos. Retain authorized OrderOps image bytes through its existing connection first. source identifies the customer/bot/ticket and provenance. Server binds the bytes to this proposal version; changed bytes require a revised proposal. Omit sha256 for new images; preserve returned hashes when unchanged. Existing text-only decisions are not automatically searched for photos.', items: { type: 'object', properties: { conversation_id: str, path: str, label: str, source: str, sha256: {type:'string',pattern:'^[a-f0-9]{64}$'} }, required: ['conversation_id','path','label','source'], additionalProperties: false } },
    choices: { type: 'array', minItems: 2, maxItems: 6, description: 'Offer concise contextual buttons for a bounded human decision. Every choice explicitly maps to approve, reject, defer, or withdraw. Hold/Not now must never approve. Omit for default buttons.', items: { type: 'object', properties: { id: {type:'string', pattern:'^[a-zA-Z0-9_-]{1,64}$'}, label:{type:'string', maxLength:120}, description:{type:'string',maxLength:300}, action:{type:'string',enum:['approve','reject','defer','withdraw']} }, required:['id','label','action'], additionalProperties:false } },
    blocked_action: { type: 'string', description: 'Complete action, execution requirements and approval conditions. Put internal protocol here, not in the human-facing fields. If proposing an exact customer message, append EXACT DRAFT: followed by the complete verbatim message at the end. Nothing after the draft except the draft itself; the UI displays it separately.' },
    blocks_scope: { type: 'string', enum: ['task', 'workload'] },
    case_timeline: { type: 'array', maxItems: 12,
      description: 'Include 3–8 short case-history highlights when supported by the evidence, oldest first. Cover initial contact, email/SMS or related tickets, replies, refund requests, commitments and verified outcomes. One event per bullet. Never turn a request, promise or proposed action into a completed action. Preserve amounts, uncertainty and the exact known date precision. Do not invent a year, time, actor or bot. This is customer history, not card creation/audit history. Omit if history is unavailable; do not revise a live proposal solely to add presentation data.',
      items: { type: 'object', additionalProperties: false, properties: {
        when: { type: ['string', 'null'], description: 'Evidence-supported date/time label, e.g. Sep 21, 2026 or Aug 24 (year unknown). Include timezone if time is known. Null if date is unknown.' },
        actor: { type: 'string', description: 'Who performed or reported this event: customer name, teammate or bot. Use Unknown if the source does not identify them.' },
        bot: { type: ['string', 'null'], description: 'Bot that actually handled this event, only if supported; otherwise null. Do not attribute every past event to the current card owner.' },
        channel: { type: ['string', 'null'], description: 'Email, SMS, phone or other channel when known.' },
        kind: { type: 'string', enum: ['event', 'request', 'promise', 'proposal'] },
        summary: { type: 'string', description: 'One brief plain-English factual highlight. Distinguish customer reports from independently verified facts.' },
        source: { type: 'string', description: 'Traceable source: message/ticket reference, conversation reference, or precise evidence citation. Required for each highlight.' },
      }, required: ['when', 'actor', 'kind', 'summary', 'source'] } },
    shopify_order: { type: 'object', description: 'For Shopify cases include the verified merchant order number and direct Shopify admin order URL. Do not substitute a case ID or invent an order ID.', properties: { number: str, url: str }, required: ['number', 'url'], additionalProperties: false },
  },
  required: [
    'question',
    'recommendation',
    'consequence',
    'assignee_id',
    'blocked_action',
  ],
  additionalProperties: false,
};
const mutation = {
  decision_id: str,
  expected_version: { type: 'integer' },
  request_key: {
    type: 'string',
    description:
      'Stable unique key for this operation; reuse only for identical retries.',
  },
};
function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ConversationDiscoveryToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const BOT_TOOL_DEFINITIONS = [
  definition('inspect_routine_proof', 'Read the exact native fixed-template scope from a fresh enrolled source proof. Only missing_information has a native contract. No source adapter is connected by release alone. Never create a proof from bot assertions or reuse return credentials. This is read-only, execute=false.', {proof_id:str}, ['proof_id']),
  definition('accept_routine_message', 'Accept your own exact ordinary unapproved draft under an enrolled standing policy and fresh trusted source proof. Preserve the fixed template verbatim, exact scope and version. No human authorized_by is invented; no send or bot wake occurs. Financial/remedy and all unsupported categories remain gated. One immutable source intent per authorization.', {proof_id:str,draft_id:str,expected_version:{type:'integer'},request_key:str}, ['proof_id','draft_id','expected_version','request_key']),
  definition('claim_routine_message', 'Claim an accepted routine draft once with a DIFFERENT fresh source proof of unchanged material and scope. Execute only once when execute=true through the enrolled source dispatcher with its fresh ownership/lease/hold/duplicate guards and returned idempotency key. Direct legacy sends are prohibited. Lost response/unknown effect: reconcile read-only, never retry send or use a new key. Trusted source SENT readback closes delivery; record_message_delivery can only mark routine uncertainty.', {draft_id:str,proof_id:str,claim_key:str}, ['draft_id','proof_id','claim_key']),
  definition('retire_message_draft', 'Retire your own obsolete ordinary nondelegated draft without sending. Requires fresh expected_version, stable request_key, reason and reference evidence. Only draft/queued with no claim is allowed. Preserves original authorization/payload and records separate immutable retirement audit; independent SENT evidence is never this draft delivery. Claimed/sending/sent/uncertain and delegated drafts are rejected. Refresh after a race; never claim merely to close a draft.', {draft_id:str,expected_version:{type:'integer'},request_key:str,reason:str,evidence:str}, ['draft_id','expected_version','request_key','reason','evidence']),
  definition('list_routine_policies', 'List immutable standing-policy enrollment for this exact business and named current bot. Enrollment is not source eligibility or send authority; all categories currently require a trusted source verifier. Never infer business ID from project/name.', {business_id:str}, ['business_id']),
  definition('inspect_routine_message', 'Read-only standing-policy readiness for exact scope. Returns missing proof, never authorizes, claims or sends. Requires policy_id, bounded category and exact scope. Do not fabricate historical enrollment, infer eligibility from caller assertions or request duplicate per-email approval as a workaround. A proof_id from the separately enrolled trusted source may verify the fixed missing-information template. No live source adapter is connected by this release; other categories remain disabled.', {policy_id:str,category:{type:'string',enum:['missing_information','no_order_catalog','unused_return','approved_status_restatement','factual_tracking']},scope:messageScope,proof_id:str}, ['policy_id','category','scope']),
  definition('inspect_approved_message', 'Read-only preflight for an exact approved customer-message delegation. Requires current decision/version. Returns ready=false with concrete missing_proof for legacy prose or absent structural transport scope; do not infer authority, alter approval, or automatically request reapproval.', {decision_id:str,expected_version:{type:'integer'}}, ['decision_id','expected_version']),
  definition('delegate_approved_message', 'Only the active decision-owner bot may delegate an explicitly approved proposal.message_delivery to its exact named executor. Supply the scope verbatim from readback and a stable request key. Preserves original human approval; does not create or send a message, change decision state, or grant connections. One immutable binding per decision version. No legacy prose import. inspect_approved_message first; missing proof stops work.', {decision_id:str,expected_version:{type:'integer'},executor_conversation_id:str,request_key:str,scope:messageScope}, ['decision_id','expected_version','executor_conversation_id','request_key','scope']),
  definition('accept_approved_message', 'Only the named executor accepts an owner delegation, with exact scope and stable request key. Creates one queued draft under the original verified human authority, never a new approval or send. Does not inherit owner credentials. Read the returned draft. The decision owner must complete material checks and existing RUNNING transition before claim; claim needs fresh send_check. No acceptance after revocation or changed scope.', {delegation_id:str,request_key:str,scope:messageScope}, ['delegation_id','request_key','scope']),
  definition('revoke_message_delegation', 'Only the decision-owner bot may revoke its message delegation. Revocation is immutable and blocks new claims; it cannot recall a provider side effect. If already claimed, reconcile the provider and do not resend.', {delegation_id:str,request_key:str,reason:str}, ['delegation_id','request_key','reason']),
  definition('save_message_draft', 'Prepare an editable outgoing message for human review in this chat or a Needs input card. Include exact channel/account/recipients, customer and ticket identifiers, full body, and attachment references. No send occurs. For a decision include its current decision_id and decision_version. Keep message approval separate from refunds and other actions. Do not also authorize this separate draft through an EXACT DRAFT section of blocked_action. Use a new request key for a revised draft; do not create duplicate drafts after an uncertain send.', {request_key:str,decision_id:str,decision_version:{type:'integer'},payload:{type:'object',properties:{channel:{type:'string',enum:['email','sms','slack','customer_portal']},account:str,recipients:{type:'array',items:str},subject:str,body:str,customer:str,ticket:str,context:str,attachments:{type:'array',items:{type:'object',properties:{name:str,reference:str},required:['name','reference'],additionalProperties:false}}},required:['channel','account','recipients','body','customer','ticket'],additionalProperties:false}}, ['request_key','payload']),
  definition('list_message_drafts', 'Read this chat’s message drafts, exact versions, human send authorizations, delivery states, and voice briefings. A queued message is not sent. Stale proposal-bound drafts must not execute.', {}, []),
  definition('claim_message_draft', 'For a delegated draft, provide send_check with exact returned payload_hash and truthful fresh material/recipient/account/case/lease/duplicate checks; owner must already have recorded RUNNING. Claim a human-authorized draft exactly once before sending through the existing connected source system. Only execute when execute=true. Recheck the current source, account, recipients and ticket lease. Use returned idempotency_key as the source-system send key. For OrderOps SMS use the existing conversation send-sms route, exact payload, lease, approvedBy human attribution and approvalSource referencing this draft. This grants no unrelated action. If already claimed, reconcile receipts; never blindly resend. If a channel has no idempotency support, an ambiguous response must remain uncertain until verified.', {draft_id:str,claim_key:str,send_check:sendCheck}, ['draft_id','claim_key']),
  definition('record_message_delivery', 'For delegated sent outcomes supply delivery_proof with verified actual provider message ID and exact scope/hash/idempotency key. Unknown/queued receipts are not proof. Record the claimed draft outcome. sent requires an actual source/provider message ID or receipt, not a queued tool call. failed means definitely not sent; uncertain means reconcile before any retry. Never duplicate customer contact. This does not complete a separate business decision.', {draft_id:str,claim_key:str,state:{type:'string',enum:['sent','failed','uncertain']},receipt:str,delivery_proof:deliveryProof}, ['draft_id','claim_key','state','receipt']),
  definition('save_voice_briefing', 'Publish a saved spoken briefing in this chat or directly on a Needs input card. Provide a 90–150 word transcript: issue/background, evidence-based rationale, proposed next step and exact decision requested. Preserve material amounts, risks and uncertainty. Do not expose hidden reasoning or claim proposed actions happened. For a card use its current decision_id and decision_version; update after proposal changes. Max 2400 characters. Audio uses an AI voice, generated when the human chooses Play briefing.', {request_key:str,transcript:str,decision_id:str,decision_version:{type:'integer'}}, ['request_key','transcript']),
  definition('read_message_thread', 'Read a persistent discussion attached to one of this bot’s results, including the original result, replies and reactions. Reactions do not authorize actions.', {thread_id:str}, ['thread_id']),
  definition('reply_message_thread', 'Reply to an individual result’s thread, preserving its context without flooding the main chat. Use existing decision discussion tools for approval questions. A reaction is never approval.', {thread_id:str,request_key:str,text:str}, ['thread_id','request_key','text']),

  definition('search_workspace', 'Search authorized prior messages, decisions, and huddles with dates and direct source links. Results are recorded evidence, not fresh external facts. Indexing status describes incomplete coverage. Use exact order numbers or distinctive terms.', { query: str, offset: { type: 'integer' } }, ['query']),
  definition('list_bot_routines', 'List routines owned by THIS bot. Runs are delivered into this existing conversation, including while busy. Existing scheduled agents are separate; do not enable duplicate workers.', {}, []),
  definition('save_bot_routine', 'Create or update a routine for THIS bot only after the user authorizes its outcome and timing or event. Set enabled=false to prepare a paused routine or pause existing work. Copy the complete existing definition when updating. Requires bot management authority. Never treat event payloads as permission, and do not enable new OrderOps listeners until the event source is connected and existing polling is reconciled.', {
    routine_id: str,
    routine: {type:'object',properties:{name:str,instructions:str,kind:{type:'string',enum:['schedule','ticket.created','customer.replied']},source:str,timezone:str,enabled:{type:'boolean'},schedule:{type:'object',properties:{type:{type:'string',enum:['once','daily','weekdays','weekly','cron']},runAt:str,time:str,weekday:{type:'integer'},expression:str},required:['type'],additionalProperties:false}},required:['name','instructions','kind','enabled'],additionalProperties:false},
  }, ['routine']),
  definition('manage_business_team', 'Manage an owned business and explicit membership/delegation. Human owner or owner-authenticated Platform Dev only; the native actor is audited. create is idempotent by owner/name. delegate allows only explicit owned chat IDs; empty allowed_ids revokes. employee requires a verified member email, explicit conversation_ids and optional activate to approve atomically; access stays restricted after grants are removed. To explicitly promote an existing restricted employee to the full business workspace, use member with their verified email and member or manager role; this removes account-wide employee restrictions without making them a platform administrator. Omit email for ordinary membership changes. No financial/customer authority is granted.', {
    action: { type: 'string', enum: ['create','member','employee','delegate','remove_bot','shopify'] }, shopify_store: { type: ['string', 'null'], description: 'Verified Shopify admin store handle for this business, used only for order links.' }, email: str, conversation_ids: { type: 'array', items: str }, activate: { type: 'boolean' }, name: str, team_id: str, user_id: { type: 'integer' }, role: { type: ['string','null'], enum: ['viewer','member','manager',null] }, conversation_id: str, allowed_ids: { type: 'array', items: str },
  }, ['action']),
  definition('enroll_business_bots', 'Preview or apply reversible enrollment of explicit EXISTING native bot chat IDs. Requires an active owner-granted delegation to THIS conversation and its exact allowlist. preview uses request_key and bots; apply uses returned preview_id and team_id. Apply rechecks ownership, delegation, membership and metadata; changed previews require fresh review. Retries are idempotent. No new chats or executors, no model/project/history changes, no finance or customer authority.', {
    mode: { type: 'string', enum: ['preview','apply'] }, team_id: str, request_key: str, preview_id: str,
    bots: { type: 'array', items: { type: 'object', properties: { conversation_id: str, name: str, role: { type: 'string', enum: ['coordinator','lead','bot'] }, subteam: str, reports_to: { type: ['string','null'] } }, required: ['conversation_id','name','role'], additionalProperties: false } },
  }, ['mode','team_id']),

  definition(
    'raise_decision',
    'Raise a persistent human decision for THIS registered bot. Does not stop unrelated work or grant authority. Dedupe uses source_key + proposal_key. Use conversation evidence references. Release external ticket/case leases with their owning system first, then record park_decision_work. Business fleet enrollment uses explicit delegated preview/apply tools.',
    { source_key: str, proposal_key: str, proposal },
    ['source_key', 'proposal_key', 'proposal'],
  ),
  definition(
    'update_decision',
    'Revise a material proposal or changed evidence. Increments version, clears old approval and requires a fresh human answer. Never execute against a stale version.',
    { ...mutation, proposal },
    [...Object.keys(mutation), 'proposal'],
  ),
  definition(
    'list_decisions',
    'Read THIS bot’s decisions, eligible human approver IDs, and their exact current proposal versions and execution states. Call this before raising the first decision. Pass decision_id for its discussion and audit. A decision is not work completed.',
    { decision_id: str },
    [],
  ),
  definition(
    'reply_to_decision',
    'Reply in a dedicated decision thread as the SAME permanent bot. Your own reply never grants execution authority. Clear eligible human directions can be recorded with record_discussion_decision.',
    { decision_id: str, request_key: str, text: str },
    ['decision_id', 'request_key', 'text'],
  ),
  definition(
    'record_discussion_decision',
    'Record a clear authorized HUMAN instruction from THIS decision thread, without a duplicate UI click. First list_decisions(decision_id) and read the entire message and current proposal. Requires the exact human message ID with instruction_version; server rechecks author, version, latest message, handler and idempotency. Interpret the whole message, never a keyword or quoted fragment. Approve only unconditional explicit consent to the current scope; reject/withdraw only clear directions. A clear request to investigate/revise first may defer the current proposal, without execution authority; perform that follow-up then ask about materially changed proposals. Questions, quoted customer statements, negations, conditional or ambiguous messages require clarification via reply_to_decision, not this tool. No historic replay, no invented human identity, no standing authority. Report the recorded state, never completion. Existing financial and action safeguards still apply.',
    { decision_id: str, message_id: str, expected_version: { type: 'integer' }, action: { type: 'string', enum: ['approve', 'reject', 'defer', 'withdraw'] } },
    ['decision_id', 'message_id', 'expected_version', 'action'],
  ),
  definition(
    'record_decision_result',
    'Record running before executing an approved current version, with material_evidence_unchanged=true after checking evidence. Then record verified_completed, blocked or failed with concrete evidence. Existing money, policy and tool approval gates remain required; a standing rule answer does not broaden authority.',
    {
      ...mutation,
      state: {
        type: 'string',
        enum: ['running', 'verified_completed', 'blocked', 'failed'],
      },
      evidence: str,
      material_evidence_unchanged: { type: 'boolean' },
    },
    [...Object.keys(mutation), 'state', 'evidence'],
  ),
  definition(
    'park_decision_work',
    'Record that the blocked task is parked and any external leases have ALREADY been released through the owning system. This tool records release receipts, it cannot release third-party leases. Supply released_leases (empty if none) and evidence. Continue unrelated eligible work; task scope does not freeze the bot.',
    {
      ...mutation,
      released_leases: { type: 'array', items: str },
      evidence: str,
    },
    [...Object.keys(mutation), 'released_leases', 'evidence'],
  ),
];
export async function callBotTool({
  name,
  args,
  callApi,
}: {
  name: string;
  args: Record<string, unknown>;
  callApi: (
    path: string,
    init?: RequestInit,
  ) => Promise<Record<string, unknown>>;
}) {
  if (!BOT_TOOL_DEFINITIONS.some((t) => t.name === name)) return null;
  if (name === 'manage_business_team' || name === 'enroll_business_bots') {
    const result = await callApi(name === 'manage_business_team' ? '/api/bots/teams/manage' : '/api/bots/teams/enroll', { method: 'POST', body: JSON.stringify(args) });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
  if (name === 'search_workspace' || name === 'list_bot_routines' || name === 'save_bot_routine') {
    const result = name === 'search_workspace'
      ? await callApi(`/api/bot-workflows/search?q=${encodeURIComponent(String(args.query ?? ''))}&offset=${Number(args.offset ?? 0)}`)
      : await callApi('/api/bot-workflows/current/routines', name === 'save_bot_routine' ? { method: 'POST', body: JSON.stringify(args) } : undefined);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
  const communicationRoutes: Record<string,string> = {
    inspect_routine_proof: '/routine-messages/proof', accept_routine_message: '/routine-messages/accept', claim_routine_message: '/routine-messages/claim',
    list_routine_policies: '/routine-policies/list', inspect_routine_message: '/routine-policies/inspect',
    inspect_approved_message: '/approved-messages/inspect', delegate_approved_message: '/approved-messages/delegate',
    accept_approved_message: '/approved-messages/accept', revoke_message_delegation: '/approved-messages/revoke',
    save_message_draft: '/chats/current/drafts', list_message_drafts: '/chats/current',
    retire_message_draft: `/drafts/${encodeURIComponent(String(args.draft_id))}/retire`,
    claim_message_draft: `/drafts/${encodeURIComponent(String(args.draft_id))}/claim`,
    record_message_delivery: `/drafts/${encodeURIComponent(String(args.draft_id))}/receipt`,
    save_voice_briefing: '/chats/current/briefings',
    read_message_thread: `/threads/${encodeURIComponent(String(args.thread_id))}`,
    reply_message_thread: `/threads/${encodeURIComponent(String(args.thread_id))}/replies`,
  };
  if (communicationRoutes[name]) {
    const {draft_id,thread_id,...payload}=args;
    const result=await callApi('/api/bot-communication'+communicationRoutes[name], ['list_message_drafts','read_message_thread'].includes(name)?undefined:{method:'POST',body:JSON.stringify(['accept_routine_message','claim_routine_message'].includes(name)?args:payload)});
    return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
  }
  const { decision_id, ...body } = args;
  const base = '/api/bots/decisions';
  const target = `${base}/${encodeURIComponent(String(decision_id ?? ''))}`;
  const routes: Record<string, string> = {
    raise_decision: base,
    update_decision: `${target}/proposal`,
    reply_to_decision: `${target}/thread`,
    record_decision_result: `${target}/result`,
    record_discussion_decision: `${target}/discussion-decision`,
    park_decision_work: `${target}/park`,
  };
  const result =
    name === 'list_decisions'
      ? await callApi(decision_id ? target : '/api/bots')
      : await callApi(routes[name]!, {
          method: 'POST',
          body: JSON.stringify(body),
        });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
