// One streaming interface over the official Anthropic and OpenAI SDKs, plus shared
// retry handling. SDK retries are turned off (maxRetries: 0) for two reasons: they
// are invisible, so a long Retry-After looks like a frozen spinner, and they cannot
// recover a stream that dies partway through. withRetry covers both.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-6-astra' };
// Measured with claude-opus-5-5 on a to-do list and a budget tracker, each app then
// checked in two browsers at once. low took 1m50s to 2m37s and 14k to 21k output
// tokens, and both apps worked. medium took about 6.5 minutes and 50k to 52k tokens,
// close to the 64k default limit, for bigger apps that also worked.
export const DEFAULT_EFFORT = 'low';
export const DEFAULT_MAX_TOKENS = 64_000;

const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 5 * 60_000;
const BASE_DELAY_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

const HINTS = {
  auth: 'Check that your API key is correct and active.',
  billing: 'Add credits or check the billing settings of your API account.',
  model: 'Check the model id passed with --model, and that your account has access to it.',
  rate_limit: 'You hit your rate limit. Wait a few minutes or try a smaller model with --model.',
  overloaded: 'The API is overloaded right now. Try again shortly.',
  network: 'Could not reach the API. Check your connection or proxy settings.',
};

export class ProviderError extends Error {
  constructor(kind, message, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.hint = HINTS[kind] ?? null;
  }
}

function readRetryAfter(headers) {
  const ms = Number(headers?.get?.('retry-after-ms'));
  if (ms > 0) return ms;

  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const apiMessage = (err) => err.error?.error?.message ?? err.error?.message ?? err.message;

/** Maps either SDK's error classes onto one vocabulary. Unknown errors pass through unchanged. */
export function normalizeError(err) {
  if (err instanceof ProviderError) return err;

  if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError || err?.name === 'AbortError') {
    return new ProviderError('abort', 'Cancelled.');
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return new ProviderError('network', err.message, { retryable: true });
  }

  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const message = apiMessage(err);
    const retryAfterMs = readRetryAfter(err.headers);
    const code = err.code ?? err.error?.code ?? err.error?.error?.code;

    // OpenAI reports an empty balance as a 429, and waiting will not refill it.
    if (code === 'insufficient_quota') return new ProviderError('billing', message);

    switch (err.status) {
      case undefined: // An error event partway through a stream, such as overloaded_error.
        return new ProviderError('overloaded', message, { retryable: true, retryAfterMs });
      case 401:
      case 403:
        return new ProviderError('auth', message);
      case 402:
        return new ProviderError('billing', message);
      case 404:
        return new ProviderError('model', message);
      case 408:
      case 409:
        return new ProviderError('network', message, { retryable: true, retryAfterMs });
      case 429:
        return new ProviderError('rate_limit', message, { retryable: true, retryAfterMs });
      default:
        if (err.status >= 500) return new ProviderError('overloaded', message, { retryable: true, retryAfterMs });
        return new ProviderError('bad_request', message);
    }
  }

  // The SDK base classes also cover a stream that closed before it finished.
  if (err instanceof Anthropic.AnthropicError || err instanceof OpenAI.OpenAIError) {
    return new ProviderError('network', err.message, { retryable: true });
  }
  return err;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('abort', 'Cancelled.'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('abort', 'Cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Honors Retry-After, otherwise backs off exponentially with jitter. */
export async function withRetry(attemptFn, { signal, onRetry, maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptFn(attempt);
    } catch (raw) {
      const err = normalizeError(raw);
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= maxAttempts) throw err;

      const backoff = Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = err.retryAfterMs ?? backoff * (0.5 + Math.random() / 2);
      if (delayMs > MAX_WAIT_MS) throw err; // A long reset, such as a daily quota: stop and say so.

      onRetry?.({ kind: err.kind, delayMs, attempt, maxAttempts });
      await sleep(delayMs, signal);
    }
  }
}

// claude-opus-5-5, claude-opus-5, claude-fable-5-1 and claude-sonnet-5-5 can hand a
// declined request to another model on the server. Other models do not take the parameter.
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/;
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5|opus-4-[01])/;

/**
 * Gateways, proxies and accounts without the beta reject the fallback option with a
 * 400. The API has no error code for this, so the message is the only signal.
 */
