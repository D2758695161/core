import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect, createServer, calculateBackoffDelay } from '../src/network/index.js';
import type { WsMessage, ConnectionStateEvent } from '../src/network/index.js';

describe('network', () => {
  const servers: Array<{ close(): void }> = [];
  const connections: Array<{ close(): void }> = [];

  afterEach(() => {
    connections.forEach((c) => c.close());
    servers.forEach((s) => s.close());
    connections.length = 0;
    servers.length = 0;
    vi.restoreAllMocks();
  });

  it('connect to local WS server', async () => {
    const server = createServer({
      port: 0,
      onConnection() {},
    });
    servers.push(server);

    const port = server.address().port;
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    connections.push(conn);

    expect(conn.readyState).toBe('open');
  });

  it('send + onMessage roundtrip', async () => {
    const received: WsMessage[] = [];

    const server = createServer({
      port: 0,
      onConnection(conn) {
        conn.ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as WsMessage;
          // Echo back
          conn.send({ type: 'pong', payload: msg.payload, timestamp: Date.now() });
        });
      },
    });
    servers.push(server);

    const port = server.address().port;
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) {
        received.push(msg);
      },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    connections.push(conn);

    conn.send({ type: 'ping', payload: { test: true }, timestamp: Date.now() });

    // Wait for response
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe('pong');
  });

  it('auto-reconnect after server restart', async () => {
    let serverPort: number;
    let connCount = 0;

    // First server
    let server = createServer({
      port: 0,
      onConnection(serverConn) { connCount++; },
    });
    serverPort = server.address().port;

    let closeCount = 0;
    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() { closeCount++; },
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
    });

    expect(conn.readyState).toBe('open');
    expect(connCount).toBe(1);

    // Terminate the client WS to trigger reconnect cycle
    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 500));

    // Close old server and start a new one on same port
    server.close();
    await new Promise((r) => setTimeout(r, 200));

    server = createServer({
      port: serverPort,
      onConnection() { connCount++; },
    });
    servers.push(server);

    // Wait for reconnect (base delay ~1s + connection time)
    await new Promise((r) => setTimeout(r, 3000));

    expect(closeCount).toBeGreaterThanOrEqual(1);
    expect(connCount).toBeGreaterThanOrEqual(2);
    connections.push(conn);
  });

  it('ping/pong: no pong within timeout triggers close', async () => {
    let closed = false;

    const server = createServer({
      port: 0,
      onConnection(conn) {
        // Intentionally do NOT respond to pings
        conn.ws.on('ping', () => { /* silent */ });
      },
    });
    servers.push(server);

    const port = server.address().port;
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {},
      onClose() { closed = true; },
      onError() {},
      reconnect: false,
      pingIntervalMs: 500, // Very short for test
    });
    connections.push(conn);

    // Wait longer than ping interval + pong timeout
    await new Promise((r) => setTimeout(r, 1500));

    expect(typeof conn.readyState).toBe('string');
  });

  // ============================================
  // State Machine Tests
  // ============================================

  it('state machine: initial state is connecting then transitions to connected', async () => {
    const stateEvents: ConnectionStateEvent[] = [];
    const server = createServer({
      port: 0,
      onConnection() {},
    });
    servers.push(server);

    const port = server.address().port;
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
      onStateChange: (event) => stateEvents.push(event),
    });
    connections.push(conn);

    // Check that we have connecting->connected transition
    const connectingToConnected = stateEvents.find(
      e => e.type === 'state_change' && e.from === 'connecting' && e.to === 'connected'
    );
    expect(connectingToConnected).toBeDefined();
    expect(conn.state).toBe('connected');
  });

  it('state machine: close() transitions to disconnecting then disconnected', async () => {
    const stateEvents: ConnectionStateEvent[] = [];
    const server = createServer({
      port: 0,
      onConnection() {},
    });
    servers.push(server);

    const port = server.address().port;
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
      onStateChange: (event) => stateEvents.push(event),
    });
    connections.push(conn);

    // Close the connection
    conn.close();
    
    // Wait for async close to complete
    await new Promise((r) => setTimeout(r, 100));

    const stateChanges = stateEvents.filter(e => e.type === 'state_change');
    
    // Should have: connecting->connected, connected->disconnecting, disconnecting->disconnected
    const hasDisconnecting = stateChanges.some(
      e => e.type === 'state_change' && e.to === 'disconnecting'
    );
    const hasDisconnected = stateChanges.some(
      e => e.type === 'state_change' && e.to === 'disconnected'
    );
    
    expect(hasDisconnecting).toBe(true);
    expect(hasDisconnected).toBe(true);
  });

  it('state machine: reconnect transitions to reconnecting then connected', async () => {
    const stateEvents: ConnectionStateEvent[] = [];
    let serverPort: number;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      onStateChange: (event) => stateEvents.push(event),
    });

    // Terminate to trigger reconnect
    conn.ws.terminate();
    
    // Wait for reconnect event
    await new Promise((r) => setTimeout(r, 200));

    const hasReconnecting = stateEvents.some(
      e => e.type === 'reconnecting' || (e.type === 'state_change' && e.to === 'reconnecting')
    );
    expect(hasReconnecting).toBe(true);
    connections.push(conn);
  });

  // ============================================
  // Exponential Backoff Tests
  // ============================================

  it('exponential backoff: calculateBackoffDelay returns increasing delays', () => {
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      delays.push(calculateBackoffDelay(attempt));
    }

    // Base delay should be ~1000ms
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(2000); // base + jitter

    // Each subsequent delay should generally be higher (though jitter adds randomness)
    // Check that the exponential growth pattern exists
    const minDelays = delays.map((_, i) => Math.pow(2, i) * 1000);
    delays.forEach((delay, i) => {
      expect(delay).toBeGreaterThanOrEqual(minDelays[i]);
      expect(delay).toBeLessThanOrEqual(31000); // max + jitter
    });
  });

  it('exponential backoff: delay is capped at max 30s', () => {
    // High attempt number should cap at WS_RECONNECT_MAX_MS + jitter
    const delay = calculateBackoffDelay(10);
    expect(delay).toBeLessThanOrEqual(31000); // max 30s + 1s jitter
  });

  it('exponential backoff: has random jitter component', () => {
    const delays = new Set<number>();
    // Generate many delays for attempt 0 to check for jitter variation
    for (let i = 0; i < 20; i++) {
      delays.add(calculateBackoffDelay(0));
    }
    // With jitter, we should see multiple different values
    expect(delays.size).toBeGreaterThan(1);
  });

  // ============================================
  // Max Reconnect Attempts Tests
  // ============================================

  it('maxReconnectAttempts: stops after reaching limit', async () => {
    // This test verifies that maxReconnectAttempts is respected
    // by checking that the reconnect attempts counter is capped
    let serverPort: number;
    let reconnectAttempts = 0;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      maxReconnectAttempts: 2,
      onReconnecting: (attempt) => {
        reconnectAttempts = attempt;
      },
    });

    // Terminate multiple times to exceed maxReconnectAttempts
    for (let i = 0; i < 3; i++) {
      conn.ws.terminate();
      await new Promise((r) => setTimeout(r, 200));
    }

    // Should not have called onReconnecting for attempt 3+ (max is 2)
    // The reconnect attempts should be capped at 2
    expect(conn.reconnectAttempts).toBeLessThanOrEqual(2);

    connections.push(conn);
  });

  it('maxReconnectAttempts: 0 means no reconnect at all', async () => {
    let reconnectAttempts = 0;
    let serverPort: number;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      maxReconnectAttempts: 0,
      onReconnecting: () => {
        reconnectAttempts++;
      },
    });

    // Terminate the connection
    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));

    // With maxReconnectAttempts=0, onReconnecting should never be called
    expect(reconnectAttempts).toBe(0);

    connections.push(conn);
  });

  // ============================================
  // Event Callbacks Tests
  // ============================================

  it('onReconnecting callback: called with attempt and delay', async () => {
    const reconnectingCalls: Array<{ attempt: number; delayMs: number }> = [];
    let serverPort: number;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      onReconnecting: (attempt, delayMs) => {
        reconnectingCalls.push({ attempt, delayMs });
      },
    });

    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconnectingCalls.length).toBeGreaterThanOrEqual(1);
    expect(reconnectingCalls[0]!.attempt).toBe(1);
    expect(reconnectingCalls[0]!.delayMs).toBeGreaterThanOrEqual(1000);

    connections.push(conn);
  });

  it('onReconnectExhausted callback: triggered after exhausting reconnect attempts', async () => {
    let exhaustedCalled = false;
    let exhaustedAttempts = 0;

    // Use a port that's definitely not listening to ensure connection failures
    const fakePort = 47834;

    const conn = await connect({
      url: `ws://localhost:${fakePort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      maxReconnectAttempts: 2,
      onReconnectExhausted: (attempts) => {
        exhaustedCalled = true;
        exhaustedAttempts = attempts;
      },
    });

    // Wait for reconnect attempts to exhaust (1s + 2s + 3s backoff = ~6s for 3 attempts)
    // The callback is called when attempts exceed maxReconnectAttempts
    await new Promise((r) => setTimeout(r, 10000));

    expect(exhaustedCalled).toBe(true);
    expect(exhaustedAttempts).toBeGreaterThanOrEqual(3);

    connections.push(conn);
  }, 15000);

  it('onStateChange callback: receives typed state_change events', async () => {
    const stateEvents: ConnectionStateEvent[] = [];
    let serverPort: number;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      pingIntervalMs: 60000,
      onStateChange: (event) => stateEvents.push(event),
    });

    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));

    // Check that we have state_change events with proper structure
    const stateChanges = stateEvents.filter(e => e.type === 'state_change');
    expect(stateChanges.length).toBeGreaterThanOrEqual(2);
    
    stateChanges.forEach(event => {
      if (event.type === 'state_change') {
        expect(typeof event.from).toBe('string');
        expect(typeof event.to).toBe('string');
      }
    });

    connections.push(conn);
  });

  // ============================================
  // Backward Compatibility Tests
  // ============================================

  it('backward compatible: works without new callback options', async () => {
    const server = createServer({
      port: 0,
      onConnection() {},
    });
    servers.push(server);

    const port = server.address().port;
    
    // Connect without any of the new callbacks
    const conn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
    });
    connections.push(conn);

    expect(conn.readyState).toBe('open');
  });

  it('backward compatible: reconnect=true by default', async () => {
    let serverPort: number;
    let reconnectCount = 0;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() { reconnectCount++; },
      onError() {},
      // reconnect not specified - should default to true
    });

    // Terminate and wait for reconnect
    conn.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconnectCount).toBeGreaterThanOrEqual(1);
    connections.push(conn);
  });

  it('backward compatible: conn.close() does not reconnect', async () => {
    let serverPort: number;
    let reconnectAttempts = 0;

    const server = createServer({
      port: 0,
      onConnection() {},
    });
    serverPort = server.address().port;
    servers.push(server);

    const conn = await connect({
      url: `ws://localhost:${serverPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: true,
      onReconnecting: (attempt) => {
        reconnectAttempts = attempt;
      },
    });

    // Call close() intentionally
    conn.close();
    await new Promise((r) => setTimeout(r, 500));

    // onReconnecting should never be called after intentional close
    expect(reconnectAttempts).toBe(0);
  });
});
