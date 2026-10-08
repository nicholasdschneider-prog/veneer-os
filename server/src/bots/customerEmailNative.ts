import type Database from 'better-sqlite3';
import { canonicalSha256, canonicalJson } from './canonical.js';
import { createBotService, BotError, type Actor } from './service.js';
import { canSendToConversation } from '../conversations/access.js';
import { refuseUnregisteredChat } from './unregisteredChat.js';
import type { UserRow } from '../db/db.js';
import { exactDraftPayload } from './draftPayload.js';
import { emailInput, type EmailInput, type EmailRegistration } from './customerEmailContract.js';
type Row = Record<string, unknown>;
export type EmailMessage = {
    kind: 'direct_message' | 'result_reply' | 'decision_discussion' | 'voice_dispatch' | 'decision_event';
    id: string;
    actor_id: number;
    actor_conversation_id?: string | null;
    text: string;
    created_at: string;
    conversation_id: string;
};
const stamp = (s: string) => Date.parse(/^\d{4}-\d\d-\d\d /.test(s) ? s.replace(' ', 'T') + 'Z' : s);
/** Internal native reader. Uses authenticated native service custody, never provider
 * transcript files. No relation is inferred from case UUIDs or descriptive tickets. */
export function customerEmailNative(db: Database.Database) {
    const bots = createBotService(db);
    function rows(sql: string, ...args: unknown[]): Row[] {
        const xs = db.prepare(sql).all(...args) as Row[];
        if (xs.length > 5000 || Buffer.byteLength(canonicalJson(xs)) > 2000000)
            throw new BotError(409, 'Complete native context exceeds bound; no excerpt review');
        return xs;
    }
    function participant(a: Actor, id: string) {
        const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(a.user.id) as UserRow|undefined;
        if(!user)throw new BotError(403,'Participant access revoked');
        const current={...a,user};
        const c = bots.chat(current, id);
        if (id === a.conversationId) refuseUnregisteredChat(db, id);
        if (c.archived || !c.business_team_id || c.user_id !== a.user.id || !canSendToConversation(user, c, db) || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(a.user.id) || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id))
            throw new BotError(403, 'Original registered participant access revoked');
        return c;
    }
    function snapshot(a: Actor, raw: unknown, executorRead = false, currentAuthorityId?: string) {
        const p = emailInput.parse(raw);
        if (!a.conversationId || a.conversationId !== (executorRead ? p.executor_id : p.source_owner_id))
            throw new BotError(403, 'Original source owner or exact executor required');
        const {locatorRows: _privateLocatorRows, ...result}=collect(a, p, currentAuthorityId);
        return result;
    }
    // Service custody is checked by the dedicated boundary. No bot actor/session is
    // manufactured. Native ACL queries use the enrolled human owner's current ACL.
    function serviceSnapshot(r: EmailRegistration, raw: unknown, currentAuthorityId?: string) {
        const p = emailInput.parse(raw);
        if(p.source_owner_id!==r.sourceOwnerId || p.executor_id!==r.executorId)
            throw new BotError(403,'Exact registered service participants required');
        const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(r.ownerUserId) as UserRow|undefined;
        if(!user)throw new BotError(403,'Service custody owner revoked');
        const n=collect({user},p,currentAuthorityId);
        if(n.businessId!==r.businessId)throw new BotError(403,'Exact registered business required');
        return n;
    }
    function collect(a: Actor, p: EmailInput, currentAuthorityId?: string) {
        const owner = participant(a, p.source_owner_id), executor = participant(a, p.executor_id);
        if (owner.business_team_id !== executor.business_team_id)
            throw new BotError(403, 'Same native business required');
        const business = owner.business_team_id!, chats = [owner.id, executor.id];
        const direct = rows('SELECT * FROM bot_human_messages WHERE conversation_id IN (?,?) ORDER BY created_at,id', ...chats).map(x => ({
            ...x, kind: 'direct_message'
        })) as EmailMessage[];
        const replies = rows('SELECT r.*,t.conversation_id,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id IN (?,?) ORDER BY r.created_at,r.id', ...chats).map(x => ({
            ...x, kind: 'result_reply'
        })) as EmailMessage[];
        const discussion = rows('SELECT t.*,d.conversation_id FROM bot_decision_threads t JOIN bot_decisions d ON d.id=t.decision_id WHERE d.conversation_id IN (?,?) ORDER BY t.created_at,t.id', ...chats).map(x => ({
            ...x, kind: 'decision_discussion'
        })) as EmailMessage[];
        const voice = rows('SELECT * FROM voice_dispatches WHERE conversation_id IN (?,?) ORDER BY created_at,user_id,instruction_id', ...chats).map(x => ({
            ...x, id: `${x.user_id}:${x.instruction_id}`, actor_id: x.user_id, kind: 'voice_dispatch'
        })) as EmailMessage[];
        const events = rows('SELECT e.*,d.conversation_id FROM bot_decision_events e JOIN bot_decisions d ON d.id=e.decision_id WHERE d.conversation_id IN (?,?) ORDER BY e.created_at,e.id', ...chats);
        const eventMessages = events.filter(e => !e.actor_conversation_id && e.actor_id !== null).map(e => ({
            ...e, text: String(e.payload_json), kind: 'decision_event'
        })) as EmailMessage[];
        const messages = [...direct, ...replies, ...discussion, ...voice, ...eventMessages];
        if (messages.some(m => !Number.isFinite(stamp(m.created_at))))
            throw new BotError(409, 'Native chronology missing');
        const source = messages.find(m => m.conversation_id === owner.id && m.kind === p.source_kind && m.id === p.source_id && !m.actor_conversation_id);
        if (!source)
            throw new BotError(409, 'Exact authenticated original human source required');
        const author = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(source.actor_id) as UserRow | undefined;
        if (!author || !canSendToConversation(author, owner, db) || !canSendToConversation(author, executor, db))
            throw new BotError(403, 'Human direction author access revoked');
        const drafts = rows('SELECT * FROM bot_message_drafts WHERE conversation_id IN (?,?) ORDER BY id', ...chats);
        const d = drafts.find(x => x.id === p.draft_id && x.conversation_id === executor.id);
        if (!d || d.version !== p.draft_version || d.authorized_by !== null || d.claim_key !== null || d.receipt !== null || d.decision_id !== null || d.delegation_id !== null || d.state !== 'draft')
            throw new BotError(409, 'Exact untouched executor ordinary draft/version required');
        const storedPayload = JSON.parse(String(d.payload_json));
        const payload = exactDraftPayload.parse(storedPayload);
        if (canonicalSha256(payload) !== canonicalSha256(storedPayload))
            throw new BotError(409, 'Full unchanged stored payload required; no default or normalization retrofit');
        if (payload.channel !== 'email' || payload.recipients.length !== 1 || payload.attachments.length || !/^\S+@\S+\.\S+$/.test(payload.account) || !/^\S+@\S+\.\S+$/.test(payload.recipients[0]!))
            throw new BotError(409, 'One recipient plain customer email without attachments required');
        const decisions = rows('SELECT * FROM bot_decisions WHERE conversation_id IN (?,?) ORDER BY id', ...chats);
        const threads = rows('SELECT * FROM bot_message_threads WHERE conversation_id IN (?,?) ORDER BY id', ...chats);
        // Missing media is explicit. Text ingress has no trusted media review manifest.
        // Never regard a caller assertion that images were reviewed as actual byte review.
        const unreviewedMedia: string[] = [];
        const mediaMarker = /!\[|(?:\/uploads\/|\/attachments\/|\[.*?\]\([^)]*\.(?:png|jpe?g|webp|pdf|docx)|\[Attached|\[Uploaded|Attached files \(saved on this server|\/Users\/[^\s]+|\/home\/[^\s]+)/i;
        for (const m of messages)
            if (mediaMarker.test(m.text))
                unreviewedMedia.push(`${m.kind}:${m.id}`);
        for(const thread of threads){
            if(!thread.anchor||!thread.source_text)throw new BotError(409,'Complete retained original result anchor required');
            if(mediaMarker.test(String(thread.source_text)))unreviewedMedia.push(`result_anchor:${thread.id}`);
        }
        for (const d of decisions) {
            const proposal = JSON.parse(String(d.proposal_json));
            for (const e of [...(proposal.evidence ?? []), ...(proposal.images ?? []), ...(proposal.evidence_items ?? [])]) {
                const chat = e.conversation_id ?? e.source?.conversation_id;
                if (chat)
                    bots.chat(a, chat);
                if (e.path || e.kind === 'image' || e.kind === 'document')
                    unreviewedMedia.push(`decision:${d.id}`);
            }
        }
        for (const e of events) {
            const value = JSON.parse(String(e.payload_json)), proposal = value.proposal ?? value;
            for (const ref of [...(proposal.evidence ?? []), ...(proposal.images ?? []), ...(proposal.evidence_items ?? [])]) {
                const chat = ref.conversation_id ?? ref.source?.conversation_id;
                if (chat)
                    bots.chat(a, chat);
                if (ref.path || ref.kind === 'image' || ref.kind === 'document')
                    unreviewedMedia.push(`event:${e.id}`);
            }
            if (e.kind === 'human_evidence')
                unreviewedMedia.push(`event:${e.id}`);
        }
        // Entire business inventory is hashes only, including historical membership.
        // Unknown scope always blocks until a dedicated authenticated closure covers it.
        const membership = 'SELECT conversation_id FROM compose_context_memberships WHERE business_id=?';
        const inventory: Array<{
            key: string;
            revision: string;
        }> = [];
        const locatorRows: Array<{key:string; revision:string; row:Row}> = [];
        function add(kind: string, list: Row[], audit: (r: Row) => Row[] = () => []) {
            for (const r of list) {
                const record = {
                    key: `${kind}:${r.id ?? r.draft_id ?? canonicalSha256(r)}`, revision: canonicalSha256({
                        row: r, audit: audit(r)
                    })
                };
                inventory.push(record);
                const locatorRow={...r};
                if(kind==='routine') {
                    const proof=rows('SELECT id,scope_json FROM routine_source_proofs WHERE id=?',r.proof_id);
                    if(proof.length!==1)throw new BotError(409,'Retained routine locator proof missing');
                    locatorRow.locator_proof_id=proof[0]!.id;
                    locatorRow.locator_scope_json=proof[0]!.scope_json;
                }
                locatorRows.push({...record,row:locatorRow});
            }
        }
        add('decision', rows(`SELECT * FROM bot_decisions WHERE conversation_id IN (${membership}) ORDER BY id`, business), r => rows('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY id', r.id));
        add('draft', rows(`SELECT * FROM bot_message_drafts WHERE conversation_id IN (${membership}) ORDER BY id`, business), r => [...rows('SELECT * FROM bot_message_retirements WHERE draft_id=?', r.id), ...rows('SELECT * FROM bot_message_delivery_proofs WHERE draft_id=?', r.id)]);
        add('delegation', rows(`SELECT * FROM bot_message_delegations WHERE owner_conversation_id IN (${membership}) OR executor_conversation_id IN (${membership}) ORDER BY id`, business, business), r => rows('SELECT * FROM bot_message_delegation_events WHERE delegation_id=? ORDER BY id', r.id));
        add('instruction', rows(`SELECT * FROM bot_instruction_obligations WHERE owner_id IN (${membership}) ORDER BY id`, business), r => rows('SELECT * FROM bot_instruction_obligation_revocations WHERE obligation_id=?', r.id));
        add('composition', rows(`SELECT * FROM bot_composed_sms_authorities WHERE owner_id IN (${membership}) OR executor_id IN (${membership}) ORDER BY id`, business, business), r => [
            ...rows('SELECT * FROM bot_composed_sms_events WHERE authority_id=? ORDER BY id', r.id),
            ...rows('SELECT * FROM compose_action_lineages WHERE authority_id=? ORDER BY original_action_digest', r.id),
            ...rows('SELECT * FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?', r.id),
            ...rows('SELECT * FROM bot_composed_sms_associations WHERE authority_id=? ORDER BY id', r.id),
            ...rows('SELECT s.* FROM bot_composed_sms_service_receipts s JOIN bot_composed_sms_associations a ON a.id=s.association_id WHERE a.authority_id=? ORDER BY s.association_id', r.id),
            ...rows('SELECT * FROM compose_scope_reviews WHERE authority_id=? ORDER BY id', r.id),
            ...rows('SELECT v.* FROM compose_scope_revocations v JOIN compose_scope_reviews s ON s.id=v.review_id WHERE s.authority_id=? ORDER BY v.review_id', r.id)
        ]);
        add('routine', rows(`SELECT * FROM routine_draft_authorizations WHERE executor_id IN (${membership}) ORDER BY draft_id`, business), r => [...rows('SELECT * FROM routine_draft_claims WHERE draft_id=?', r.draft_id), ...rows('SELECT * FROM routine_dispatch_claims WHERE draft_id=?',r.draft_id), ...rows('SELECT * FROM routine_delivery_readbacks WHERE draft_id=?', r.draft_id)]);
        add('deleted', rows('SELECT * FROM compose_context_deleted_drafts WHERE business_id=? ORDER BY id', business));
        add('return', rows('SELECT * FROM return_bridge_trust WHERE business_id=? ORDER BY id', business), r => [...rows('SELECT * FROM return_bridge_revocations WHERE trust_id=?', r.id), ...rows('SELECT c.* FROM return_bridge_claims c JOIN return_bridge_mappings m ON m.id=c.mapping_id WHERE m.trust_id=?', r.id)]);
        add('vendor', rows('SELECT * FROM bot_vendor_email_authorities WHERE business_id=? ORDER BY id', business), r => [...rows('SELECT * FROM bot_vendor_email_events WHERE authority_id=? ORDER BY id', r.id), ...rows('SELECT * FROM bot_vendor_email_targets WHERE authority_id=? ORDER BY target_key',r.id), ...rows('SELECT * FROM bot_vendor_email_sources WHERE target_key=? ORDER BY source_kind,source_id',r.target_key)]);
        add('customer_email_enrollment', rows("SELECT *,registration_id AS id FROM customer_email_enrollments WHERE json_extract(evidence_json,'$.businessId')=? ORDER BY registration_id",business), r=>rows('SELECT * FROM customer_email_enrollment_revocations WHERE registration_id=?',r.registration_id));
        add('customer_email', rows('SELECT * FROM customer_email_authorities WHERE business_id=? ORDER BY id', business), r => [
            ...rows(`SELECT * FROM customer_email_events WHERE authority_id=? ${r.id === currentAuthorityId ? "AND kind='revoked'" : ''} ORDER BY id`, r.id),
            ...(r.id === currentAuthorityId ? [] : [
                ...rows('SELECT * FROM customer_email_associations WHERE authority_id=? ORDER BY id', r.id),
                ...rows('SELECT b.* FROM customer_email_readbacks b JOIN customer_email_associations a ON a.id=b.association_id WHERE a.authority_id=? ORDER BY b.id', r.id)
            ])
        ]);
        // Historical lineage rows remain visible even after participant membership changes.
        add('sms_lineage', rows('SELECT *,native_action_id AS id FROM compose_action_lineages WHERE business_id=? ORDER BY original_action_digest', business));
        inventory.sort((x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
        if (inventory.length > 5000 || new Set(inventory.map(x => x.key)).size !== inventory.length)
            throw new BotError(409, 'Complete unique native inventory required');
        const acl = {
            participant_users:rows('SELECT id,role,status FROM users WHERE id IN (?,?) ORDER BY id',owner.user_id,executor.user_id),
            owner: {
                id: owner.id, user_id: owner.user_id, business_team_id: owner.business_team_id, archived: owner.archived, visibility: owner.visibility
            }, executor: {
                id: executor.id, user_id: executor.user_id, business_team_id: executor.business_team_id, archived: executor.archived, visibility: executor.visibility
            }, author: {
                id: author.id, status: author.status, role: author.role
            }, team: rows('SELECT * FROM business_teams WHERE id=?', business), members: rows('SELECT * FROM business_team_members WHERE team_id=? ORDER BY user_id', business), access: rows('SELECT * FROM employee_bot_access WHERE conversation_id IN (?,?) ORDER BY user_id,conversation_id', ...chats), registrations: rows('SELECT * FROM bot_registrations WHERE conversation_id IN (?,?) ORDER BY conversation_id', ...chats)
        };
        const context = {
            direct_messages: direct, result_replies: replies, decision_discussion: discussion, voice_dispatches: voice, human_decision_events: eventMessages, result_anchors: threads, decisions, decision_events: events, drafts, retirements: rows('SELECT r.* FROM bot_message_retirements r JOIN bot_message_drafts d ON d.id=r.draft_id WHERE d.conversation_id IN (?,?) ORDER BY r.draft_id', ...chats)
        };
        if (Buffer.byteLength(canonicalJson({
            context, inventory, acl
        })) > 2000000)
            throw new BotError(409, 'Complete native context exceeds bound');
        const contextRevision = canonicalSha256({
            context, acl
        }), inventoryHash = canonicalSha256(inventory), sourceHash = canonicalSha256(source);
        const later = messages.filter(m => !m.actor_conversation_id && !(m.kind === source.kind && m.id === source.id) && stamp(m.created_at) + (/\.\d+/.test(m.created_at) ? 0 : 999) >= stamp(source.created_at));
        return {
            execute: false as const, ready: false as const, input: p, businessId: business, source, sourceHash, payload, payloadHash: canonicalSha256(payload), context, contextRevision, aclHash:canonicalSha256(acl), inventory, inventoryHash, locatorRows, currentAuthorityKey: currentAuthorityId ? `customer_email:${currentAuthorityId}` : undefined, completedActionKeys: rows('SELECT c.id FROM customer_email_completed_actions c JOIN customer_email_authorities a ON a.id=c.id WHERE a.business_id=?',business).map(x=>`customer_email:${x.id}`).filter(k=>inventory.some(x=>x.key===k)), later_human_context: later, unreviewedMedia, coverage: {
                complete: true, caller_private_voice: false
            }, instructions: 'Original owner must semantically review ALL human context, result anchors, shared voice directions, later corrections, full draft and native records. No keyword consent. Media without trusted actual byte review blocks binding. No withdrawn purchase decision is reopened or used as approval.'
        };
    }
    return {
        snapshot, serviceSnapshot, participant
    };
}