const isFallbackRejection = (err) => err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message);

function anthropicAdapter({ apiKey, model, maxTokens, effort }) {
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 0 });
  let useFallbacks = SUPPORTS_FALLBACKS.test(model);

  return async ({ system, user, onText, signal }) => {
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      ...(NO_EFFORT.test(model) ? {} : { output_config: { effort } }),
    };

    // After a mid-stream fallback the second model continues from the first one's
    // text, so joining every text delta gives the whole document.
    let text = '';
    const collect = (stream) => {
      stream.on('text', (delta) => {
        text += delta;
        onText?.(delta);
      });
      return stream.finalMessage();
    };

    let message;
    try {
      message = await collect(
        useFallbacks
          ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
          : client.messages.stream(params, { signal }),
      );
    } catch (err) {
      if (!useFallbacks || !isFallbackRejection(err)) throw err;
      // Fallbacks are a safety net, so losing them must not stop the run. The request
      // was rejected before any output, and later requests skip the option too.
      useFallbacks = false;
      message = await collect(client.messages.stream(params, { signal }));
    }

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      throw new ProviderError('refusal', `The model declined this request${category ? ` (${category})` : ''}. Try rewording your prompt.`);
    }
    return {
      text,
      truncated: message.stop_reason === 'max_tokens',
      usage: {
        // input_tokens counts only the uncached part of the prompt.
        input:
          (message.usage.input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        output: message.usage.output_tokens ?? 0,
      },
    };
  };
}

const SUPPORTS_REASONING = /^(gpt-[5-9]|o\d)/;

function openaiAdapter({ apiKey, model, maxTokens, effort }) {
  const client = new OpenAI({ ...(apiKey ? { apiKey } : {}), maxRetries: 0 });

  return async ({ system, user, onText, signal }) => {
    const stream = await client.responses.create(
      {
        model,
        instructions: system,
        input: user,
        stream: true,
        store: false,
        max_output_tokens: maxTokens,
        text: { format: { type: 'json_object' } },
        ...(SUPPORTS_REASONING.test(model) ? { reasoning: { effort } } : {}),
      },
      { signal },
    );

    let text = '';
    let truncated = false;
    let usage = { input: 0, output: 0 };
    const recordUsage = (response) => {
      usage = { input: response?.usage?.input_tokens ?? 0, output: response?.usage?.output_tokens ?? 0 };
    };

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta;
          onText?.(event.delta);
          break;
        case 'response.refusal.done':
          throw new ProviderError('refusal', `The model declined this request: ${event.refusal}`);
        case 'response.completed':
          recordUsage(event.response);
          break;
        case 'response.incomplete': {
          recordUsage(event.response);
          const reason = event.response?.incomplete_details?.reason;
          if (reason === 'content_filter') throw new ProviderError('refusal', 'The content filter stopped this response. Try rewording your prompt.');
          truncated = true;
          break;
        }
        case 'response.failed': {
          const failure = event.response?.error;
          if (failure?.code === 'insufficient_quota') throw new ProviderError('billing', failure.message);
          throw new ProviderError('overloaded', failure?.message ?? 'The response failed.', { retryable: true });
        }
        case 'error':
          throw new ProviderError('overloaded', event.message ?? 'The stream reported an error.', { retryable: true });
        default:
          break;
      }
    }
    return { text, truncated, usage };
  };
}

const ADAPTERS = { anthropic: anthropicAdapter, openai: openaiAdapter };

/** Creates the client the rest of the CLI uses. complete() adds retries and tracks token usage. */
export function createLLM({ provider, apiKey, model, maxTokens = DEFAULT_MAX_TOKENS, effort = DEFAULT_EFFORT }) {
  const resolvedModel = model ?? DEFAULT_MODELS[provider];
  const send = ADAPTERS[provider]({ apiKey, model: resolvedModel, maxTokens, effort });
  const usage = { input: 0, output: 0 };

  return {
    provider,
    model: resolvedModel,
    usage,
    async complete({ system, user, onText, onAttempt, onRetry, signal }) {
      const result = await withRetry(
        (attempt) => {
          onAttempt?.(attempt); // A retried stream starts over, so progress resets too.
          return send({ system, user, onText, signal });
        },
        { signal, onRetry },
      );
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      return result;
    },
  };
}
