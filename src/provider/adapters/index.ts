import type { ProviderAdapter } from './types.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { googleAdapter } from './google.js';

export * from './types.js';
export { anthropicAdapter } from './anthropic.js';
export { openaiAdapter } from './openai.js';
export { googleAdapter } from './google.js';

/** All registered adapters, in priority order */
const ADAPTERS: ProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
  googleAdapter,
];

/**
 * Find the appropriate adapter for a given model.
 * Returns undefined if no adapter handles this model.
 */
export function getAdapter(model: string): ProviderAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.handles(model));
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): ProviderAdapter[] {
  return [...ADAPTERS];
}

/**
 * Register a custom adapter (added to the end of the chain).
 */
export function registerAdapter(adapter: ProviderAdapter): void {
  ADAPTERS.push(adapter);
}

/**
 * Get all models supported by all adapters.
 */
export function getAllModels(): string[] {
  return ADAPTERS.flatMap((a) => a.getModels());
}
