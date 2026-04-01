export interface RequestPayload {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface RequestResult {
  content: string;
  usage: Usage;
  finish_reason: string;
}

export interface ProviderAdapter {
  /** Human-readable name */
  name: string;
  /** Provider ID (e.g., 'anthropic', 'openai', 'google') */
  provider: string;
  /** List of model IDs this adapter handles */
  getModels(): string[];
  /** Whether this adapter handles the given model ID */
  handles(model: string): boolean;
  /**
   * Send a request and return the result.
   * @param payload The request payload
   * @param apiKey API key for the provider
   * @param onChunk Optional callback for streaming response chunks
   * @param apiBase Optional custom API base URL
   * @param proxySecret Optional proxy secret
   */
  sendRequest(
    payload: RequestPayload,
    apiKey: string,
    onChunk?: (chunk: string) => void,
    apiBase?: string,
    proxySecret?: string,
  ): Promise<RequestResult>;
}
