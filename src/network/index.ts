import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { WsMessage } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('network');
import {
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  MAX_MESSAGE_SIZE,
} from '../config/bootstrap.js';

// Reconnect configuration constants
const WS_RECONNECT_BASE_MS = 1000; // 1s base
const WS_RECONNECT_MAX_MS = 30000; // 30s max
const WS_RECONNECT_MULTIPLIER = 2;  // 2x exponential
const WS_RECONNECT_JITTER_MAX_MS = 1000; // 0-1s random jitter
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

// Connection state machine states
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting';

// State machine events
export type ConnectionStateEvent =
  | { type: 'state_change'; from: ConnectionState; to: ConnectionState }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'reconnect_exhausted'; attempts: number }
  | { type: 'max_attempts_reached'; attempts: number };

export interface Connection {
  ws: WebSocket;
  send(msg: WsMessage): void;
  close(): void;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  readonly state: ConnectionState;
  onStateChange?: (event: ConnectionStateEvent) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  onReconnectExhausted?: (attempts: number) => void;
  reconnectAttempts: number;
}

export interface ConnectionOptions {
  url: string;
  onMessage: (msg: WsMessage) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  reconnect?: boolean;
  pingIntervalMs?: number;
  maxReconnectAttempts?: number;
  onStateChange?: (event: ConnectionStateEvent) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  onReconnectExhausted?: (attempts: number) => void;
}

const WS_STATE_MAP: Record<number, Connection['readyState']> = {
  [WebSocket.CONNECTING]: 'connecting',
  [WebSocket.OPEN]: 'open',
  [WebSocket.CLOSING]: 'closing',
  [WebSocket.CLOSED]: 'closed',
};

function wrapConnection(ws: WebSocket): Connection {
  return {
    ws,
    send(msg: WsMessage): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      ws.close();
    },
    get readyState(): Connection['readyState'] {
      return WS_STATE_MAP[ws.readyState] ?? 'closed';
    },
    get state(): ConnectionState {
      return 'connected';
    },
    reconnectAttempts: 0,
  };
}

/**
 * Calculate exponential backoff delay with jitter
 * @param attempt - Current reconnection attempt (0-indexed)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(attempt: number): number {
  // Exponential: base * multiplier^attempt
  const exponentialDelay = WS_RECONNECT_BASE_MS * Math.pow(WS_RECONNECT_MULTIPLIER, attempt);
  // Cap at max
  const cappedDelay = Math.min(exponentialDelay, WS_RECONNECT_MAX_MS);
  // Add random jitter 0-1s
  const jitter = Math.random() * WS_RECONNECT_JITTER_MAX_MS;
  return Math.floor(cappedDelay + jitter);
}

export function connect(options: ConnectionOptions): Promise<Connection> {
  const {
    url,
    onMessage,
    onClose,
    onError,
    reconnect = true,
    pingIntervalMs = PING_INTERVAL_MS,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    onStateChange,
    onReconnecting,
    onReconnectExhausted,
  } = options;

  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let intentionallyClosed = false;
  let isFirstConnect = true;
  let currentReconnectAttempt = 0;
  let connectionState: ConnectionState = 'connecting';
  let reconnectExhausted = false;

  // Shared connection object
  const conn: Connection = {
    ws: null as unknown as WebSocket,
    get state() { return connectionState; },
    send(msg: WsMessage): void {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      intentionallyClosed = true;
      setState('disconnecting');
      cleanup();
      this.ws?.close();
      setState('disconnected');
    },
    get readyState(): Connection['readyState'] {
      return WS_STATE_MAP[this.ws?.readyState ?? WebSocket.CLOSED] ?? 'closed';
    },
    onStateChange,
    onReconnecting,
    onReconnectExhausted,
    reconnectAttempts: 0,
  };

  function setState(newState: ConnectionState): void {
    const oldState = connectionState;
    connectionState = newState;
    if (onStateChange) {
      onStateChange({ type: 'state_change', from: oldState, to: newState });
    }
  }

  function cleanup(): void {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
  }

  function setupPing(ws: WebSocket): void {
    cleanup();
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        pongTimeout = setTimeout(() => {
          log.warn('pong_timeout', { url });
          ws.terminate();
        }, PONG_TIMEOUT_MS);
      }
    }, pingIntervalMs);

    ws.on('pong', () => {
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    });
  }

  function doConnect(resolve: () => void, reject: (err: Error) => void): void {
    const ws = new WebSocket(url, { maxPayload: MAX_MESSAGE_SIZE });

    ws.on('open', () => {
      currentReconnectAttempt = 0;
      conn.reconnectAttempts = 0;
      reconnectExhausted = false;
      isFirstConnect = false;
      setState('connected');
      setupPing(ws);
      resolve();
    });

    ws.on('message', (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        onMessage(msg);
      } catch {
        log.error('invalid_ws_message');
      }
    });

    ws.on('close', (code, reason) => {
      cleanup();
      const oldState = connectionState;
      setState('disconnected');
      onClose(code, reason.toString());

      // Check if we should attempt reconnect
      if (reconnect && !intentionallyClosed && !reconnectExhausted) {
        currentReconnectAttempt++;
        conn.reconnectAttempts = currentReconnectAttempt;

        // Check if max attempts reached
        if (currentReconnectAttempt > maxReconnectAttempts) {
          reconnectExhausted = true;
          log.error('reconnect_exhausted', { url, attempts: currentReconnectAttempt });
          if (onReconnectExhausted) {
            onReconnectExhausted(currentReconnectAttempt);
          }
          if (onStateChange) {
            onStateChange({ type: 'reconnect_exhausted', attempts: currentReconnectAttempt });
            onStateChange({ type: 'max_attempts_reached', attempts: currentReconnectAttempt });
          }
          // Resolve the promise so caller can continue - reconnect exhausted
          resolve();
          return;
        }

        isFirstConnect = false;

        const delay = calculateBackoffDelay(currentReconnectAttempt - 1);
        if (onReconnecting) {
          onReconnecting(currentReconnectAttempt, delay);
        }
        if (onStateChange) {
          onStateChange({ type: 'reconnecting', attempt: currentReconnectAttempt, delayMs: delay });
        }

        setState('reconnecting');
        setTimeout(() => {
          doConnect(resolve, reject);
        }, delay);
      }
    });

    ws.on('error', (err) => {
      onError(err);
      // Only reject on first connect failure if reconnect is disabled
      if (isFirstConnect && !reconnect && ws.readyState !== WebSocket.OPEN) {
        reject(err);
      }
    });

    // Attach ws to conn after ws is created
    conn.ws = ws;
  }

  return new Promise<Connection>((resolveConnection, rejectConnection) => {
    doConnect(
      () => {
        // Connection established or reconnect exhausted
        isFirstConnect = false;
        resolveConnection(conn);
      },
      (err: Error) => {
        // First connect failed with reconnect disabled
        isFirstConnect = false;
        resolveConnection(conn);
      }
    );
  });
}

export function createServer(options: {
  port: number;
  onConnection: (conn: Connection, req: IncomingMessage) => void;
}): { close(): void; port: number; address: () => { port: number } } {
  const wss = new WebSocketServer({
    port: options.port,
    maxPayload: MAX_MESSAGE_SIZE,
  });

  wss.on('connection', (ws, req) => {
    const conn = wrapConnection(ws);
    options.onConnection(conn, req);
  });

  return {
    close() { wss.close(); },
    get port() { return (wss.address() as { port: number }).port; },
    address() { return wss.address() as { port: number }; },
  };
}
