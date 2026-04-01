import { createLogger } from '../../logger.js';
import { MODEL_MAP, RETRY_CONFIG } from '../../config/bootstrap.js';
import type { RequestPayload, RequestResult, Usage, ProviderAdapter } from './types.js';

const log = createLogger('adapter/anthropic');

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

export const anthropicAdapter: ProviderAdapter = {
  name: 'Anthropic',
  provider: 'anthropic',

  getModels(): string[] {
    return Object.keys(MODEL_MAP);
  },

  handles(model: string): boolean {
    return model in MODEL_MAP || model.startsWith('claude-');
  },

  async sendRequest(
    payload: RequestPayload,
    apiKey: string,
    onChunk?: (chunk: string) => void,
    apiBase?: string,
    proxySecret?: string,
  ): Promise<RequestResult> {
    const anthropicModel = MODEL_MAP[payload.model] ?? payload.model;

    const systemMessage = payload.messages.find((m) => m.role === 'system');
    const nonSystemMessages = payload.messages.filter((m) => m.role !== 'system');

    const anthropicRequest: Record<string, unknown> = {
      model: anthropicModel,
      max_tokens: payload.max_tokens,
      messages: nonSystemMessages,
      temperature: payload.temperature,
      top_p: payload.top_p,
      stream: payload.stream ?? false,
    };

    if (systemMessage) {
      anthropicRequest.system = systemMessage.content;
    }
    if (payload.stop_sequences && payload.stop_sequences.length > 0) {
      anthropicRequest.stop_sequences = payload.stop_sequences;
    }

    const url = (apiBase ?? 'https://api.anthropic.com') + '/v1/messages';
    const isOAuthToken = apiKey.includes('sk-ant-oat');
    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (proxySecret) {
      reqHeaders['x-proxy-secret'] = proxySecret;
    } else if (isOAuthToken) {
      reqHeaders['Authorization'] = `Bearer ${apiKey}`;
      reqHeaders['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
      reqHeaders['anthropic-dangerous-direct-browser-access'] = 'true';
      reqHeaders['user-agent'] = 'claude-cli/2.1.75';
      reqHeaders['x-app'] = 'cli';
      reqHeaders['accept'] = 'application/json';
    } else {
      reqHeaders['x-api-key'] = apiKey;
    }

    if (isOAuthToken && !anthropicRequest.system) {
      anthropicRequest.system = [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }];
    } else if (isOAuthToken && typeof anthropicRequest.system === 'string') {
      anthropicRequest.system = [
        { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
        { type: 'text', text: anthropicRequest.system as string },
      ];
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, getRetryDelay(attempt - 1)));
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(anthropicRequest),
        });
      } catch (err) {
        lastError = err as Error;
        continue;
      }

      if (res.status === 429 || res.status === 529 || res.status === 500) {
        lastError = new Error(`anthropic_${res.status}`);
        if (attempt < RETRY_CONFIG.maxRetries) continue;
        throw lastError;
      }

      if (res.status === 400) {
        const errBody = await res.text();
        log.debug('anthropic_400', { body: errBody });
        const body = JSON.parse(errBody) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'invalid_request');
      }

      if (res.status === 401) {
        throw new Error('upstream_auth');
      }

      if (!payload.stream) {
        const body = await res.json() as {
          content: Array<{ text: string }>;
          usage: Usage;
          stop_reason: string;
        };
        return {
          content: body.content.map((c) => c.text).join(''),
          usage: body.usage,
          finish_reason: body.stop_reason === 'end_turn' ? 'stop' : body.stop_reason === 'max_tokens' ? 'length' : 'stop',
        };
      }

      if (!res.body) throw new Error('no_response_body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'stop';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          let event: {
            type: string;
            message?: { usage?: { input_tokens: number } };
            delta?: { type?: string; text?: string; stop_reason?: string };
            usage?: { output_tokens: number };
          };
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'message_start':
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;
            case 'content_block_delta':
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                content += event.delta.text;
                onChunk?.(event.delta.text);
              }
              break;
            case 'message_delta':
              outputTokens = event.usage?.output_tokens ?? 0;
              if (event.delta?.stop_reason === 'end_turn') finishReason = 'stop';
              else if (event.delta?.stop_reason === 'max_tokens') finishReason = 'length';
              break;
          }
        }
      }

      return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, finish_reason: finishReason };
    }

    throw lastError ?? new Error('max_retries_exceeded');
  },
};
