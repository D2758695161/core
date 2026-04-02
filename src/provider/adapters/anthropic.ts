import { createLogger } from '../../logger.js';
import { MODEL_MAP, RETRY_CONFIG } from '../../config/bootstrap.js';
import type { InnerPlaintext } from '../../types.js';
import type { ProviderAdapter, ProviderAdapterResult } from './types.js';

const log = createLogger('adapter:anthropic');

// ─── Anti-Detection Constants ────────────────────────────────────────────────

/** Compatible Anthropic version headers to rotate through */
const ANTHROPIC_VERSIONS = [
  '2023-06-01',
  '2023-06-20',
  '2024-01-01',
  '2024-03-01',
  '2024-07-01',
  '2025-01-01',
];

/** Realistic pool of User-Agent strings */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDelay(maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * maxMs)));
}

function randomizeMaxTokens(maxTokens: number): number {
  if (!maxTokens || maxTokens <= 0) return maxTokens;
  const variation = maxTokens * 0.05;
  const newVal = maxTokens + (Math.random() * 2 - 1) * variation;
  return Math.round(newVal / 100) * 100; // round to nearest 100
}

export function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

function mapModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  
  canHandle(model: string): boolean {
    // Handles all models, but Anthropic models are the default
    // Only handle models that don't have a known prefix for other providers
    const knownPrefixes = ['gpt-', 'gemini-'];
    for (const prefix of knownPrefixes) {
      if (model.startsWith(prefix)) return false;
    }
    return true;
  },
  
  getModels(): string[] {
    return Object.keys(MODEL_MAP);
  },
  
  buildUrl(apiBase?: string): string {
    return (apiBase ?? 'https://api.anthropic.com') + '/v1/messages';
  },
  
  buildHeaders(apiKey: string, proxySecret?: string, antiFingerprint?: boolean): Record<string, string> {
    const isOAuthToken = apiKey.includes('sk-ant-oat');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': antiFingerprint
        ? pickRandom(ANTHROPIC_VERSIONS)
        : '2023-06-01',
    };
    
    if (proxySecret) {
      headers['x-proxy-secret'] = proxySecret;
    } else if (isOAuthToken) {
      // OAuth/setup-token: use Bearer auth + Claude Code headers
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      headers['x-app'] = 'cli';
      headers['accept'] = 'application/json';
      // Rotate User-Agent to avoid fingerprinting (OAuth already sets one)
      if (antiFingerprint) {
        headers['user-agent'] = pickRandom(USER_AGENTS);
      } else {
        headers['user-agent'] = 'claude-cli/2.1.75';
      }
    } else {
      // Standard API key
      headers['x-api-key'] = apiKey;
      // Add randomized User-Agent for anti-fingerprinting
      if (antiFingerprint) {
        headers['user-agent'] = pickRandom(USER_AGENTS);
      }
    }
    
    return headers;
  },
  
  buildBody(inner: InnerPlaintext, apiKey?: string, antiFingerprint?: boolean): Record<string, unknown> {
    const anthropicModel = mapModel(inner.model);
    
    // Anti-detection: randomize max_tokens ±5% to avoid request fingerprinting
    let maxTokens = inner.max_tokens;
    if (antiFingerprint && maxTokens && maxTokens > 0) {
      maxTokens = randomizeMaxTokens(maxTokens);
    }
    
    const systemMessage = inner.messages.find((m) => m.role === 'system');
    const nonSystemMessages = inner.messages.filter((m) => m.role !== 'system');
    
    const anthropicRequest: Record<string, unknown> = {
      model: anthropicModel,
      max_tokens: maxTokens,
      messages: nonSystemMessages,
      temperature: inner.temperature,
      top_p: inner.top_p,
      stream: inner.stream,
    };
    
    if (systemMessage) {
      anthropicRequest.system = systemMessage.content;
    }
    if (inner.stop_sequences.length > 0) {
      anthropicRequest.stop_sequences = inner.stop_sequences;
    }
    
    // OAuth tokens require Claude Code system prompt (Anthropic-specific behavior)
    const isOAuthToken = apiKey?.includes('sk-ant-oat') ?? false;
    if (isOAuthToken && !anthropicRequest.system) {
      anthropicRequest.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
    } else if (isOAuthToken && typeof anthropicRequest.system === 'string') {
      anthropicRequest.system = [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: 'text', text: anthropicRequest.system as string },
      ];
    }
    
    return anthropicRequest;
  },
  
  async parseResponse(res: Response): Promise<ProviderAdapterResult> {
    if (res.status === 400) {
      const errBody = await res.text();
      log.debug('anthropic_400', { body: errBody });
      const body = JSON.parse(errBody) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? 'invalid_request');
    }
    
    if (res.status === 401) {
      throw new Error('upstream_auth');
    }
    
    const body = await res.json() as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    
    return {
      content: body.content.map((c) => c.text).join(''),
      usage: body.usage,
      finish_reason: body.stop_reason === 'end_turn' ? 'stop' : body.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  },
  
  async parseStream(
    res: Response,
    onChunk: (chunk: string) => void,
  ): Promise<ProviderAdapterResult> {
    if (!res.body) throw new Error('no_response_body');
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    let buffer = '';
    
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
              onChunk(event.delta.text);
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
  },
  
  extractUsage(data: unknown): { input_tokens: number; output_tokens: number } {
    const d = data as { usage?: { input_tokens: number; output_tokens: number } };
    return d?.usage ?? { input_tokens: 0, output_tokens: 0 };
  },
};
