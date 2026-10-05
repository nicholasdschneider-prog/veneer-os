import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { z } from 'zod';

const id = z.string().regex(/^fixture-[a-z0-9-]{1,90}$/);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ runId: id, sessionId: id, customerId: id, orderId: id }).strict();
export const SnapshotSchema = z.object({
  roleConversationId: z.string().uuid(), version: z.number().int().positive(),
  // Publication by the authenticated human owner approves these exact synthetic role bytes.
  // This is not an import/attestation of historical ordinary-chat training.
  syntheticOnly: z.literal(true), bytes: z.string().min(1).max(16_000),
}).strict();
export const CouplingSchema = z.object({
  snapshotId: z.string().uuid(), setupId: z.string().uuid(),
  sessions: z.array(z.object({ sessionId: id, customerId: id, orderId: id }).strict()).min(1).max(10),
}).strict().superRefine((v, ctx) => {
  for (const field of ['sessionId', 'customerId', 'orderId'] as const)
    if (new Set(v.sessions.map(s => s[field])).size !== v.sessions.length)
      ctx.addIssue({ code: 'custom', message: 'Shared session scope' });
});
export const CallSchema = z.object({
  sessionId: id, customerId: id, orderId: id, messageId: id,
  tool: z.enum(['fixture.order.read', 'fixture.preference.set', 'fixture.sms.accept',
    'fixture.handoff', 'fixture.cancel.request', 'fixture.refund.request']),
  arguments: z.record(z.unknown()),
}).strict();
const hash = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.entries(v).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}' : JSON.stringify(v);
const equal = (a: string, b: string) => a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const nativeSchema = z.object({
  schema: z.literal('veneer-codex-preauth/v1'), nativeAdmission: z.literal(false),
  cliVersion: z.literal('codex-cli 0.145.0'),
  cliSha256: z.literal('1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590'),
  protectedCredentialBoundaryReady: z.literal(false),
  profiles: z.object({ worker: z.object({ sha256: hex, policy: z.string() }),
    'dedicated-auth': z.object({ sha256: hex, policy: z.string() }) }),
}).passthrough();
type Envelope = { payload: Record<string, unknown>; mac: string };

function directory(target: string) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      fs.realpathSync(target) !== path.resolve(target)) throw new Error('FIXTURE_PRIVATE_STORAGE_REQUIRED');
  fs.chmodSync(target, 0o700);
}
function privateFile(target: string) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
    throw new Error('FIXTURE_PRIVATE_STORAGE_REQUIRED');
}

/** Dedicated fixture supervisor, no business DB, shared adapter, agents, browser,
 * connectors, secrets service, model requests or actual login. */
