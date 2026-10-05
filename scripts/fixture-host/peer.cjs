// Trusted synthetic-only stdio peer. No fs/network/child-process imports or generic handler.
const readline = require('node:readline');
const crypto = require('node:crypto');
let binding;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.sort().join(',');
const fixture = v => typeof v === 'string' && /^fixture-[a-z0-9-]{1,90}$/.test(v);
const safeText = v => typeof v === 'string' && v.length >= 1 && v.length <= 1000 &&
  !/[\u0000-\u001f]/.test(v);
function dispatch(message) {
  if (!binding) {
    if (!exact(message, ['kind', 'scope', 'capabilityHash', 'trainingHash']) ||
        message.kind !== 'bind' || !exact(message.scope, ['runId','sessionId','customerId','orderId']) ||
        !Object.values(message.scope).every(fixture) ||
        !/^[a-f0-9]{64}$/.test(message.capabilityHash) || !/^[a-f0-9]{64}$/.test(message.trainingHash))
      throw new Error('FIXTURE_BINDING_DENIED');
    binding = message;
    return { bound: true };
  }
  if (!exact(message, ['scope','capability','tool','arguments']) ||
      !exact(message.scope, ['runId','sessionId','customerId','orderId']) ||
      !Object.keys(binding.scope).every(k => equal(binding.scope[k], message.scope[k])) ||
      typeof message.capability !== 'string' || message.capability.length > 128 ||
      !equal(binding.capabilityHash, crypto.createHash('sha256').update(message.capability).digest('hex')))
    throw new Error('FIXTURE_CAPABILITY_DENIED');
  const args = message.arguments;
  switch (message.tool) {
    case 'fixture.order.read':
      if (!exact(args, [])) break;
      return { kind: 'READ', syntheticOnly: true, orderId: binding.scope.orderId,
        status: 'SYNTHETIC_OPEN', cancellationRefundApproval: 'HUMAN_REQUIRED', autoShipSmsPaused: true,
        proposedHourWindowActive: false };
    case 'fixture.preference.set':
      if (!exact(args, ['preference']) || !['morning','afternoon'].includes(args.preference)) break;
      return { kind: 'PREFERENCE', syntheticOnly: true, preference: args.preference };
    case 'fixture.sms.accept':
      if (!exact(args, ['text']) || !safeText(args.text)) break;
      return { kind: 'SINK_ACCEPTED', syntheticOnly: true, text: args.text, carrierDelivery: null };
    case 'fixture.handoff':
      if (!exact(args, ['reason']) || !safeText(args.reason)) break;
      return { kind: 'HANDOFF', syntheticOnly: true, reason: args.reason, unresolved: true };
    case 'fixture.cancel.request':
    case 'fixture.refund.request':
      if (!exact(args, [])) break;
      return { kind: 'HUMAN_APPROVAL_REQUIRED', syntheticOnly: true, execute: false };
    default:
      throw new Error('FIXTURE_TOOL_DENIED');
  }
  throw new Error('FIXTURE_ARGUMENTS_DENIED');
}
let total = 0;
readline.createInterface({input: process.stdin, crlfDelay: Infinity}).on('line', line => {
  total += Buffer.byteLength(line);
  if (total > 16384) { process.exitCode = 70; process.stdin.destroy(); return; }
  try { console.log(JSON.stringify({result: dispatch(JSON.parse(line))})); }
  catch (e) {
    // Fixed codes only, never capability, source payload or exception values.
    console.log(JSON.stringify({error: /^FIXTURE_[A-Z_]+$/.test(e.message) ? e.message : 'FIXTURE_INPUT_DENIED'}));
  }
});
