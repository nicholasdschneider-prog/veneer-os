import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
const MAX_BYTES = 16 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const identifier = (value) => /^[a-z][a-z0-9_]{0,63}$/.test(value);

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateRequest(request) {
  requireValid(object(request) && Object.keys(request).every((key) => ['state', 'questions'].includes(key)),
    'Request must contain only state and questions.');
  requireValid(text(request.state) || object(request.state), 'State must be nonempty text or an object.');
  requireValid(object(request.questions), 'Questions must be an object.');
  const entries = Object.entries(request.questions);
  requireValid(entries.length > 0 && entries.length <= 16, 'Use 1–16 questions.');
  for (const [name, question] of entries) {
    requireValid(identifier(name) && object(question), 'Invalid question name or shape.');
    requireValid(Object.keys(question).every((key) => ['type', 'instructions', 'criteria'].includes(key)) &&
      text(question.instructions), 'Questions need instructions and supported fields only.');
    const criteria = question.criteria;
    if (question.type === 'choice') {
      requireValid(object(criteria) && Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 32 &&
        Object.keys(criteria).every(identifier) && Object.values(criteria).every(text),
      'Choice criteria need 2–32 named text options.');
    } else if (question.type === 'score') {
      requireValid(Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10 && criteria.every(text),
        'Score criteria need 2–10 ordered text levels.');
    } else if (question.type === 'noul') {
      requireValid(object(criteria) && Object.keys(criteria).length === 2 && text(criteria.true) && text(criteria.false),
        'Noul criteria need true and false descriptions.');
    } else {
      throw new Error('Question type must be choice, score, or noul.');
    }
  }
  const body = JSON.stringify({ model: MODEL, ...request });
  requireValid(Buffer.byteLength(body) <= MAX_BYTES, 'Request exceeds 16 KiB.');
  return body;
}

function distribution(value, labels) {
  requireValid(object(value) && Object.keys(value).length === labels.length &&
    labels.every((label) => Object.hasOwn(value, label) && probability(value[label])),
  'Invalid answer probabilities.');
  requireValid(Math.abs(Object.values(value).reduce((sum, p) => sum + p, 0) - 1) <= 0.02,
    'Answer probabilities do not sum to one.');
  return Object.fromEntries(labels.map((label) => [label, value[label]]));
}

export function validateResponse(response, questions) {
  requireValid(object(response) && object(response.answers) &&
    Object.keys(response.answers).length === Object.keys(questions).length,
  'Response has missing or unexpected answers.');
  const answers = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = response.answers[name];
    requireValid(object(answer) && answer.type === question.type, 'Invalid answer type.');
    if (question.type === 'noul') {
      requireValid(probability(answer.noul), 'Invalid noul probability.');
      answers[name] = { type: 'noul', noul: answer.noul };
      continue;
    }
    requireValid(probability(answer.confidence), 'Invalid answer confidence.');
    if (question.type === 'choice') {
      requireValid(typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice),
        'Answer chose an unknown option.');
      answers[name] = {
        type: 'choice', choice: answer.choice, confidence: answer.confidence,
        probabilities: distribution(answer.probabilities, Object.keys(question.criteria)),
      };
    } else {
      requireValid(Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1,
        'Invalid answer score.');
      answers[name] = {
        type: 'score', score: answer.score, confidence: answer.confidence,
        probabilities: distribution(answer.probabilities, question.criteria.map((_, index) => String(index))),
      };
    }
  }
  requireValid(typeof response.model === 'string' && /^typesafe\/jev-[a-zA-Z0-9.\-]{1,64}$/.test(response.model),
    'Missing or unexpected response model.');
  const usage = {};
  for (const key of ['cost', 'input_tokens', 'output_tokens']) {
    const value = response.usage?.[key];
    usage[key] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return { model: response.model, answers, usage };
}

export async function decide(request, { fetchImpl = fetch, key = process.env.OPENROUTER_API_KEY } = {}) {
  const body = validateRequest(request);
  requireValid(text(key), 'OPENROUTER_API_KEY is unavailable; use the approved secret mechanism.');
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
    });
  } catch {
    throw new Error('Jev request failed or timed out; no retry was attempted.');
  }
  requireValid(response.ok, `Jev HTTP ${response.status}; no retry was attempted.`);
  let parsed;
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 128 * 1024) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Jev returned an unreadable or oversized response.');
  }
  return validateResponse(parsed, request.questions);
}

async function main() {
  const [file, mode, ...rest] = process.argv.slice(2);
  requireValid(file && !file.startsWith('--') && (!mode || mode === '--live') && rest.length === 0,
    'Usage: node decide.mjs request.json [--live] (default: local validation only)');
  let request;
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error();
    const raw = await fs.readFile(file);
    if (raw.byteLength > MAX_BYTES) throw new Error();
    request = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Request must be a readable JSON file no larger than 16 KiB.');
  }
  const body = validateRequest(request);
  const result = mode === '--live'
    ? await decide(request)
    : { validated: true, network: false, model: MODEL, questions: Object.keys(request.questions).length, bytes: Buffer.byteLength(body) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // All emitted messages are local constants/HTTP status, never input or provider bodies.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
