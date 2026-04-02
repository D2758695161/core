import { connect } from '../network/index.js';
import { open, seal, sign, toHex, fromHex } from '../crypto/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('provider');
import { MODEL_MAP, RETRY_CONFIG } from '../config/bootstrap.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MetricsStore } from './metrics.js';
import { sendRequest, selectAdapter, getAllModels } from './adapters/index.js';
import type { Connection } from '../network/index.js';
import type { Wallet } from '../wallet/index.js';
import type {
  WsMessage,
  RequestPayload,
  InnerPlaintext,
  StreamChunkPayload,
} from '../types.js';
import type { RelayDiscoveryClient } from '../discovery/client.js';

const PROVIDER_VERSION = '0.1.0';
const DEFAULT_HEALTH_PORT = 9962;
const MULTI_RELAY_COUNT = 3;

export interface ProviderOptions {
  wallet: Wallet;
  relayUrl: string;
  apiKeys: Array<{ provider: 'anthropic' | 'openai' | 'google'; key: string }>;
  maxConcurrent: number;
  proxyUrl?: string;      // e.g. http://127.0.0.1:4000
  proxySecret?: string;   // shared secret for proxy auth
  healthPort?: number;    // port for /health endpoint (default 9962)
  discoveryClient?: RelayDiscoveryClient;
  antiFingerprint?: boolean; // enable anti-fingerprinting measures (default: false)
}

export interface HandleRequestResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: string;
}

export async function handleRequest(
  inner: InnerPlaintext,
  apiKey: string,
  onChunk?: (chunk: string) => void,
  apiBase?: string,
  proxySecret?: string,
  antiFingerprint?: boolean,
): Promise<HandleRequestResult> {
  // Use the adapter-based sendRequest for multi-vendor support
  // The selectAdapter will choose the appropriate adapter based on model prefix
  log.debug('handle_request', { model: inner.model, adapter: selectAdapter(inner.model).name, antiFingerprint });
  return sendRequest(inner, apiKey, onChunk, apiBase, proxySecret, antiFingerprint);
}

