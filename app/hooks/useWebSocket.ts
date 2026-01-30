import { useRef, useCallback, useState } from 'react';
import { ConnectionStatus, ServerMessage } from '../types';

// Ping interval to keep connection alive (45 seconds - below typical 60s timeout)
const PING_INTERVAL = 45000;

interface UseWebSocketOptions {
  onMessage: (msg: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: (code: number) => void;
}

export function useWebSocket({ onMessage, onConnect, onDisconnect }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  // Store credentials for auto-reconnect
  const credentialsRef = useRef<{ url: string; token: string } | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Send a ping to keep the connection alive
  const sendPing = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'ping' }));
    }
  }, []);

  // Reset the ping timer (call this when user is active/typing)
  const resetPingTimer = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }
    if (ws.current?.readyState === WebSocket.OPEN) {
      // Send an immediate ping when user is active
      sendPing();
      // Then continue regular interval
      pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
    }
  }, [sendPing]);

  const connect = useCallback((serverUrl: string, authToken: string) => {
    if (!serverUrl || !authToken) return;

    // Store credentials for reconnection
    credentialsRef.current = { url: serverUrl, token: authToken };

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Clear any existing ping interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    setStatus('connecting');

    let wsUrl = serverUrl.trim()
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    if (!wsUrl.startsWith('ws')) wsUrl = `wss://${wsUrl}`;
    wsUrl = `${wsUrl}?token=${encodeURIComponent(authToken.trim())}`;

    try {
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        setStatus('connected');
        // Start ping interval to keep connection alive
        pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
        onConnect();
      };

      ws.current.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          onMessage(msg);
        } catch (e) {}
      };

      ws.current.onerror = () => {
        // Don't call onDisconnect here - onclose will be called
      };

      ws.current.onclose = (event) => {
        setStatus('disconnected');
        ws.current = null;
        // Clear ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
        onDisconnect(event.code);
      };
    } catch (e) {
      setStatus('disconnected');
    }
  }, [onMessage, onConnect, onDisconnect, sendPing]);

  // Attempt to reconnect using stored credentials
  const reconnect = useCallback(() => {
    if (credentialsRef.current && status === 'disconnected') {
      console.log('Attempting to reconnect...');
      connect(credentialsRef.current.url, credentialsRef.current.token);
      return true;
    }
    return false;
  }, [connect, status]);

  const send = useCallback((type: string, data?: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type, ...data }));
      return true;
    }
    return false;
  }, []);

  // Send with auto-reconnect - attempts to reconnect if disconnected
  const sendWithReconnect = useCallback((type: string, data?: Record<string, unknown>): boolean => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type, ...data }));
      return true;
    }

    // Try to reconnect
    if (credentialsRef.current && status === 'disconnected') {
      reconnect();
    }
    return false;
  }, [status, reconnect]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    credentialsRef.current = null; // Clear credentials to prevent auto-reconnect
    ws.current?.close();
    setStatus('disconnected');
  }, []);

  return { status, connect, send, sendWithReconnect, disconnect, reconnect, resetPingTimer };
}
