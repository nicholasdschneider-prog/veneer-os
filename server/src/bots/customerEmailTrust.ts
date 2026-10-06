import { CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH } from './customerEmailArtifact.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError, type Actor } from './service.js';
import { canonicalSha256, canonicalJson } from './canonical.js';
import { EMAIL_CONTRACT_HASH, emailRegistry, emailRegistration, type EmailRegistration, emailKey, emailId } from './customerEmailContract.js';
import { z } from 'zod';
export function emailUnavailable(): never {
    throw new BotError(503, 'CUSTOMER_EMAIL_CUSTODY_REQUIRED: separate accepted source artifact, dedicated reader/service trust and actual owner enrollment required');
}
export function loadEmailRegistry(file: string | null | undefined) {
    let fd: number | undefined;
    try {
        if (!file || !path.isAbsolute(file))
            return emailUnavailable();
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 128 * 1024)
            return emailUnavailable();
        return emailRegistry.parse(JSON.parse(fs.readFileSync(fd, 'utf8')));
    }
    catch {
        return emailUnavailable();
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
export function emailBearer(header: unknown, r: EmailRegistration) {
    if (typeof header !== 'string' || !/^Bearer [^\s]{32,512}$/.test(header))
        return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(header.slice(7)).digest(), Buffer.from(r.serviceBearerHash, 'hex'));
}
export function emailRegistrationCurrent(db: Database.Database, r: EmailRegistration, now: number, enrolled = true) {
    emailRegistration.parse(r);
    if(r.prebindCapability && (r.prebindCapability.input.source_owner_id!==r.sourceOwnerId || r.prebindCapability.input.executor_id!==r.executorId))
        throw new BotError(403,'Prebind capability participant scope differs');
    const credentials = [r.sourceCredential, r.executorCredential, r.serviceReadCredential].map(c => canonicalSha256(c));
    if (new Set(credentials).size !== 3 || new Set([r.sourcePrincipalId, r.executorPrincipalId, r.servicePrincipalId]).size !== 3 || r.sourceOwnerId === r.executorId)
        throw new BotError(403, 'Distinct original participant and dedicated service custody required');
    if (!Number.isFinite(now) || !r.active || r.contractHash !== EMAIL_CONTRACT_HASH || r.nativeArtifactHash !== CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH || Date.parse(r.acceptedAt) > now || Math.min(...[r.expiresAt, r.credentialExpiresAt, r.readbackExpiresAt, r.custodyExpiresAt].map(Date.parse)) <= now)
        throw new BotError(403, 'Customer email trust revoked, unaccepted or expired');
    const team = db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as {
        owner_id: number;
    } | undefined;
    if (team?.owner_id !== r.ownerUserId || r.executorUserId !== r.ownerUserId || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active' AND role='owner'").get(r.ownerUserId))
        throw new BotError(403, 'Customer email owner identity changed');
    for (const id of [r.sourceOwnerId, r.executorId]) {
        const c = db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(id) as {
            user_id: number;
            business_team_id: string;
            archived: number;
        } | undefined;
        if (!c || c.user_id !== r.ownerUserId || c.business_team_id !== r.businessId || c.archived || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id))
            throw new BotError(403, 'Customer email participant binding changed');
    }
    const h = canonicalSha256(r);
    if (enrolled) {
        const e = db.prepare('SELECT registration_hash FROM customer_email_enrollments WHERE registration_id=?').get(r.id) as {
            registration_hash: string;
        } | undefined;
        if (e?.registration_hash !== h || db.prepare('SELECT 1 FROM customer_email_enrollment_revocations WHERE registration_id=?').get(r.id))
            return emailUnavailable();
    }
    return h;
}
export function emailEnrollment(db: Database.Database, registration: (id: string) => EmailRegistration, now = Date.now) {
    function owner(a: Actor, r: EmailRegistration) {
        if (a.conversationId || a.user.id !== r.ownerUserId || a.user.role !== 'owner')
            throw new BotError(403, 'Actual authenticated human platform/business owner only');
        return emailRegistrationCurrent(db, r, now(), false);
    }
    return {
        prepare(a: Actor, raw: unknown) {
            const p = z.object({
                registration_id: emailId
            }).strict().parse(raw), r = registration(p.registration_id), h = owner(a, r);
            return {
                execute: false, registration: r, registration_hash: h, confirmation_hash: canonicalSha256({
                    registration: r, owner: a.user.id
                }), instructions: 'Review exact dedicated custody, artifacts, guards and source adoption. Optional prebindCapability grants only the pinned original source/draft read plus explicitly declared complete-business minimized structured locator inventory. No native human transcript export; unknown references remain unresolved. Existing enrollment does not inherit this capability. Confirmation enrolls technical trust only; no customer action or native restart.'
            };
        }, confirm(a: Actor, raw: unknown) {
            const p = z.object({
                registration_id: emailId, confirmation_hash: z.string(), request_key: emailKey
            }).strict().parse(raw);
            return db.transaction(() => {
                const r = registration(p.registration_id), h = owner(a, r);
                if (p.confirmation_hash !== canonicalSha256({
                    registration: r, owner: a.user.id
                }))
                    throw new BotError(409, 'Registration changed');
                if (db.prepare('SELECT 1 FROM customer_email_enrollment_revocations WHERE registration_id=?').get(r.id))
                    throw new BotError(409, 'Enrollment permanently revoked');
                const old = db.prepare('SELECT * FROM customer_email_enrollments WHERE registration_id=? OR request_key=?').get(r.id, p.request_key) as {
                    registration_id: string;
                    registration_hash: string;
                    request_key: string;
                } | undefined;
                if (old) {
                    if (old.registration_id !== r.id || old.registration_hash !== h || old.request_key !== p.request_key)
                        throw new BotError(409, 'Conflicting enrollment');
                }
                else
                    db.prepare('INSERT INTO customer_email_enrollments VALUES(?,?,?,?,?,?)').run(r.id, h, a.user.id, p.request_key, canonicalJson(r), new Date(now()).toISOString());
                return {
                    execute: false, registration_id: r.id, registration_hash: h, enrolled: true
                };
            }).immediate();
        }, revoke(a: Actor, raw: unknown) {
            const p = z.object({
                registration_id: emailId, reason: z.string().min(20).max(3000)
            }).strict().parse(raw), r = registration(p.registration_id);
            owner(a, r);
            db.prepare('INSERT OR IGNORE INTO customer_email_enrollment_revocations VALUES(?,?,?,?)').run(r.id, a.user.id, p.reason, new Date(now()).toISOString());
            return {
                execute: false, revoked: true
            };
        }
    };
}
