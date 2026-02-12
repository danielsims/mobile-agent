import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
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
import { loadSessions, getSavedSessions, saveSession, removeSession } from './sessions.js';
import { readTranscript } from './transcripts.js';
import { listModelsForAgentType } from './models.js';
import { initSkills, listSkills, getSkill, updateSkill, searchSkills, installSkill } from './skills.js';
import {
  loadProjects,
  getProjects,
  getProject,
  unregisterProject,
  listWorktrees,
  createWorktree,
  removeWorktree,
  resolveProjectCwd,
  getProjectIcon,
  getGitStatus,
  getGitDiff,
  getGitBranchInfo,
  getGitLog,
} from './projects.js';

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

    // Called after any pairing attempt so the launcher can refresh the QR
    this.onPairingAttempt = null;
  }

  /**
   * Start the HTTP + WebSocket server.
   * Returns a promise that resolves when the server is listening.
   */
  start() {
    // Initialize auth keys and load saved sessions
    const { publicKeyRaw } = initializeKeys();
    loadSessions();
    loadProjects();
    initSkills();
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
        this._restoreSavedSessions();
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
        console.log(`[auth] Timeout — mobile client from ${ip} did not authenticate within ${AUTH_TIMEOUT_MS / 1000}s`);
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
        console.log(`[auth] Pairing rejected from ${ip}: missing fields`);
        this._sendTo(ws, 'authError', { error: 'Missing pairing fields.' });
        return;
      }

      const result = registerDevice(pairingToken, devicePublicKey, reqDeviceId, deviceName, ip);
      if (result.success) {
        console.log(`[auth] Pairing successful: ${deviceName || reqDeviceId} from ${ip}`);
        callback({ success: true, deviceId: reqDeviceId });
      } else {
        console.log(`[auth] Pairing rejected from ${ip}: ${result.error}`);
        this._sendTo(ws, 'authError', { error: result.error });
      }
      // Token is consumed (success) or expired/invalid — refresh QR
      this.onPairingAttempt?.();
      return;
    }

    // Challenge-response flow: existing device
    if (msg.type === 'authenticate') {
      const { payload, signature } = msg;

      if (!payload || !signature) {
        console.log(`[auth] Auth rejected from ${ip}: missing fields`);
        this._sendTo(ws, 'authError', { error: 'Missing authentication fields.' });
        return;
      }

      const result = verifyChallenge(payload, signature, ip);
      if (result.success) {
        callback({ success: true, deviceId: result.deviceId });
      } else {
        console.log(`[auth] Auth rejected from ${ip}: ${result.error}`);
        this._sendTo(ws, 'authError', { error: result.error });
      }
      return;
    }

    // Unknown auth message type
    console.log(`[auth] Unknown auth message type "${msg.type}" from ${ip}`);
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

  // --- Agent lifecycle helpers ---

  /**
   * Set up the broadcast callback for an agent session.
   * Handles broadcasting to mobile clients AND persisting session state.
   */
  _setupAgentBroadcast(session) {
    session.setOnBroadcast((id, type, data) => {
      this._broadcastToMobile(type, data);

      // Persist when sessionId arrives (from system/init or result)
      if (type === 'agentUpdated' && data.sessionId) {
        saveSession(id, {
          sessionId: data.sessionId,
          type: session.type,
          model: session.model,
          sessionName: session.sessionName,
          createdAt: session.createdAt,
          cwd: session.cwd,
        });
      }

      // Persist sessionName updates
      if (type === 'agentUpdated' && data.sessionName) {
        const saved = getSavedSessions();
        if (saved[id]) {
          saveSession(id, {
            ...saved[id],
            model: session.model || saved[id].model || null,
            sessionName: data.sessionName,
          });
        }
      }
    });
  }

  /**
   * Restore previously saved agent sessions on startup.
   * Spawns Claude processes with --resume for each saved session.
   */
  _restoreSavedSessions() {
    const saved = getSavedSessions();
    const entries = Object.entries(saved);

    if (entries.length === 0) return;

    console.log(`Restoring ${entries.length} saved agent session(s)...`);

    for (const [agentId, info] of entries) {
      if (!info.sessionId) {
        removeSession(agentId);
        continue;
      }

      const session = new AgentSession(agentId, info.type || 'claude', {
        model: info.model || null,
      });
      session.sessionId = info.sessionId;
      session.sessionName = info.sessionName || 'Restored Agent';
      session.createdAt = info.createdAt || Date.now();
      session.cwd = info.cwd || null;
      if (info.cwd) {
        session.projectName = basename(info.cwd);
        try {
          session.gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: info.cwd, encoding: 'utf-8', timeout: 3000,
          }).trim();
        } catch { /* not a git repo or git not available */ }
      }

      // Read conversation history from CLI's session storage (not our own DB)
      const transcript = readTranscript(info.type || 'claude', info.sessionId, info.cwd);
      if (transcript) {
        session.loadTranscript(transcript);
        console.log(`[Agent ${agentId.slice(0, 8)}] Loaded transcript: ${transcript.messages.length} messages, model=${transcript.model || '?'}`);
      }

      this._setupAgentBroadcast(session);
      this.agents.set(agentId, session);
      session.spawn(this.port, info.sessionId, info.cwd || null);

      logAudit('agent_restored', {
        agentId: agentId.slice(0, 8),
        sessionId: info.sessionId.slice(0, 8),
        type: info.type,
      });
    }
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

      case 'interruptAgent':
        this._handleInterruptAgent(ws, msg, deviceId);
        break;

      case 'respondPermission':
        this._handleRespondPermission(ws, msg, deviceId);
        break;

      case 'setAutoApprove':
        this._handleSetAutoApprove(ws, msg, deviceId);
        break;

      case 'getHistory':
        this._handleGetHistory(ws, msg);
        break;

      case 'listProjects':
        this._handleListProjects(ws);
        break;

      case 'listModels':
        this._handleListModels(ws, msg);
        break;

      case 'createWorktree':
        this._handleCreateWorktree(ws, msg, deviceId);
        break;

      case 'removeWorktree':
        this._handleRemoveWorktree(ws, msg, deviceId);
        break;

      case 'unregisterProject':
        this._handleUnregisterProject(ws, msg, deviceId);
        break;

      case 'getGitStatus':
        this._handleGetGitStatus(ws, msg);
        break;

      case 'getGitDiff':
        this._handleGetGitDiff(ws, msg);
        break;

      case 'getWorktreeStatus':
        this._handleGetWorktreeStatus(ws, msg);
        break;

      case 'getGitLog':
        this._handleGetGitLog(ws, msg);
        break;

      case 'listSkills':
        this._handleListSkills(ws);
        break;

      case 'getSkill':
        this._handleGetSkill(ws, msg);
        break;

      case 'updateSkill':
        this._handleUpdateSkill(ws, msg);
        break;

      case 'searchSkills':
        this._handleSearchSkills(ws, msg);
        break;

      case 'installSkill':
        this._handleInstallSkill(ws, msg);
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
    const model = typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : null;

    // Resolve working directory from project/worktree selection
    let cwd = null;
    if (msg.projectId) {
      try {
        cwd = resolveProjectCwd(msg.projectId, msg.worktreePath || null);
      } catch (e) {
        this._sendTo(ws, 'error', { error: `Invalid project/worktree: ${e.message}` });
        return;
      }
    }

    const session = new AgentSession(agentId, type, { model });

    this._setupAgentBroadcast(session);
    this.agents.set(agentId, session);
    logAudit('agent_created', { agentId: agentId.slice(0, 8), type, model: model || 'auto', deviceId, cwd: cwd || '~' });

    // Spawn the CLI process in the selected directory (or $HOME by default)
    session.spawn(this.port, null, cwd);

    this._broadcastToMobile('agentCreated', { agent: session.getSnapshot() });
  }

  async _handleListModels(ws, msg) {
    const agentType = msg.agentType || 'claude';
    try {
      const models = await listModelsForAgentType(agentType);
      this._sendTo(ws, 'modelList', {
        agentType,
        models,
      });
    } catch (e) {
      console.error(`[models] listModels failed for ${agentType}:`, e.message);
      this._sendTo(ws, 'modelList', {
        agentType,
        models: [{ value: 'auto', label: 'Auto (Recommended)', note: 'Use provider default model' }],
      });
    }
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
    removeSession(msg.agentId);
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

  async _handleInterruptAgent(ws, msg, deviceId) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    const interrupted = await session.interrupt();
    if (!interrupted) {
      this._sendTo(ws, 'error', { error: 'Agent is not currently running.' });
      return;
    }

    logAudit('agent_interrupted', { agentId: msg.agentId.slice(0, 8), deviceId });
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

  _handleSetAutoApprove(ws, msg, deviceId) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    const enabled = !!msg.enabled;
    session.autoApprove = enabled;

    // Tell the CLI to change its own permission mode
    session.setPermissionMode(enabled ? 'bypassPermissions' : 'default');

    logAudit('auto_approve_changed', {
      agentId: msg.agentId.slice(0, 8),
      deviceId,
      enabled,
    });

    // If enabling and there are pending permissions, approve them all now
    if (enabled && session.pendingPermissions.size > 0) {
      for (const [requestId] of session.pendingPermissions) {
        session.respondToPermission(requestId, 'allow');
      }
    }

    this._broadcastToMobile('agentUpdated', {
      agentId: msg.agentId,
      autoApprove: enabled,
    });
  }

  _handleGetHistory(ws, msg) {
    const session = this.agents.get(msg.agentId);
    if (!session) {
      this._sendTo(ws, 'error', { error: 'Agent not found.' });
      return;
    }

    const history = session.getHistory();
    this._sendTo(ws, 'agentHistory', {
      agentId: msg.agentId,
      messages: history.messages,
      pendingPermissions: history.pendingPermissions,
    });
  }

  // --- Project/Worktree handlers ---

  _handleListProjects(ws) {
    try {
      loadProjects(); // Reload from disk — projects may have been registered via CLI
      const all = getProjects();
      const result = [];

      for (const [id, project] of Object.entries(all)) {
        let worktrees = [];
        try {
          worktrees = listWorktrees(id);
        } catch (e) {
          console.error(`[Projects] Failed to list worktrees for ${id}:`, e.message);
        }

        let icon = null;
        try {
          icon = getProjectIcon(project.path);
        } catch (e) {
          console.error(`[Projects] Failed to get icon for ${id}:`, e.message);
        }

        result.push({
          id,
          name: project.name,
          path: project.path,
          icon,
          worktrees,
        });
      }

      console.log(`[Projects] Sending ${result.length} project(s) to mobile`);
      this._sendTo(ws, 'projectList', { projects: result });
    } catch (e) {
      console.error('[Projects] _handleListProjects failed:', e);
      this._sendTo(ws, 'projectList', { projects: [] });
    }
  }

  _handleCreateWorktree(ws, msg, deviceId) {
    const { projectId, branchName } = msg;

    if (!projectId || !branchName) {
      this._sendTo(ws, 'error', { error: 'projectId and branchName required.' });
      return;
    }

    try {
      const worktree = createWorktree(projectId, branchName);
      logAudit('worktree_created_remote', { projectId, branchName, deviceId });

      const worktrees = listWorktrees(projectId);
      this._sendTo(ws, 'worktreeCreated', { projectId, worktree, worktrees });
    } catch (e) {
      this._sendTo(ws, 'error', { error: e.message });
    }
  }

  _handleRemoveWorktree(ws, msg, deviceId) {
    const { projectId, worktreePath } = msg;

    if (!projectId || !worktreePath) {
      this._sendTo(ws, 'error', { error: 'projectId and worktreePath required.' });
      return;
    }

    try {
      removeWorktree(projectId, worktreePath);
      logAudit('worktree_removed_remote', { projectId, worktreePath, deviceId });

      const worktrees = listWorktrees(projectId);
      this._sendTo(ws, 'worktreeRemoved', { projectId, worktrees });
    } catch (e) {
      this._sendTo(ws, 'error', { error: e.message });
    }
  }

  _handleUnregisterProject(ws, msg, deviceId) {
    const { projectId } = msg;

    if (!projectId) {
      this._sendTo(ws, 'error', { error: 'projectId required.' });
      return;
    }

    try {
      loadProjects(); // Reload from disk
      const removed = unregisterProject(projectId);
      if (!removed) {
        this._sendTo(ws, 'error', { error: 'Project not found.' });
        return;
      }
      logAudit('project_unregistered_remote', { projectId, deviceId });
      // Send updated project list
      this._handleListProjects(ws);
    } catch (e) {
      this._sendTo(ws, 'error', { error: e.message });
    }
  }

  // --- Git status/diff handlers ---

  _handleGetGitStatus(ws, msg) {
    const { agentId } = msg;
    if (!agentId) {
      this._sendTo(ws, 'error', { error: 'agentId required.' });
      return;
    }

    const session = this.agents.get(agentId);
    if (!session || !session.cwd) {
      this._sendTo(ws, 'error', { error: 'Agent not found or no working directory.' });
      return;
    }

    const branchInfo = getGitBranchInfo(session.cwd);
    const files = getGitStatus(session.cwd);

    this._sendTo(ws, 'gitStatus', {
      agentId,
      branch: branchInfo.branch,
      ahead: branchInfo.ahead,
      behind: branchInfo.behind,
      files,
    });
  }

  _handleGetWorktreeStatus(ws, msg) {
    const { worktreePath } = msg;
    if (!worktreePath) {
      this._sendTo(ws, 'error', { error: 'worktreePath required.' });
      return;
    }

    // Verify the path belongs to a registered project worktree
    const all = getProjects();
    const isRegistered = Object.values(all).some(p =>
      p.path === worktreePath || worktreePath.startsWith(p.path.replace(/\/?$/, '/'))
    );
    if (!isRegistered) {
      // Also check worktree paths
      let found = false;
      for (const [id] of Object.entries(all)) {
        try {
          const wts = listWorktrees(id);
          if (wts.some(wt => wt.path === worktreePath)) { found = true; break; }
        } catch {}
      }
      if (!found) {
        this._sendTo(ws, 'error', { error: 'Worktree path not registered.' });
        return;
      }
    }

    try {
      const branchInfo = getGitBranchInfo(worktreePath);
      const files = getGitStatus(worktreePath);

      this._sendTo(ws, 'worktreeStatus', {
        worktreePath,
        branch: branchInfo.branch,
        ahead: branchInfo.ahead,
        behind: branchInfo.behind,
        files,
      });
    } catch (e) {
      this._sendTo(ws, 'error', { error: e.message });
    }
  }

  _handleGetGitDiff(ws, msg) {
    const { agentId, filePath } = msg;
    if (!agentId) {
      this._sendTo(ws, 'error', { error: 'agentId required.' });
      return;
    }

    const session = this.agents.get(agentId);
    if (!session || !session.cwd) {
      this._sendTo(ws, 'error', { error: 'Agent not found or no working directory.' });
      return;
    }

    const diff = getGitDiff(session.cwd, filePath);

    this._sendTo(ws, 'gitDiff', {
      agentId,
      filePath: filePath || null,
      diff,
    });
  }

  _handleGetGitLog(ws, msg) {
    const { projectPath, maxCount } = msg;
    console.log(`[GitLog] Request received — projectPath=${projectPath}`);
    if (!projectPath) {
      console.log('[GitLog] ERROR: no projectPath');
      this._sendTo(ws, 'error', { error: 'projectPath required.' });
      return;
    }

    const all = getProjects();
    const isRegistered = Object.values(all).some(p => p.path === projectPath);
    if (!isRegistered) {
      console.log(`[GitLog] ERROR: path not registered. Registered: ${Object.values(all).map(p => p.path).join(', ')}`);
      this._sendTo(ws, 'error', { error: 'Path is not a registered project.' });
      return;
    }

    const commits = getGitLog(projectPath, maxCount || 100);
    console.log(`[GitLog] Sending ${commits.length} commits for ${projectPath}`);
    this._sendTo(ws, 'gitLog', { projectPath, commits });
  }

  // --- Skills ---

  _handleListSkills(ws) {
    try {
      const skills = listSkills();
      console.log(`[Skills] Sending ${skills.length} skill(s) to mobile`);
      this._sendTo(ws, 'skillList', { skills });
    } catch (e) {
      console.error('[Skills] _handleListSkills failed:', e);
      this._sendTo(ws, 'skillList', { skills: [] });
    }
  }

  _handleGetSkill(ws, msg) {
    const { name } = msg;
    if (!name) {
      this._sendTo(ws, 'error', { error: 'Skill name is required.' });
      return;
    }

    try {
      const skill = getSkill(name);
      if (!skill) {
        this._sendTo(ws, 'error', { error: `Skill "${name}" not found.` });
        return;
      }
      this._sendTo(ws, 'skillContent', { skill });
    } catch (e) {
      console.error(`[Skills] _handleGetSkill failed for "${name}":`, e);
      this._sendTo(ws, 'error', { error: `Failed to load skill "${name}".` });
    }
  }

  _handleUpdateSkill(ws, msg) {
    const { name, body } = msg;
    if (!name || typeof body !== 'string') {
      this._sendTo(ws, 'error', { error: 'Skill name and body are required.' });
      return;
    }
    try {
      const updated = updateSkill(name, body);
      if (!updated) {
        this._sendTo(ws, 'error', { error: `Skill "${name}" not found or not editable.` });
        return;
      }
      this._sendTo(ws, 'skillContent', { skill: updated });
      // Refresh the full list so the app has updated data
      const skills = listSkills();
      this._sendTo(ws, 'skillList', { skills });
    } catch (e) {
      console.error(`[Skills] _handleUpdateSkill failed for "${name}":`, e);
      this._sendTo(ws, 'error', { error: `Failed to update skill "${name}".` });
    }
  }

  async _handleSearchSkills(ws, msg) {
    const { query } = msg;
    if (!query) {
      this._sendTo(ws, 'skillSearchResults', { results: [] });
      return;
    }

    // Track the search generation so stale results from earlier searches are dropped
    if (!this._skillSearchGen) this._skillSearchGen = 0;
    const gen = ++this._skillSearchGen;

    try {
      console.log(`[Skills] Searching for "${query}"...`);
      const result = await searchSkills(query);

      // If a newer search was started while this one was in-flight, discard
      if (gen !== this._skillSearchGen) {
        console.log(`[Skills] Discarding stale search results for "${query}" (gen ${gen} < ${this._skillSearchGen})`);
        return;
      }

      const results = result.results || [];
      console.log(`[Skills] Search returned ${results.length} result(s), broadcasting to mobile`);
      for (const client of this.mobileClients) {
        this._sendTo(client, 'skillSearchResults', { results });
      }
    } catch (e) {
      if (gen !== this._skillSearchGen) return;
      console.error(`[Skills] _handleSearchSkills failed:`, e);
      for (const client of this.mobileClients) {
        this._sendTo(client, 'skillSearchResults', { results: [] });
      }
    }
  }

  async _handleInstallSkill(ws, msg) {
    const { packageRef } = msg;
    if (!packageRef) {
      this._sendTo(ws, 'error', { error: 'Package reference is required.' });
      return;
    }
    const broadcast = (type, data) => {
      for (const client of this.mobileClients) this._sendTo(client, type, data);
    };
    try {
      broadcast('skillInstallProgress', { packageRef, status: 'installing' });
      console.log(`[Skills] Installing "${packageRef}"...`);
      const result = await installSkill(packageRef);
      if (result.success) {
        console.log(`[Skills] Installed "${packageRef}" successfully`);
        const skills = listSkills();
        broadcast('skillList', { skills });
        broadcast('skillInstallProgress', { packageRef, status: 'installed', output: result.output });
      } else {
        broadcast('skillInstallProgress', { packageRef, status: 'error', error: result.error });
      }
    } catch (e) {
      console.error(`[Skills] _handleInstallSkill failed for "${packageRef}":`, e);
      broadcast('skillInstallProgress', { packageRef, status: 'error', error: e.message });
    }
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
