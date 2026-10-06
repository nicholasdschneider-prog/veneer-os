import type { AppContext } from '../context.js';
import { readSecretValue } from '../secrets/readSecret.js';
import { boundedResolverGet } from './approvedCaseResolver.js';
import { canonicalSha256, canonicalJson } from './canonical.js';
import { BotError, type Actor } from './service.js';
import { loadEmailRegistry, emailRegistrationCurrent } from './customerEmailTrust.js';
import { emailCapture, emailIntent, type EmailCaptureInput, type EmailRegistration, type EmailCapture, type EmailProjection } from './customerEmailContract.js';
import type { customerEmailNative } from './customerEmailNative.js';
export type EmailNativeSnapshot = ReturnType<ReturnType<typeof customerEmailNative>['snapshot']>;
export interface EmailIO {
    now: () => number;
    registration: (id: string) => EmailRegistration;
    capture: (a: Actor | null, p: EmailCaptureInput, n: EmailNativeSnapshot, r: EmailRegistration) => Promise<{
        wire: EmailCapture;
        assertFresh: () => void;
    }>;
    intent: (r: EmailRegistration, id: string) => Promise<unknown>;
}
export function emailSourceIO(ctx: Pick<AppContext, 'db' | 'config' | 'projectDopplerCli'>): EmailIO {
    const registration = (id: string) => {
        const xs = loadEmailRegistry(ctx.config.customerEmailRegistryFile).registrations.filter(r => r.id === id);
        if (xs.length !== 1)
            throw new BotError(503, 'Exact customer email registration unavailable');
        return xs[0]!;
    };
    async function get(r: EmailRegistration, credential: EmailRegistration['sourceCredential'], url: string) {
        const hash = emailRegistrationCurrent(ctx.db, registration(r.id), Date.now());
        const secret = (await readSecretValue({
            db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null
        }, credential)).value;
        if (emailRegistrationCurrent(ctx.db, registration(r.id), Date.now()) !== hash)
            throw new BotError(403, 'Custody changed');
        let value: unknown;
        try {
            value = await boundedResolverGet(url, secret, AbortSignal.timeout(10000));
        }
        catch {
            throw new BotError(503, 'Authenticated customer email source read unavailable; no credential or source error disclosed');
        }
        if (emailRegistrationCurrent(ctx.db, registration(r.id), Date.now()) !== hash)
            throw new BotError(403, 'Custody changed');
        return value;
    }
    return {
        now: Date.now, registration, async capture(a, p, n, r) {
            let principal = r.executorPrincipalId, credential = r.serviceReadCredential;
            if (a) {
                if (a.user.id !== r.ownerUserId || ![r.sourceOwnerId, r.executorId].includes(a.conversationId!))
                    throw new BotError(403, 'Exact own-principal source reader only');
                const owner = a.conversationId === r.sourceOwnerId;
                principal = owner ? r.sourcePrincipalId : r.executorPrincipalId;
                credential = owner ? r.sourceCredential : r.executorCredential;
            }
            const wire = emailCapture.parse(await get(r, credential, `${r.sourceOrigin}/api/cs/customer-email-direction/captures/${p.capture_id}`));
            const received = Date.now(), regHash = canonicalSha256(r);
            const assertFresh = () => {
                if (emailRegistrationCurrent(ctx.db, registration(r.id), Date.now()) !== regHash)
                    throw new BotError(403, 'Customer email registration drift');
                validateEmailCapture(wire, p, n, r, principal, Date.now());
                if (Date.now() - received > 5000 || Date.now() < received)
                    throw new BotError(409, 'Customer email source read expired');
            };
            assertFresh();
            return {
                wire, assertFresh
            };
        }, async intent(r, id) {
            return emailIntent.parse(await get(r, r.serviceReadCredential, `${r.sourceOrigin}/api/cs/customer-email-direction/intents/${id}`));
        }
    };
}
export function validateEmailCapture(w: EmailCapture, p: EmailCaptureInput, n: EmailNativeSnapshot, r: EmailRegistration, principal: string, now: number) {
    const { snapshotHash, ...material } = w;
    if (canonicalSha256(material) !== snapshotHash || w.captureId !== p.capture_id || w.registrationId !== r.id || w.registrationHash !== canonicalSha256(r) || w.sourceRegistrationHash !== r.sourceRegistrationHash || w.guardManifestHash !== r.guardManifestHash || w.sourceArtifactHash !== r.sourceArtifactHash || canonicalJson(w.runtime) !== canonicalJson(r.runtime) || w.businessId !== n.businessId || w.businessId !== r.businessId || w.accountId !== r.sourceAccountId || w.principalId !== principal || w.executorPrincipalId !== r.executorPrincipalId || w.caseOwnerPrincipalId !== r.executorPrincipalId || w.canonicalCaseId !== p.canonical_case || w.canonicalCustomerId !== p.canonical_customer || w.canonicalOrderId !== p.canonical_order || w.payloadHash !== n.payloadHash || w.payloadAccount !== n.payload.account || w.payloadAccount !== r.payloadAccount || w.recipient !== n.payload.recipients[0] || w.contextRevision !== n.contextRevision || w.inventoryHash !== n.inventoryHash)
        throw new BotError(409, 'Authenticated canonical identity, full payload, native context or source custody mismatch');
    const observed = Date.parse(w.observedAt), expiry = Date.parse(w.expiresAt);
    if (observed > now + 5000 || now - observed > 15000 || expiry <= now || expiry - observed > 15000 || expiry <= observed || Date.parse(w.leaseExpiresAt) <= now || expiry > Math.min(...[r.expiresAt, r.credentialExpiresAt, r.custodyExpiresAt, r.readbackExpiresAt].map(Date.parse)))
        throw new BotError(409, 'Fresh source, lease and custody evidence required');
    if (w.records.length !== n.inventory.length || new Set(w.records.map(x => x.key)).size !== w.records.length)
        throw new BotError(409, 'Complete unique native scope coverage required');
    for (const item of n.inventory) {
        const record = w.records.find(x => x.key === item.key);
        if (!record || record.revision !== item.revision || ['blocking', 'unknown'].includes(record.relation) || (record.relation === 'current_action' && item.key !== `draft:${p.draft_id}`))
            throw new BotError(409, 'Unreviewed, overlapping or stale native scope remains blocking');
    }
    if (w.records.find(x => x.key === `draft:${p.draft_id}`)?.relation !== 'current_action' || n.unreviewedMedia.length)
        throw new BotError(409, 'Current draft or actual native media coverage unavailable');
}
export function emailCaptureMatchesProjection(w: EmailCapture, t: EmailProjection) {
    if (w.materialHash !== t.materialHash || w.scopeHash !== t.scopeHash || w.identityHash !== t.identityHash || w.crossActionFenceHash !== t.crossActionFenceHash || w.canonicalCaseId !== t.canonicalCaseId || w.canonicalCustomerId !== t.canonicalCustomerId || w.canonicalOrderId !== t.canonicalOrderId || w.orderNumber !== t.orderNumber || w.shopifyOrderId !== t.shopifyOrderId)
        throw new BotError(409, 'Source material, identity, scope or duplicate fences changed');
}
