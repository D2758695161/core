import type { InnerPlaintext } from '../../types.js';

export interface ProviderAdapterResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: string;
}

export interface ProviderAdapter {
  name: string;
  
  /**
   * Detect if this adapter handles the given model name
   */
  canHandle(model: string): boolean;
  
  /**
   * Get list of models supported by this adapter
   */
  getModels(): string[];
  
  /**
   * Build the upstream request URL
   * @param apiBase - Base URL for the API
   * @param model - The model name to use (optional, for adapters that embed model in URL)
   * @param stream - Whether this is a streaming request (optional)
   */
  buildUrl(apiBase?: string, model?: string, stream?: boolean): string;
  
  /**
   * Build request headers for the upstream API
   * @param antiFingerprint - If true, randomize headers to avoid fingerprinting
   */
  buildHeaders(apiKey: string, proxySecret?: string, antiFingerprint?: boolean): Record<string, string>;
  
  /**
   * Transform InnerPlaintext to upstream request body
   * @param apiKey - Optional API key, used for provider-specific logic like OAuth
   * @param antiFingerprint - If true, randomize max_tokens to avoid fingerprinting
   */
  buildBody(inner: InnerPlaintext, apiKey?: string, antiFingerprint?: boolean): Record<string, unknown>;
  
  /**
   * Parse non-streaming response
   */
  parseResponse(res: Response): Promise<ProviderAdapterResult>;
  
  /**
   * Parse streaming response, calling onChunk for each text delta
   */
  parseStream(
    res: Response,
    onChunk: (chunk: string) => void,
  ): Promise<ProviderAdapterResult>;
  
  /**
   * Extract usage info from response
   */
  extractUsage(data: unknown): { input_tokens: number; output_tokens: number };
}
