import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { URL } from 'node:url';
import { AgentSession } from './AgentSession.js';
import {
  initializeKeys,
  generatePairingToken,
  getServerPublicKeyRaw,
  registerDevice,
  verifyChallenge,
  hasDevices,
  logAudit,
} from './auth.js';

const MAX_CONCURRENT_AGENTS = 10;
const IDLE_TIMEOUT_MS = 30 * 60_000; // 30 minutes
const AUTH_TIMEOUT_MS = 10_000; // 10 seconds to authenticate after WebSocket connect

export class Bridge {
  constructor(port) {
    this.port = port;
    this.agents = new Map(); // agentId -> AgentSession
    this.mobileClients = new Set(); // authenticated mobile WebSocket connections
    this.httpServer = null;
    this.wss = null;

    // Idle timeout tracking per mobile client
    this._idleTimers = new Map(); // ws -> timeout handle
  }

  /**
   * Start the HTTP + WebSocket server.
   * Returns a promise that resolves when the server is listening.
   */
  start() {
    // Initialize auth keys
    const { publicKeyRaw } = initializeKeys();
    console.log(`Server public key: ${publicKeyRaw.toString('hex').slice(0, 16)}...`);

    return new Promise((resolve) => {
      this.httpServer = createServer((req, res) => {
        this._handleHttp(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true });

      // Handle WebSocket upgrades with path-based routing
      this.httpServer.on('upgrade', (req, socket, head) => {
        this._handleUpgrade(req, socket, head);
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        console.log(`Bridge listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Get pairing info for the QR code.
   */
  getPairingInfo(tunnelUrl) {
    const pairingToken = generatePairingToken();
    const serverPublicKey = getServerPublicKeyRaw().toString('hex');

    return {
      url: tunnelUrl,
      pairingToken,
      serverPublicKey,
    };
  }

  // --- HTTP handlers ---

  _handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        agents: this.agents.size,
        clients: this.mobileClients.size,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  // --- WebSocket upgrade routing ---

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    // CLI connections: /ws/cli/:agentId
    const cliMatch = pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const agentId = cliMatch[1];
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._handleCliConnection(ws, agentId);
      });
      return;
    }

    // Mobile connections: /ws/mobile
    if (pathname === '/ws/mobile') {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._handleMobileConnection(ws, req);
      });
      return;
    }

    // Unknown path — reject
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }

  // --- CLI WebSocket handling ---

  _handleCliConnection(ws, agentId) {
    const session = this.agents.get(agentId);
    if (!session) {
      console.log(`CLI connected for unknown agent ${agentId}, closing`);
      ws.close(4004, 'Unknown agent');
      return;
    }

    logAudit('cli_connected', { agentId: agentId.slice(0, 8) });
    session.attachCliSocket(ws);
  }

  // --- Mobile WebSocket handling ---

  _handleMobileConnection(ws, req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    let authenticated = false;
    let deviceId = null;

    logAudit('mobile_connect_attempt', { ip });

    // The client must send an auth message within AUTH_TIMEOUT_MS
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        logAudit('mobile_auth_timeout', { ip });
        ws.close(4008, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // Ignore non-JSON
      }

      // Before authentication, only accept auth messages
      if (!authenticated) {
        this._handleAuthMessage(ws, msg, ip, authTimeout, (result) => {
          if (result.success) {
            authenticated = true;
            deviceId = result.deviceId;
            clearTimeout(authTimeout);
            this._onMobileAuthenticated(ws, deviceId, ip);
          }
        });
        return;
      }

      // Authenticated — handle regular messages
      this._resetIdleTimer(ws);
      this._handleMobileMessage(ws, msg, deviceId, ip);
    });

    ws.on('close', () => {
      this.mobileClients.delete(ws);
      this._clearIdleTimer(ws);
      if (authenticated) {
        logAudit('mobile_disconnected', { ip, deviceId });
        console.log(`Mobile client disconnected: ${deviceId}`);
      }
    });

    ws.on('error', (err) => {
      console.error(`Mobile WebSocket error (${ip}):`, err.message);
    });
  }

  _handleAuthMessage(ws, msg, ip, authTimeout, callback) {
    // Pairing flow: new device registration
    if (msg.type === 'pair') {
      const { pairingToken, devicePublicKey, deviceId: reqDeviceId, deviceName } = msg;

      if (!pairingToken || !devicePublicKey || !reqDeviceId) {
        this._sendTo(ws, 'authError', { error: 'Missing pairing fields.' });
        return;
      }

      const result = registerDevice(pairingToken, devicePublicKey, reqDeviceId, deviceName, ip);
      if (result.success) {
        callback({ success: true, deviceId: reqDeviceId });
      } else {
        this._sendTo(ws, 'authError', { error: result.error });
      }
      return;
    }

    // Challenge-response flow: existing device
    if (msg.type === 'authenticate') {
      const { payload, signature } = msg;

      if (!payload || !signature) {
        this._sendTo(ws, 'authError', { error: 'Missing authentication fields.' });
        return;
      }

      const result = verifyChallenge(payload, signature, ip);
      if (result.success) {
        callback({ success: true, deviceId: result.deviceId });
      } else {
        this._sendTo(ws, 'authError', { error: result.error });
      }
      return;
    }

    // Unknown auth message type
    this._sendTo(ws, 'authError', { error: 'Send "authenticate" or "pair" as first message.' });
  }

  _onMobileAuthenticated(ws, deviceId, ip) {
    // Enforce 1 connection per device — close any existing connection
    for (const existing of this.mobileClients) {
      if (existing._deviceId === deviceId) {
        logAudit('mobile_superseded', { ip, deviceId });
        this._clearIdleTimer(existing);
        existing.close(4010, 'Superseded by new connection');
        this.mobileClients.delete(existing);
      }
    }

    ws._deviceId = deviceId;
    this.mobileClients.add(ws);
    logAudit('mobile_authenticated', { ip, deviceId });
    console.log(`Mobile client authenticated: ${deviceId} from ${ip}`);

    // Send the connected message with current agent list
    const agents = Array.from(this.agents.values()).map(a => a.getSnapshot());
    this._sendTo(ws, 'connected', { deviceId, agents });

    // Start idle timer
    this._resetIdleTimer(ws);
  }

  // --- Mobile message handlers ---

  _handleMobileMessage(ws, msg, deviceId, ip) {
    switch (msg.type) {
      case 'createAgent':
        this._handleCreateAgent(ws, msg, deviceId);
        break;

      case 'destroyAgent':
        this._handleDestroyAgent(ws, msg, deviceId);
        break;

      case 'listAgents':
        this._handleListAgents(ws);
        break;

      case 'sendMessage':
        this._handleSendMessage(ws, msg, deviceId);
        break;

      case 'respondPermission':
        this._handleRespondPermission(ws, msg, deviceId);
        break;

      case 'getHistory':
        this._handleGetHistory(ws, msg);
        break;

      case 'ping':
        this._sendTo(ws, 'pong');
        break;

      case 'pair':
      case 'authenticate':
        // Ignore auth messages on already-authenticated connections.
        // This happens when the QR scanner fires multiple times and
        // pair messages arrive on a connection that's already authed.
        break;

      default:
        console.log(`Unknown mobile message type: ${msg.type}`);
    }
  }

  _handleCreateAgent(ws, msg, deviceId) {
    if (this.agents.size >= MAX_CONCURRENT_AGENTS) {
      this._sendTo(ws, 'error', { error: `Maximum ${MAX_CONCURRENT_AGENTS} concurrent agents.` });
      return;
    }

    const agentId = uuidv4();
    const type = msg.agentType || 'claude';
    const session = new AgentSession(agentId, type);

    session.setOnBroadcast((id, type, data) => {
      this._broadcastToMobile(type, data);
    });

    this.agents.set(agentId, session);
    logAudit('agent_created', { agentId: agentId.slice(0, 8), type, deviceId });

    // Spawn the CLI process (it will connect back to /ws/cli/:agentId)
    session.spawn(this.port);

    this._broadcastToMobile('agentCreated', { agent: session.getSnapshot() });
  }

  _handleDestroyAgent(ws, msg, deviceId) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    logAudit('agent_destroyed', { agentId: msg.agentId.slice(0, 8), deviceId });
    session.destroy();
    this.agents.delete(msg.agentId);
    this._broadcastToMobile('agentDestroyed', { agentId: msg.agentId });
  }

  _handleListAgents(ws) {
    const agents = Array.from(this.agents.values()).map(a => a.getSnapshot());
    this._sendTo(ws, 'agentList', { agents });
  }

  _handleSendMessage(ws, msg, deviceId) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    const text = msg.text;
    if (!text || typeof text !== 'string') {
      this._sendTo(ws, 'error', { error: 'Message text required.' });
      return;
    }

    logAudit('message_sent', { agentId: msg.agentId.slice(0, 8), deviceId, length: text.length });
    session.sendPrompt(text);

    // Echo the user message to all mobile clients
    this._broadcastToMobile('userMessage', { agentId: msg.agentId, content: text });
  }

  _handleRespondPermission(ws, msg, deviceId) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    const { requestId, behavior } = msg;
    if (!requestId || !behavior || !['allow', 'deny'].includes(behavior)) {
      this._sendTo(ws, 'error', { error: 'Invalid permission response.' });
      return;
    }

    logAudit('permission_response', {
      agentId: msg.agentId.slice(0, 8),
      deviceId,
      requestId: requestId.slice(0, 8),
      behavior,
    });

    const success = session.respondToPermission(requestId, behavior, msg.updatedInput);
    if (!success) {
      this._sendTo(ws, 'error', { error: 'Permission request not found or already handled.' });
    }
  }

  _handleGetHistory(ws, msg) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    this._sendTo(ws, 'agentHistory', {
      agentId: msg.agentId,
      messages: session.getHistory(),
    });
  }

  // --- Broadcasting ---

  _sendTo(ws, type, data = {}) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, ...data, ts: Date.now() }));
    }
  }

  _broadcastToMobile(type, data = {}) {
    const msg = JSON.stringify({ type, ...data, ts: Date.now() });
    for (const client of this.mobileClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  // --- Idle timeout ---

  _resetIdleTimer(ws) {
    this._clearIdleTimer(ws);
    this._idleTimers.set(ws, setTimeout(() => {
      logAudit('mobile_idle_timeout', {});
      ws.close(4009, 'Idle timeout');
    }, IDLE_TIMEOUT_MS));
  }

  _clearIdleTimer(ws) {
    const timer = this._idleTimers.get(ws);
    if (timer) {
      clearTimeout(timer);
      this._idleTimers.delete(ws);
    }
  }

  // --- Cleanup ---

  /**
   * Gracefully shut down all agents and close the server.
   */
  shutdown() {
    console.log('Bridge shutting down...');

    for (const [id, session] of this.agents) {
      session.destroy();
    }
    this.agents.clear();

    for (const client of this.mobileClients) {
      try { client.close(1001, 'Server shutting down'); } catch {}
    }
    this.mobileClients.clear();

    for (const timer of this._idleTimers.values()) {
      clearTimeout(timer);
    }
    this._idleTimers.clear();

    if (this.wss) {
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }
}
