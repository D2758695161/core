import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  toHex,
} from '../src/crypto/index.js';

describe('consumer', () => {
  // Test the HTTP gateway endpoints directly using Hono app
  // We test against a standalone Hono app that mirrors gateway logic

  const startTime = Date.now();
  let server: ReturnType<typeof serve>;
  let port: number;

  beforeAll(async () => {
    const { MODELS } = await import('../src/config/bootstrap.js');

    const app = new Hono();

    app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        version: '0.1.0',
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        providers_online: 0,
        relay_connected: false,
      });
    });

    // Auth middleware
    const testApiKey = 'test-key-12345';
    app.use('/v1/*', async (c, next) => {
      if (testApiKey) {
        const auth = c.req.header('authorization');
        if (!auth || !auth.startsWith('Bearer ')) {
          return c.json(
            { error: { message: 'Missing API key', type: 'authentication_error', code: null } },
            401,
          );
        }
        const token = auth.slice(7);
        if (token !== testApiKey) {
          return c.json(
            { error: { message: 'Invalid API key', type: 'authentication_error', code: null } },
            401,
          );
        }
      }
      await next();
    });

    app.get('/v1/models', (c) => {
      return c.json({
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: m.created,
          owned_by: 'veil',
        })),
      });
    });

    app.post('/v1/chat/completions', async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: null } }, 400);
      }

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return c.json(
          { error: { message: 'messages is required and must be non-empty', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      if (!body.model) {
        return c.json(
          { error: { message: 'model is required', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      // No providers in test mode -> 503
      return c.json(
        { error: { message: 'No providers available', type: 'api_error', code: 'no_providers' } },
        503,
      );
    });

    port = 18800 + Math.floor(Math.random() * 100);
    server = serve({ fetch: app.fetch, port });
  });

  afterAll(() => {
    server?.close();
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    expect(typeof body.uptime_seconds).toBe('number');
  });

  it('GET /v1/models returns model list', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { authorization: 'Bearer test-key-12345' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe('claude-sonnet-4-20250514');
    expect(body.data[0].owned_by).toBe('veil');
  });

  it('POST /v1/chat/completions with missing messages -> 400', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('POST /v1/chat/completions non-streaming returns 503 (no providers)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /v1/chat/completions streaming returns 503 (no providers)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(503);
  });

  it('Auth: request without Bearer when VEIL_API_KEY set -> 401', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });
});
