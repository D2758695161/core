import { createLogger } from '../../logger.js';
import { RETRY_CONFIG } from '../../config/bootstrap.js';
import type { InnerPlaintext } from '../../types.js';
import type { ProviderAdapter, ProviderAdapterResult } from './types.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { googleAdapter } from './google.js';

const log = createLogger('adapter:factory');

/** Random delay up to maxMs, used for anti-fingerprinting jitter */
function randomDelay(maxMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * maxMs)));
}

// All available adapters
const adapters: ProviderAdapter[] = [
  openaiAdapter,
  googleAdapter,
  anthropicAdapter, // Anthropic is the default/fallback
];

/**
 * Select the appropriate adapter based on model name
 */
export function selectAdapter(model: string): ProviderAdapter {
  // Check adapters in order of specificity (most specific first)
  for (const adapter of adapters) {
    if (adapter.canHandle(model)) {
      log.debug('adapter_selected', { model, adapter: adapter.name });
      return adapter;
    }
  }
  
  // Fallback to Anthropic (should never reach here)
  log.warn('no_adapter_found_fallback', { model });
  return anthropicAdapter;
}

/**
 * Get all supported models across all adapters
 */
export function getAllModels(): string[] {
  const models = new Set<string>();
  for (const adapter of adapters) {
    for (const model of adapter.getModels()) {
      models.add(model);
    }
  }
  return Array.from(models);
}

/**
 * Unified sendRequest function that auto-selects adapter
 * @param antiFingerprint - If true, apply anti-fingerprinting measures (jitter, header randomization)
 */
export async function sendRequest(
  inner: InnerPlaintext,
  apiKey: string,
  onChunk?: (chunk: string) => void,
  apiBase?: string,
  proxySecret?: string,
  antiFingerprint?: boolean,
): Promise<ProviderAdapterResult> {
  const adapter = selectAdapter(inner.model);
  
  log.debug('request_adapter', { model: inner.model, adapter: adapter.name, stream: inner.stream, antiFingerprint });
  
  // Anti-detection: add random jitter before API call (0-500ms)
  if (antiFingerprint) {
    await randomDelay(500);
  }
  
  const url = adapter.buildUrl(apiBase, inner.model, inner.stream);
  const headers = adapter.buildHeaders(apiKey, proxySecret, antiFingerprint);
  const body = adapter.buildBody(inner, apiKey, antiFingerprint);
  
  log.debug('upstream_req', { url, adapter: adapter.name, body });
  
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      const base = Math.min(
        RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1),
        RETRY_CONFIG.maxDelayMs,
      );
      const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, Math.max(0, base + jitter)));
    }
    
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }
    
    log.debug('upstream_status', { status: res.status, adapter: adapter.name });
    
    // Retry on 429, 529, 500
    if (res.status === 429 || res.status === 529 || res.status === 500) {
      lastError = new Error(`${adapter.name}_${res.status}`);
      if (attempt < RETRY_CONFIG.maxRetries) continue;
      throw lastError;
    }
    
    if (!inner.stream) {
      return adapter.parseResponse(res);
    }
    
    // Streaming
    return adapter.parseStream(res, onChunk ?? (() => {}));
  }
  
  throw lastError ?? new Error('max_retries_exceeded');
}

// Re-export adapters for convenience
export { anthropicAdapter, openaiAdapter, googleAdapter };
export type { ProviderAdapter, ProviderAdapterResult } from './types.js';