export async function startProvider(options: ProviderOptions): Promise<{ close(): Promise<void> }> {
  const { wallet, relayUrl, apiKeys, maxConcurrent, proxyUrl, proxySecret, discoveryClient, antiFingerprint } = options;
  const apiBase = proxyUrl ?? undefined;
  
  // Helper to select API key based on model
  function selectApiKeyForModel(model: string): string {
    if (proxyUrl) return 'proxy';
    const adapter = selectAdapter(model);
    const providerMap: Record<string, 'anthropic' | 'openai' | 'google'> = {
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
    };
    const provider = providerMap[adapter.name] ?? 'anthropic';
    return apiKeys.find((k) => k.provider === provider)?.key ?? apiKeys[0]?.key ?? '';
  }
  
  if (!proxyUrl && apiKeys.length === 0) throw new Error('No API key or proxy configured');

  let activeRequests = 0;
  const metrics = new MetricsStore();
  const extraConnections: Connection[] = [];

  const conn = await connect({
    url: relayUrl,
    onMessage(msg: WsMessage) {
      if (msg.type === 'provider_ack') {
        const payload = msg.payload as { status: string; reason?: string };
        if (payload.status === 'rejected') {
          log.error('provider_rejected', { reason: payload.reason });
        } else {
          log.info('provider_accepted');
        }
        return;
      }

      if (msg.type === 'request') {
        if (activeRequests >= maxConcurrent) {
          conn.send({
            type: 'error',
            request_id: msg.request_id,
            payload: { code: 'rate_limit', message: 'Provider at capacity' },
            timestamp: Date.now(),
          });
          return;
        }
        handleIncomingRequest(msg).catch((err) => {
          log.error('request_error', { error: (err as Error).message });
        });
      }

      if (msg.type === 'pong') return;
    },
    onClose(code, reason) {
      log.warn('relay_disconnected', { code, reason });
    },
    onError(err) {
      log.error('relay_error', { error: err.message });
    },
  });

  // Send provider_hello
  function sendProviderHello(c: Connection): void {
    const models = getAllModels();
    const helloPayload = {
      provider_pubkey: toHex(wallet.signingPublicKey),
      encryption_pubkey: toHex(wallet.encryptionPublicKey),
      models,
      capacity: 100,
    };
    const ts = Date.now();
    const signable = JSON.stringify({ ...helloPayload, timestamp: ts });
    const sig = sign(new TextEncoder().encode(signable), wallet.signingSecretKey);
    c.send({
      type: 'provider_hello',
      payload: { ...helloPayload, signature: toHex(sig) },
      timestamp: ts,
    });
  }

  sendProviderHello(conn);

  // If discovery client is available, connect to additional relays for wider reachability
  if (discoveryClient) {
    try {
      const relays = await discoveryClient.fetchRelays();
      const additionalRelays = relays
        .filter((r) => r.endpoint !== relayUrl && r.capacity > 0)
        .slice(0, MULTI_RELAY_COUNT - 1);

      for (const relay of additionalRelays) {
        try {
          const extraConn = await connect({
            url: relay.endpoint,
            onMessage(msg: WsMessage) {
              if (msg.type === 'provider_ack') {
                const payload = msg.payload as { status: string; reason?: string };
                if (payload.status === 'rejected') {
                  log.error('extra_relay_rejected', { relay: relay.relay_id, reason: payload.reason });
                } else {
                  log.info('extra_relay_accepted', { relay: relay.relay_id });
                }
                return;
              }
              if (msg.type === 'request') {
                if (activeRequests >= maxConcurrent) {
                  extraConn.send({
                    type: 'error',
                    request_id: msg.request_id,
                    payload: { code: 'rate_limit', message: 'Provider at capacity' },
                    timestamp: Date.now(),
                  });
                  return;
                }
                handleIncomingRequest(msg).catch((err) => {
                  log.error('request_error', { error: (err as Error).message });
                });
              }
            },
            onClose(_code, _reason) {
              log.warn('extra_relay_disconnected', { relay: relay.relay_id });
            },
            onError(err) {
              log.error('extra_relay_error', { relay: relay.relay_id, error: err.message });
            },
          });
          sendProviderHello(extraConn);
          extraConnections.push(extraConn);
          log.info('extra_relay_connected', { relay: relay.relay_id, endpoint: relay.endpoint });
        } catch (err) {
          log.warn('extra_relay_connect_failed', { relay: relay.relay_id, error: (err as Error).message });
        }
      }
    } catch (err) {
      log.warn('discovery_multi_relay_failed', { error: (err as Error).message });
    }
  }

  async function handleIncomingRequest(msg: WsMessage): Promise<void> {
    const requestStart = Date.now();
    let isError = false;
    let modelName = 'unknown';

    activeRequests++;
    const requestId = msg.request_id!;
    try {
      const payload = msg.payload as RequestPayload;
      const innerBytes = Buffer.from(payload.inner, 'base64');

      // Decrypt inner envelope
      const plaintext = open(new Uint8Array(innerBytes), wallet.encryptionSecretKey);
      if (!plaintext) {
        conn.send({
          type: 'error',
          request_id: requestId,
          payload: { code: 'decrypt_failed', message: 'Failed to decrypt request' },
          timestamp: Date.now(),
        });
        return;
      }

      // Extract consumer encryption pubkey for response encryption
      const consumerEncPubkey = innerBytes.slice(0, 32);
      const inner: InnerPlaintext = JSON.parse(new TextDecoder().decode(plaintext));
      modelName = inner.model || 'unknown';

      if (inner.stream) {
        // Streaming mode
        conn.send({
          type: 'stream_start',
          request_id: requestId,
          payload: { model: inner.model },
          timestamp: Date.now(),
        });

        // Send first chunk with role
        const roleChunk = JSON.stringify({ role: 'assistant' });
        const sealedRole = seal(
          new TextEncoder().encode(roleChunk),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'stream_chunk',
          request_id: requestId,
          payload: {
            encrypted_chunk: Buffer.from(sealedRole).toString('base64'),
            index: 0,
          } satisfies import('../types.js').StreamChunkPayload,
          timestamp: Date.now(),
        });

        let chunkIndex = 1;
        const result = await handleRequest(inner, selectApiKeyForModel(inner.model), (text) => {
          const sealed = seal(
            new TextEncoder().encode(text),
            new Uint8Array(consumerEncPubkey),
            wallet.encryptionSecretKey,
          );
          conn.send({
            type: 'stream_chunk',
            request_id: requestId,
            payload: {
              encrypted_chunk: Buffer.from(sealed).toString('base64'),
              index: chunkIndex++,
            } satisfies StreamChunkPayload,
            timestamp: Date.now(),
          });
        }, apiBase, proxySecret, antiFingerprint);

        // Send finish_reason chunk
        const finishChunk = JSON.stringify({ finish_reason: result.finish_reason });
        const sealedFinish = seal(
          new TextEncoder().encode(finishChunk),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'stream_chunk',
          request_id: requestId,
          payload: {
            encrypted_chunk: Buffer.from(sealedFinish).toString('base64'),
            index: chunkIndex++,
          } satisfies StreamChunkPayload,
          timestamp: Date.now(),
        });

        conn.send({
          type: 'stream_end',
          request_id: requestId,
          payload: { usage: result.usage },
          timestamp: Date.now(),
        });
      } else {
        // Non-streaming mode
        const result = await handleRequest(inner, selectApiKeyForModel(inner.model), undefined, apiBase, proxySecret, antiFingerprint);
        const responseBody = JSON.stringify({
          content: result.content,
          usage: result.usage,
          finish_reason: result.finish_reason,
        });
        const sealed = seal(
          new TextEncoder().encode(responseBody),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'response',
          request_id: requestId,
          payload: { encrypted_body: Buffer.from(sealed).toString('base64') },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      isError = true;
      const message = (err as Error).message;
      log.error('provider_request_error', { error: message });
      const code = message === 'decrypt_failed' ? 'decrypt_failed'
        : message === 'upstream_auth' ? 'api_error'
        : message.startsWith('anthropic_') || message.startsWith('openai_') || message.startsWith('google_') ? 'api_error'
        : 'api_error';
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code, message },
        timestamp: Date.now(),
      });
    } finally {
      const latencyMs = Date.now() - requestStart;
      metrics.recordRequest(modelName, latencyMs, isError);
      activeRequests--;
    }
  }

  // Start health HTTP server
  const startTime = Date.now();
  const healthPort = options.healthPort
    ?? (process.env['VEIL_PROVIDER_HEALTH_PORT'] ? Number(process.env['VEIL_PROVIDER_HEALTH_PORT']) : undefined)
    ?? DEFAULT_HEALTH_PORT;
  const healthModels = getAllModels();
  const capacity = options.maxConcurrent;

  const healthApp = new Hono();
  healthApp.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      models: healthModels,
      capacity,
      version: PROVIDER_VERSION,
    });
  });

  healthApp.get('/metrics', (c) => {
    return c.json(metrics.getMetrics());
  });

  let healthServer: ReturnType<typeof serve> | undefined;
  try {
    healthServer = serve({ fetch: healthApp.fetch, port: healthPort });
    console.log(JSON.stringify({ level: 'info', msg: 'health_server_started', port: healthPort }));
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: 'health_server_failed', error: (err as Error).message }));
  }

  return {
    async close(): Promise<void> {
      healthServer?.close();
      for (const ec of extraConnections) {
        ec.close();
      }
      conn.close();
    },
  };
}
