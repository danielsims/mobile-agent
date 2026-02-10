import { useRef, useCallback, useState } from 'react';
import type { ConnectionStatus, ServerMessage } from '../types';
import { buildAuthMessage, buildPairMessage, getWebSocketUrl, type QRPairingData } from '../utils/auth';

// Ping interval to keep connection alive (45 seconds - below typical 60s timeout)
const PING_INTERVAL = 45_000;

// Auto-reconnect settings
const RECONNECT_DELAY = 2_000;
const MAX_RECONNECT_DELAY = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Timeout for pairing/auth to complete before giving up
const AUTH_TIMEOUT_MS = 15_000;

export type AuthStatus = 'none' | 'authenticating' | 'authenticated' | 'failed';

interface UseWebSocketOptions {
  onMessage: (msg: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: (code: number, willReconnect: boolean) => void;
  onAuthError?: (error: string) => void;
}

export function useWebSocket({ onMessage, onConnect, onDisconnect, onAuthError }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [authStatus, setAuthStatus] = useState<AuthStatus>('none');

  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const autoReconnectRef = useRef(true);
  const isAuthenticatedRef = useRef(false);

  const sendPing = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN && isAuthenticatedRef.current) {
      ws.current.send(JSON.stringify({ type: 'ping' }));
    }
  }, []);

  const resetPingTimer = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }
    if (ws.current?.readyState === WebSocket.OPEN && isAuthenticatedRef.current) {
      sendPing();
      pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
    }
  }, [sendPing]);

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

  /**
   * Connect using stored credentials (Ed25519 signed challenge).
   * This is the normal auth flow after initial pairing.
   */
  const connect = useCallback(async (isReconnect = false) => {
    const wsUrl = await getWebSocketUrl();
    if (!wsUrl) return;

    autoReconnectRef.current = true;
    if (!isReconnect) {
      reconnectAttemptsRef.current = 0;
    }

    // Close any existing connection before opening a new one
    if (ws.current) {
      const oldWs = ws.current;
      ws.current = null;
      oldWs.onclose = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch {}
    }

    cleanupTimers();
    setStatus('connecting');
    isAuthenticatedRef.current = false;
    setAuthStatus('none');

    try {
      // Connect to /ws/mobile — no auth in URL
      ws.current = new WebSocket(wsUrl);

      // Timeout — if auth doesn't complete, don't hang silently
      const connectTimeout = setTimeout(() => {
        if (!isAuthenticatedRef.current && ws.current) {
          console.warn('[useWebSocket] Auth timed out after', AUTH_TIMEOUT_MS, 'ms');
          ws.current.close();
        }
      }, AUTH_TIMEOUT_MS);

      ws.current.onopen = async () => {
        // WebSocket is open — now authenticate with signed challenge
        setAuthStatus('authenticating');

        const authMsg = await buildAuthMessage();
        if (!authMsg || ws.current?.readyState !== WebSocket.OPEN) {
          clearTimeout(connectTimeout);
          setAuthStatus('failed');
          ws.current?.close();
          return;
        }

        ws.current.send(JSON.stringify(authMsg));
      };

      ws.current.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        // Handle auth errors before we're authenticated
        if (!isAuthenticatedRef.current) {
          if (msg.type === 'authError') {
            clearTimeout(connectTimeout);
            setAuthStatus('failed');
            autoReconnectRef.current = false; // Don't retry bad auth
            onAuthError?.(msg.error || 'Authentication failed');
            ws.current?.close();
            return;
          }

          // First successful message means we're authenticated
          // The server sends 'connected' with agent snapshots after auth succeeds
          if (msg.type === 'connected') {
            clearTimeout(connectTimeout);
            isAuthenticatedRef.current = true;
            setAuthStatus('authenticated');
            setStatus('connected');
            reconnectAttemptsRef.current = 0;
            // Send an immediate ping to keep tunnel alive, then start interval
            sendPing();
            pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
            onConnect();
          }
        }

        // Forward all messages (including the initial 'connected') to the handler
        if (isAuthenticatedRef.current) {
          onMessage(msg);
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

        // Don't auto-reconnect on auth failure, explicit disconnect, or superseded connection
        const shouldReconnect =
          autoReconnectRef.current &&
          event.code !== 1000 && // Normal closure
          event.code !== 4001 && // Auth failure
          event.code !== 4008 && // Auth timeout
          event.code !== 4010 && // Superseded by new connection
          reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS;

        if (shouldReconnect) {
          setStatus('connecting');
          const delay = Math.min(
            RECONNECT_DELAY * Math.pow(1.5, reconnectAttemptsRef.current),
            MAX_RECONNECT_DELAY,
          );
          reconnectAttemptsRef.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            connect(true);
          }, delay);
        } else {
          setStatus('disconnected');
          setAuthStatus('none');
        }

        onDisconnect(event.code, shouldReconnect);
      };
    } catch {
      setStatus('disconnected');
      setAuthStatus('none');
    }
  }, [onMessage, onConnect, onDisconnect, onAuthError, sendPing, cleanupTimers]);

  /**
   * Pair with the server using QR code data, then authenticate.
   * Used for initial device registration.
   */
  const pair = useCallback(async (qrData: QRPairingData) => {
    autoReconnectRef.current = false; // Don't reconnect during pairing

    // Close any existing connection before opening a new one
    // This prevents orphaned WebSocket connections on re-pair
    if (ws.current) {
      const oldWs = ws.current;
      ws.current = null;
      oldWs.onclose = null; // Prevent old close handler from firing
      oldWs.onmessage = null;
      oldWs.onerror = null;
      try { oldWs.close(); } catch {}
    }

    cleanupTimers();
    setStatus('connecting');
    isAuthenticatedRef.current = false;
    setAuthStatus('authenticating');

    // Build the pairing message (also stores server info and generates keypair)
    const pairMsg = await buildPairMessage(qrData);

    // Connect to the server's mobile endpoint
    const base = qrData.url.replace(/\/+$/, '');
    const wsUrl = base.startsWith('https://') ? base.replace('https://', 'wss://') :
                  base.startsWith('http://') ? base.replace('http://', 'ws://') :
                  base;
    const fullUrl = `${wsUrl}/ws/mobile`;

    try {
      ws.current = new WebSocket(fullUrl);

      // Timeout — if pairing doesn't complete, surface an error
      const pairTimeout = setTimeout(() => {
        if (!isAuthenticatedRef.current && ws.current) {
          console.warn('[useWebSocket] Pairing timed out after', AUTH_TIMEOUT_MS, 'ms');
          onAuthError?.('Pairing timed out. Make sure the server is running and the QR code is fresh.');
          ws.current.close();
        }
      }, AUTH_TIMEOUT_MS);

      ws.current.onopen = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify(pairMsg));
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
            clearTimeout(pairTimeout);
            setAuthStatus('failed');
            setStatus('disconnected');
            onAuthError?.(msg.error || 'Pairing failed');
            ws.current?.close();
            return;
          }

          if (msg.type === 'connected') {
            clearTimeout(pairTimeout);
            isAuthenticatedRef.current = true;
            setAuthStatus('authenticated');
            setStatus('connected');
            autoReconnectRef.current = true;
            // Send an immediate ping to keep tunnel alive, then start interval
            sendPing();
            pingIntervalRef.current = setInterval(sendPing, PING_INTERVAL);
            onConnect();
          }
        }

        if (isAuthenticatedRef.current) {
          onMessage(msg);
        }
      };

      ws.current.onerror = () => {};

      ws.current.onclose = (event) => {
        clearTimeout(pairTimeout);
        const wasPaired = isAuthenticatedRef.current;
        ws.current = null;
        isAuthenticatedRef.current = false;

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // If we were successfully paired and connection dropped,
        // use the normal connect() flow to auto-reconnect with signed challenge.
        const willReconnect = wasPaired && autoReconnectRef.current && event.code !== 1000;
        if (willReconnect) {
          setStatus('connecting');
          reconnectAttemptsRef.current = 0;
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, RECONNECT_DELAY);
        } else if (!wasPaired) {
          setStatus('disconnected');
          setAuthStatus('failed');
        } else {
          setStatus('disconnected');
          setAuthStatus('none');
        }

        onDisconnect(event.code, willReconnect);
      };
    } catch {
      setStatus('disconnected');
      setAuthStatus('failed');
    }
  }, [onMessage, onConnect, onDisconnect, onAuthError, sendPing, cleanupTimers, connect]);

  /**
   * Send a message to the server. Only works if authenticated.
   */
  const send = useCallback((type: string, data?: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN && isAuthenticatedRef.current) {
      ws.current.send(JSON.stringify({ ...data, type }));
      return true;
    }
    return false;
  }, []);

  /**
   * Disconnect and clean up.
   */
  const disconnect = useCallback(() => {
    autoReconnectRef.current = false;
    isAuthenticatedRef.current = false;
    cleanupTimers();
    ws.current?.close();
    setStatus('disconnected');
    setAuthStatus('none');
  }, [cleanupTimers]);

  /**
   * Attempt reconnection using stored credentials.
   */
  const reconnect = useCallback(() => {
    if (status === 'disconnected') {
      connect();
      return true;
    }
    return false;
  }, [connect, status]);

  return {
    status,
    authStatus,
    connect,
    pair,
    send,
    disconnect,
    reconnect,
    resetPingTimer,
  };
}
