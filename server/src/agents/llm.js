// Thin adapter over the Claude API so agents can be tested with a scripted model.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { PermanentError, RetryableError } from '../jobs/queue.js';

let override = null;
export function setLLM(fake) { override = fake; }

export function llmAvailable() { return !!override || !!config.anthropicApiKey; }

let client = null;
function anthropic() {
  if (!config.anthropicApiKey) throw new PermanentError('AI is not set up: ANTHROPIC_API_KEY is missing on the server (Settings → Channels → AI).');
  client ||= new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 45_000 });
  return client;
}

/** One model turn. `onText` (optional) receives streamed text deltas (used for voice). */
export async function respond({ system, messages, tools = [], maxTokens = 600, onText = null, signal = null }) {
  if (override) return override({ system, messages, tools, maxTokens, onText });
  const params = { model: config.anthropicModel, max_tokens: maxTokens, system, messages, ...(tools.length ? { tools } : {}) };
  try {
    if (onText) {
      const stream = anthropic().messages.stream(params, { signal });
      stream.on('text', t => onText(t));
      return await stream.finalMessage();
    }
    return await anthropic().messages.create(params, { signal });
  } catch (e) {
    if (e instanceof PermanentError) throw e;
    if (e.name === 'AbortError' || signal?.aborted) throw e;
    const status = e.status;
    if (status === 401 || status === 403 || status === 400) throw new PermanentError(`AI request rejected: ${e.message}`);
    throw new RetryableError(`AI temporarily unavailable: ${e.message}`);
  }
}

export function textOf(resp) {
  return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
