import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { handleRequest } from '../src/provider/index.js';
import { selectAdapter, getAllModels, anthropicAdapter, openaiAdapter, googleAdapter } from '../src/provider/adapters/index.js';
import type { InnerPlaintext } from '../src/types.js';

describe('provider adapters', () => {
  let mockAnthropicServer: ReturnType<typeof serve>;
  let mockOpenAIServer: ReturnType<typeof serve>;
  let mockGoogleServer: ReturnType<typeof serve>;
  let anthropicPort: number;
  let openaiPort: number;
  let googlePort: number;

  beforeAll(async () => {
    // Mock Anthropic API
    const anthropicApp = new Hono();
    anthropicApp.post('/v1/messages', async (c) => {
      const body = await c.req.json();
      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic response"}}\n\n'));
            controller.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'));
            controller.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return c.json({
        content: [{ type: 'text', text: 'Anthropic response' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });
    });
    anthropicPort = 18900 + Math.floor(Math.random() * 100);
    mockAnthropicServer = serve({ fetch: anthropicApp.fetch, port: anthropicPort });

    // Mock OpenAI API
    const openaiApp = new Hono();
    openaiApp.post('/v1/chat/completions', async (c) => {
      const body = await c.req.json();
      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"OpenAI"},"finish_reason":null}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":" response"},"finish_reason":null}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return c.json({
        choices: [{ message: { content: 'OpenAI response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
    });
    openaiPort = 18900 + Math.floor(Math.random() * 100) + 200;
    mockOpenAIServer = serve({ fetch: openaiApp.fetch, port: openaiPort });

    // Mock Google API
    const googleApp = new Hono();
    googleApp.post('/v1beta1/models/gemini-2.0-flash:generateContent', async (c) => {
      const body = await c.req.json();
      // Check for streaming by looking at query param alt=sse
      const url = new URL(c.req.url);
      const isStreaming = url.searchParams.get('alt') === 'sse';
      
      if (isStreaming) {
        // SSE streaming response
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            // Send SSE formatted data
            controller.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"Google"}]}}]}\n\n'));
            await new Promise(r => setTimeout(r, 10));
            controller.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":" response"}]}}]}\n\n'));
            await new Promise(r => setTimeout(r, 10));
            controller.enqueue(enc.encode('data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":""}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3,"totalTokenCount":11}}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { 
          headers: { 
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          } 
        });
      }
      return c.json({
        candidates: [{ content: { parts: [{ text: 'Google response' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
      });
    });
    googlePort = 18900 + Math.floor(Math.random() * 100) + 400;
    mockGoogleServer = serve({ fetch: googleApp.fetch, port: googlePort });
  });

  afterAll(() => {
    mockAnthropicServer?.close();
    mockOpenAIServer?.close();
    mockGoogleServer?.close();
  });

  describe('selectAdapter', () => {
    it('selects anthropic adapter for claude models', () => {
      expect(selectAdapter('claude-sonnet-4-20250514').name).toBe('anthropic');
      expect(selectAdapter('claude-haiku-3-5-20241022').name).toBe('anthropic');
    });

    it('selects openai adapter for gpt models', () => {
      expect(selectAdapter('gpt-4o').name).toBe('openai');
      expect(selectAdapter('gpt-4o-mini').name).toBe('openai');
      expect(selectAdapter('gpt-3.5-turbo').name).toBe('openai');
    });

    it('selects google adapter for gemini models', () => {
      expect(selectAdapter('gemini-2.0-flash').name).toBe('google');
      expect(selectAdapter('gemini-1.5-pro').name).toBe('google');
    });
  });

  describe('getAllModels', () => {
    it('returns models from all providers', () => {
      const models = getAllModels();
      expect(models).toContain('claude-sonnet-4-20250514');
      expect(models).toContain('gpt-4o');
      expect(models).toContain('gemini-2.0-flash');
    });
  });

  describe('handleRequest with Anthropic', () => {
    it('non-streaming request', async () => {
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: false,
      };

      const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${anthropicPort}`);
      expect(result.content).toBe('Anthropic response');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
      expect(result.finish_reason).toBe('stop');
    });

    it('streaming request', async () => {
      const chunks: string[] = [];
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: true,
      };

      const result = await handleRequest(inner, 'test-key', (chunk) => chunks.push(chunk), `http://localhost:${anthropicPort}`);
      expect(chunks.join('')).toContain('Anthropic');
      expect(result.content).toContain('Anthropic');
    });
  });

  describe('handleRequest with OpenAI', () => {
    it('non-streaming request', async () => {
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-4o',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: false,
      };

      const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${openaiPort}`);
      expect(result.content).toBe('OpenAI response');
      expect(result.usage.input_tokens).toBe(8);
      expect(result.usage.output_tokens).toBe(3);
      expect(result.finish_reason).toBe('stop');
    });

    it('streaming request', async () => {
      const chunks: string[] = [];
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gpt-4o',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: true,
      };

      const result = await handleRequest(inner, 'test-key', (chunk) => chunks.push(chunk), `http://localhost:${openaiPort}`);
      expect(chunks.join('')).toContain('OpenAI');
      expect(result.content).toContain('OpenAI');
    });
  });

  describe('handleRequest with Google Gemini', () => {
    it('non-streaming request', async () => {
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gemini-2.0-flash',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: false,
      };

      const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${googlePort}`);
      expect(result.content).toBe('Google response');
      expect(result.usage.input_tokens).toBe(8);
      expect(result.usage.output_tokens).toBe(3);
      expect(result.finish_reason).toBe('stop');
    });

    it('streaming request', async () => {
      const chunks: string[] = [];
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'gemini-2.0-flash',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: true,
      };

      const result = await handleRequest(inner, 'test-key', (chunk) => chunks.push(chunk), `http://localhost:${googlePort}`);
      expect(chunks.join('')).toContain('Google');
      expect(result.content).toContain('Google');
    });
  });

  describe('adapter-specific headers', () => {
    it('anthropic uses x-api-key header', () => {
      const headers = anthropicAdapter.buildHeaders('test-key');
      expect(headers['x-api-key']).toBe('test-key');
    });

    it('openai uses Bearer auth', () => {
      const headers = openaiAdapter.buildHeaders('test-key');
      expect(headers['Authorization']).toBe('Bearer test-key');
    });

    it('anthropic with OAuth token uses Bearer auth', () => {
      const headers = anthropicAdapter.buildHeaders('sk-ant-oat-xxxxx');
      expect(headers['Authorization']).toBe('Bearer sk-ant-oat-xxxxx');
      expect(headers['anthropic-beta']).toBeDefined();
    });
  });
});
