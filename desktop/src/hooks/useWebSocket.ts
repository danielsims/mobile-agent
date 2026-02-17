import { useRef, useCallback, useState, useEffect } from 'react';
import type { ConnectionStatus, ServerMessage } from '@shared/types';

const PING_INTERVAL = 45_000;
const RECONNECT_DELAY = 2_000;
const MAX_RECONNECT_DELAY = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const AUTH_TIMEOUT_MS = 15_000;

interface UseWebSocketOptions {
  onMessage: (msg: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: (code: number, willReconnect: boolean) => void;
}

export function useWebSocket({ onMessage, onConnect, onDisconnect }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  // Use refs so WebSocket handlers always call the latest callbacks
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);

  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onConnectRef.current = onConnect; }, [onConnect]);
  useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);

  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const autoReconnectRef = useRef(true);
  const isAuthenticatedRef = useRef(false);
  const connectionParamsRef = useRef<{ port: number; token: string } | null>(null);
  const connectRef = useRef<((port: number, token: string, isReconnect?: boolean) => void) | null>(null);

  const sendPing = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN && isAuthenticatedRef.current) {
      ws.current.send(JSON.stringify({ type: 'ping' }));
    }
  }, []);

  const cleanupTimers = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback((port: number, token: string, isReconnect = false) => {
    connectionParamsRef.current = { port, token };
    autoReconnectRef.current = true;
    if (!isReconnect) {
      reconnectAttemptsRef.current = 0;
    }

    // Close any existing connection
    if (ws.current) {
      const oldWs = ws.current;
      ws.current = null;
      oldWs.onclose = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch { /* ignore */ }
    }

    cleanupTimers();
    setStatus('connecting');
    isAuthenticatedRef.current = false;

    try {
      const wsUrl = `ws://127.0.0.1:${port}/ws/mobile`;
      ws.current = new WebSocket(wsUrl);

      const connectTimeout = setTimeout(() => {
        if (!isAuthenticatedRef.current && ws.current) {
          ws.current.close();
        }
      }, AUTH_TIMEOUT_MS);

      ws.current.onopen = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ type: 'desktopAuth', token }));
        }
      };

      ws.current.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!isAuthenticatedRef.current) {
          if (msg.type === 'authError') {
            clearTimeout(connectTimeout);
            autoReconnectRef.current = false;
            ws.current?.close();
            return;
          }

          if (msg.type === 'connected') {
            clearTimeout(connectTimeout);
            isAuthenticatedRef.current = true;
            setStatus('connected');
            reconnectAttemptsRef.current = 0;
            sendPing();
            pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
            onConnectRef.current();
          }
        }

        if (isAuthenticatedRef.current) {
          onMessageRef.current(msg);
        }
      };

      ws.current.onerror = () => {
        // onclose will fire after this
      };

      ws.current.onclose = (event) => {
        clearTimeout(connectTimeout);
        ws.current = null;
        isAuthenticatedRef.current = false;

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        const shouldReconnect =
          autoReconnectRef.current &&
          event.code !== 1000 &&
          event.code !== 4001 &&
          event.code !== 4008 &&
          event.code !== 4010 &&
          reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS;

        if (shouldReconnect && connectionParamsRef.current) {
          setStatus('connecting');
          const delay = Math.min(
            RECONNECT_DELAY * Math.pow(1.5, reconnectAttemptsRef.current),
            MAX_RECONNECT_DELAY,
          );
          reconnectAttemptsRef.current++;
          const params = connectionParamsRef.current;
          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current?.(params.port, params.token, true);
          }, delay);
        } else {
          setStatus('disconnected');
        }

        onDisconnectRef.current(event.code, shouldReconnect);
      };
    } catch {
      setStatus('disconnected');
    }
  }, [sendPing, cleanupTimers]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  const send = useCallback((type: string, data?: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN && isAuthenticatedRef.current) {
      ws.current.send(JSON.stringify({ ...data, type }));
      return true;
    }
    return false;
  }, []);

  const disconnect = useCallback(() => {
    autoReconnectRef.current = false;
    isAuthenticatedRef.current = false;
    cleanupTimers();
    ws.current?.close();
    setStatus('disconnected');
  }, [cleanupTimers]);

  return {
    status,
    connect,
    send,
    disconnect,
  };
}