export class CodexFixtureSetup {
  readonly db: Database.Database;
  private readonly authority: Buffer;
  private readonly root: string;
  private busy = false;
  constructor(root: string, private readonly sourceDir: string) {
    directory(root); this.root = root;
    const authority = path.join(root, 'authority.key');
    if (!fs.existsSync(authority)) fs.writeFileSync(authority, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    privateFile(authority); this.authority = fs.readFileSync(authority);
    if (this.authority.length !== 32) throw new Error('FIXTURE_AUTHORITY_UNAVAILABLE');
    const file = path.join(root, 'coupling.sqlite');
    if (fs.existsSync(file)) privateFile(file);
    this.db = new Database(file); fs.chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, owner INTEGER NOT NULL,
        kind TEXT NOT NULL, request_key TEXT NOT NULL, input_hash TEXT NOT NULL, envelope TEXT NOT NULL,
        UNIQUE(owner,kind,request_key));
      CREATE TABLE IF NOT EXISTS intents(run TEXT NOT NULL, session TEXT NOT NULL,
        message TEXT NOT NULL, tool TEXT NOT NULL, payload_hash TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(run,session,message,tool));
      CREATE TABLE IF NOT EXISTS outcomes(intent TEXT PRIMARY KEY, envelope TEXT NOT NULL);
      ${['records','intents','outcomes'].map(t => `
        CREATE TRIGGER IF NOT EXISTS ${t}_immutable_update BEFORE UPDATE ON ${t}
          BEGIN SELECT RAISE(ABORT,'immutable_fixture_record'); END;
        CREATE TRIGGER IF NOT EXISTS ${t}_immutable_delete BEFORE DELETE ON ${t}
          BEGIN SELECT RAISE(ABORT,'immutable_fixture_record'); END;`).join('')}
    `);
  }
  close() { this.db.close(); this.authority.fill(0); }
  private sign(payload: Record<string, unknown>): Envelope {
    return { payload, mac: crypto.createHmac('sha256', this.authority).update('lineage/v1\0' + canonical(payload)).digest('hex') };
  }
  private verify(envelope: Envelope) {
    if (!equal(this.sign(envelope.payload).mac, envelope.mac)) throw new Error('FIXTURE_LINEAGE_AUTH_FAILED');
    return envelope.payload;
  }
  private row(owner: number, recordId: string, kind: string) {
    const row = this.db.prepare('SELECT envelope FROM records WHERE id=? AND owner=? AND kind=?')
      .get(recordId, owner, kind) as { envelope: string } | undefined;
    if (!row) throw new Error('FIXTURE_MATERIAL_NOT_FOUND');
    return this.verify(JSON.parse(row.envelope) as Envelope);
  }
  private previous(owner: number, kind: string, requestKey: string, input: unknown): Envelope | undefined {
    key.parse(requestKey);
    const row = this.db.prepare('SELECT input_hash,envelope FROM records WHERE owner=? AND kind=? AND request_key=?')
      .get(owner,kind,requestKey) as { input_hash: string; envelope: string } | undefined;
    if (!row) return;
    if (row.input_hash !== hash(canonical(input))) throw new Error('FIXTURE_SETUP_INPUT_DRIFT');
    const result = JSON.parse(row.envelope) as Envelope; this.verify(result); return result;
  }
  private record(owner: number, kind: string, requestKey: string, input: unknown, payload: Record<string, unknown>) {
    const envelope = this.sign({ ...payload, owner, createdAt: new Date().toISOString() });
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)')
      .run(payload.id,owner,kind,requestKey,hash(canonical(input)),JSON.stringify(envelope));
    return envelope;
  }
  private async python(script: string, args: string[], input = ''): Promise<string> {
    const filename = path.join(this.sourceDir, 'scripts/fixture-host', script);
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', [filename, ...args], {
        cwd: this.root, env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        detached: true, stdio: ['pipe','pipe','pipe'],
      });
      let output = '', bytes = 0, settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) {
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
          reject(error);
        } else resolve(output);
      };
      const timer = setTimeout(() => finish(new Error('FIXTURE_CHILD_OUTCOME_UNKNOWN')), 30_000);
      child.on('error', () => finish(new Error('FIXTURE_CHILD_UNAVAILABLE')));
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (buffer: Buffer) => {
        bytes += buffer.length;
        if (bytes > 128_000) finish(new Error('FIXTURE_CHILD_OUTPUT_BUDGET'));
        else if (stream === child.stdout) output += buffer.toString('utf8');
        // stderr is discarded, never logged or returned.
      });
      child.on('close', code => finish(code === 0 ? undefined : new Error('FIXTURE_CHILD_FAILED')));
      child.stdin.on('error', () => finish(new Error('FIXTURE_CHILD_OUTCOME_UNKNOWN')));
      child.stdin.end(input);
    });
  }
  async setup(owner: number, requestKey: string) {
    const previous = this.previous(owner,'setup',requestKey,{});
    if (previous) return previous;
    if (this.previous(owner,'setup-intent',requestKey,{})) throw new Error('FIXTURE_SETUP_OUTCOME_UNKNOWN');
    if (this.busy) throw new Error('FIXTURE_SETUP_BUSY'); this.busy = true;
    try {
      const setupId = crypto.randomUUID(), state = path.join(this.root, setupId);
      this.record(owner,'setup-intent',requestKey,{}, { id: crypto.randomUUID(), setupId, state });
      const evidence = nativeSchema.parse(JSON.parse(await this.python('codex.py', ['--state',state])));
      return this.record(owner,'setup',requestKey,{}, {
        id: setupId, evidence, state, admission: false, deviceSignInReady: false,
        assets: Object.fromEntries(['codex.py','bootstrap.py','peer.py','peer.cjs','process-env-probe.c','egress.py'].map(f =>
          [f,hash(fs.readFileSync(path.join(this.sourceDir,'scripts/fixture-host',f)))])),
      });
    } finally { this.busy = false; }
  }
  publishTraining(owner: number, requestKey: string, input: unknown) {
    const snapshot = SnapshotSchema.parse(input);
    const previous = this.previous(owner,'training',requestKey,snapshot);
    if (previous) return previous;
    const trainingId = crypto.randomUUID();
    return this.record(owner,'training',requestKey,snapshot, {
      id: trainingId, snapshot, bytesHash: hash(snapshot.bytes),
      provenance: { kind: 'authenticated-owner-synthetic-publication', owner,
        publicationId: trainingId, historicalChatImported: false },
    });
  }
  async materialize(owner: number, requestKey: string, input: unknown) {
    const coupling = CouplingSchema.parse(input);
    const previous = this.previous(owner,'run',requestKey,coupling); if (previous) return previous;
    if (this.previous(owner,'run-intent',requestKey,coupling)) throw new Error('FIXTURE_SETUP_OUTCOME_UNKNOWN');
    const setup = this.row(owner,coupling.setupId,'setup');
    const snapshot = this.row(owner,coupling.snapshotId,'training');
    this.checkAssets(setup);
    if (this.busy) throw new Error('FIXTURE_SETUP_BUSY'); this.busy = true;
    try {
      const runId = 'fixture-' + crypto.randomUUID(), root = path.join(this.root,runId);
      this.record(owner,'run-intent',requestKey,coupling,{ id: crypto.randomUUID(), runId });
      directory(root);
      const sessions = [];
      for (const session of coupling.sessions) {
        const home = path.join(root,session.sessionId); directory(home);
        const nativeState = path.join(home,'native');
        const nativeEvidence = nativeSchema.parse(JSON.parse(await this.python('codex.py',['--state',nativeState])));
        const trainingFile = path.join(nativeState,'worker','role-training.txt');
        fs.writeFileSync(trainingFile, (snapshot.snapshot as z.infer<typeof SnapshotSchema>).bytes, {flag:'wx',mode:0o600});
        const peerState = path.join(home,'transport');
        const peer = JSON.parse(await this.python('peer.py',['--state',peerState,'--prepare']));
        if (peer.schema !== 'veneer-fixture-peer-host/v1') throw new Error('FIXTURE_PEER_MATERIAL_DRIFT');
        sessions.push({...session,home,trainingFile,peerState,peer,nativeState,nativeEvidence});
      }
      return this.record(owner,'run',requestKey,coupling, {
        id: runId, setupId: coupling.setupId, snapshotId: coupling.snapshotId, snapshot,
        host: setup, sessions, syntheticOnly: true, nativeAdmission: false,
        permanentRoleChatCaptureVerified: false,
        roleTrainingCaptureWorkflow: 'Permanent ordinary CS role chat capture/readback remains pending',
      });
    } finally { this.busy = false; }
  }
  private checkAssets(setup: Record<string, unknown>) {
    for (const [name, expected] of Object.entries(setup.assets as Record<string,string>))
      if (hash(fs.readFileSync(path.join(this.sourceDir,'scripts/fixture-host',name))) !== expected)
        throw new Error('FIXTURE_HOST_RESOURCE_DRIFT');
    const evidence = setup.evidence as z.infer<typeof nativeSchema>;
    const binary = '/Users/archerclawdington/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
    if (hash(fs.readFileSync(binary)) !== evidence.cliSha256) throw new Error('FIXTURE_HOST_RESOURCE_DRIFT');
    for (const name of ['worker','dedicated-auth'] as const) {
      const policy = path.join(setup.state as string,name + '.sb');
      privateFile(policy);
      if (hash(fs.readFileSync(policy)) !== evidence.profiles[name].sha256)
        throw new Error('FIXTURE_HOST_PROFILE_DRIFT');
    }
  }
  read(owner: number, runId: string) { return this.row(owner,runId,'run'); }
  async call(owner: number, runId: string, input: unknown) {
    const call = CallSchema.parse(input), run = this.row(owner,runId,'run');
    const session = (run.sessions as Array<Record<string, unknown>>).find(s => s.sessionId === call.sessionId);
    if (!session || session.customerId !== call.customerId || session.orderId !== call.orderId)
      throw new Error('FIXTURE_SCOPE_MISMATCH');
    this.checkAssets(run.host as Record<string,unknown>);
    privateFile(session.trainingFile as string);
    if (hash(fs.readFileSync(session.trainingFile as string)) !==
        (run.snapshot as Record<string,unknown>).bytesHash) throw new Error('FIXTURE_TRAINING_MATERIAL_DRIFT');
    const nativeEvidence = session.nativeEvidence as z.infer<typeof nativeSchema>;
    for (const name of ['worker','dedicated-auth'] as const) {
      const file = path.join(session.nativeState as string,name + '.sb'); privateFile(file);
      if (hash(fs.readFileSync(file)) !== nativeEvidence.profiles[name].sha256)
        throw new Error('FIXTURE_HOST_PROFILE_DRIFT');
    }
    const scope = scopeSchema.parse({runId,sessionId:call.sessionId,customerId:call.customerId,orderId:call.orderId});
    const payloadHash = hash(canonical(call));
    const before = this.db.prepare('SELECT id,payload_hash FROM intents WHERE run=? AND session=? AND message=? AND tool=?')
      .get(runId,call.sessionId,call.messageId,call.tool) as {id: string;payload_hash: string} | undefined;
    if (before) {
      if (before.payload_hash !== payloadHash) throw new Error('FIXTURE_INTENT_DRIFT');
      return this.outcome(before.id);
    }
    const intent = crypto.randomUUID();
    this.db.prepare('INSERT INTO intents VALUES(?,?,?,?,?,?)')
      .run(runId,call.sessionId,call.messageId,call.tool,payloadHash,intent);
    // Once intent is durable, ANY failure remains UNKNOWN; no execution retry.
    try {
      const capability = crypto.createHmac('sha256',this.authority).update('capability/v1\0' + canonical({scope,intent})).digest('hex');
      const lines = [ {kind:'bind',scope,capabilityHash:hash(capability),
        trainingHash:(run.snapshot as Record<string,unknown>).bytesHash},
        {scope,capability,tool:call.tool,arguments:call.arguments} ];
      const stdout = await this.python('peer.py',['--state',session.peerState as string],
        lines.map(x => JSON.stringify(x)).join('\n') + '\n');
      const responses = stdout.trim().split('\n').map(x => JSON.parse(x));
      if (responses.length !== 2 || responses[0].result?.bound !== true)
        throw new Error('FIXTURE_TRANSPORT_INVALID');
      if (responses[1].error) {
        if (!/^FIXTURE_[A-Z_]+$/.test(responses[1].error)) throw new Error('FIXTURE_TRANSPORT_INVALID');
        const result = this.sign({intent,status:'DENIED',error:responses[1].error,execute:false});
        this.db.prepare('INSERT INTO outcomes VALUES(?,?)').run(intent,JSON.stringify(result));
        return result;
      }
      const effect = responses[1].result;
      if (call.tool === 'fixture.order.read') {
        const latest = this.db.prepare(`SELECT o.envelope FROM outcomes o JOIN intents i ON i.id=o.intent
          WHERE i.run=? AND i.session=? AND i.tool='fixture.preference.set' ORDER BY o.rowid DESC LIMIT 1`)
          .get(runId,call.sessionId) as {envelope:string}|undefined;
        const saved = latest ? this.verify(JSON.parse(latest.envelope) as Envelope) : undefined;
        effect.preference = (saved?.effect as Record<string,unknown>|undefined)?.preference ?? null;
      }
      const status = effect.kind === 'HUMAN_APPROVAL_REQUIRED' ? 'APPROVAL_REQUIRED'
        : effect.kind === 'HANDOFF' ? 'UNRESOLVED_HANDOFF' : effect.kind === 'SINK_ACCEPTED' ? 'SINK_ACCEPTED' : 'SYNTHETIC_ACCEPTED';
      const result = this.sign({intent,status,scope,effect,carrierDelivery:null,acceptedAt:new Date().toISOString()});
      this.db.prepare('INSERT INTO outcomes VALUES(?,?)').run(intent,JSON.stringify(result));
      return result;
    } catch { return this.sign({intent,status:'UNKNOWN',execute:false,replayAllowed:false}); }
  }
  private outcome(intent: string) {
    const row = this.db.prepare('SELECT envelope FROM outcomes WHERE intent=?').get(intent) as {envelope:string}|undefined;
    if (!row) return this.sign({intent,status:'UNKNOWN',execute:false,replayAllowed:false});
    const result = JSON.parse(row.envelope) as Envelope; this.verify(result); return result;
  }
  deviceSetup(owner: number, setupId: string) {
    const setup = this.row(owner,setupId,'setup'); this.checkAssets(setup);
    return { setupId, nativeMethod:'account/login/start', nativeParams:{type:'chatgptDeviceCode'},
      credentialHome:path.join(setup.state as string,'dedicated-auth','codex'),
      credentialStore:'ephemeral', credentialFilePermitted:false, refreshOwner:'native-managed-process',
      restartRequiresNewOwnerSignIn:true,
      sharedCredentialsPermitted:false, execute:false, ready:false,
      blockers:['PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED','AUTH_INFERENCE_EGRESS_UNACCEPTED'] };
  }
}
