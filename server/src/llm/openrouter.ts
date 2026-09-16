/**
 * Minimal OpenRouter chat-completions client, used only to auto-name chats.
 * OpenRouter's API is OpenAI-compatible. We ask a model for a very short title
 * and post-process the reply down to at most four words. Any failure throws or
 * returns null, so the caller can fall back to the existing placeholder title.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Squeeze a model's reply into a clean, ≤4-word title: strip wrapping quotes,
 * a leading "Title:" label, and trailing punctuation; collapse whitespace; keep
 * the first four words. Returns null if nothing usable is left.
 */
export function cleanTitle(raw: string): string | null {
  let t = raw
    .trim()
    // Strip wrapping quotes and markdown emphasis (**bold**, *italic*, _under_).
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/^title\s*[:\-—]\s*/i, '')
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  t = t.split(' ').slice(0, 4).join(' ');
  // Drop trailing punctuation/emphasis left after truncation.
  t = t.replace(/[.\s*_`"']+$/, '').trim();
  return t.length ? t.slice(0, 80) : null;
}

/**
 * Ask OpenRouter for a ≤4-word title for a chat that opens with `firstMessage`.
 * Reasoning is disabled (a title needs none — it just wastes tokens/latency) and
 * output is capped. Returns null when the model gives nothing usable; throws on
 * a transport/HTTP error so the caller can log and move on.
 */
export async function generateChatTitle(
  firstMessage: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // A title only needs the opening of the message — cap what we send.
  const excerpt = firstMessage.slice(0, 2000);
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter attribution (optional, shows up in their dashboard).
      'X-Title': 'Veneer Pro',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      // Titles don't need chain-of-thought; disabling it keeps this cheap/fast
      // on reasoning models like GLM 5.2. Ignored by non-reasoning models.
      reasoning: { enabled: false },
      messages: [
        {
          role: 'system',
          content:
            'You write extremely short chat titles. Given the first message of a chat, reply with a title of at most FOUR words that captures its topic. Reply with ONLY the title — no quotes, no punctuation, no preamble.',
        },
        { role: 'user', content: excerpt },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`OpenRouter ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  return cleanTitle(content);
}
