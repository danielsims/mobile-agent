import { useRef, useCallback, useState } from 'react';
import { ConnectionStatus, ServerMessage } from '../types';

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

  const connect = useCallback((serverUrl: string, authToken: string) => {
    if (!serverUrl || !authToken) return;

    // Store credentials for reconnection
    credentialsRef.current = { url: serverUrl, token: authToken };

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
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
        onDisconnect(event.code);
      };
    } catch (e) {
      setStatus('disconnected');
    }
  }, [onMessage, onConnect, onDisconnect]);

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
    credentialsRef.current = null; // Clear credentials to prevent auto-reconnect
    ws.current?.close();
    setStatus('disconnected');
  }, []);

  return { status, connect, send, sendWithReconnect, disconnect, reconnect };
}
