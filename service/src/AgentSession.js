// AgentSession — transport-agnostic agent lifecycle manager.
//
// Delegates all protocol-specific work to a driver (ClaudeDriver, CodexDriver, etc.)
// and manages the common concerns: message history, permissions, cost tracking,
// broadcasting to mobile clients, and git branch detection.

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { createDriver } from './drivers/index.js';

const MAX_HISTORY = 200;
const MAX_LAST_OUTPUT = 2000;

let historyMsgSeq = 0;
function nextHistoryId(suffix) {
  return `h-${++historyMsgSeq}-${suffix}`;
}

export class AgentSession {
  constructor(id, type = 'claude', opts = {}) {
    this.id = id;
    this.type = type;
    this.status = 'starting';
    this.sessionId = null;
    this.sessionName = null;
    this.messageHistory = [];
    this.pendingPermissions = new Map();
    this.model = opts.model || null;
    this.tools = [];
    this.cwd = null;
    this.gitBranch = null;
    this.projectName = null;
    this.totalCost = 0;
    this.contextUsedPercent = 0;
    this.outputTokens = 0;
    this.lastOutput = '';
    this.createdAt = Date.now();
    this.autoApprove = false;

    this._currentStreamContent = '';
    this._onBroadcast = null;
    this._initialized = false;

    // Create the appropriate driver for this agent type
    this.driver = createDriver(type);
    this._bindDriverEvents();
  }

  /**
   * Wire up normalized events from the driver to AgentSession state + broadcasts.
   */
  _bindDriverEvents() {
    const d = this.driver;

    d.on('init', (data) => {
      if (data.sessionId) this.sessionId = data.sessionId;
      if (data.model) this.model = data.model;
      if (data.tools) this.tools = data.tools;
      if (data.cwd) {
        this.cwd = data.cwd;
        this.projectName = data.projectName || basename(data.cwd);
      }
      if (data.gitBranch !== undefined) this.gitBranch = data.gitBranch;
      if (data.projectName) this.projectName = data.projectName;
      this._initialized = true;
      // Initialization means the session is ready, not actively executing.
      // Keep explicit active/error states if they already exist.
      if (['starting', 'connected'].includes(this.status)) {
        this.status = 'idle';
      }

      console.log(`[Agent ${this.id.slice(0, 8)}] Init: type=${this.type}, model=${this.model}, cwd=${this.projectName || '?'}, branch=${this.gitBranch || '?'}`);
      this._broadcast('agentUpdated', {
        agentId: this.id,
        sessionId: this.sessionId,
        model: this.model,
        tools: this.tools,
        cwd: this.cwd,
        gitBranch: this.gitBranch,
        projectName: this.projectName,
        status: this.status,
      });
    });

    d.on('stream', (data) => {
      const text = data.text || '';
      if (text) {
        this._currentStreamContent += text;
        this._updateLastOutput(text);
        this._broadcast('streamChunk', { agentId: this.id, text });
      }
    });

    d.on('message', (data) => {
      this._currentStreamContent = '';
      const content = data.content || [];

      // Extract text for lastOutput
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this._updateLastOutput(block.text);
        }
      }

      this.messageHistory.push({
        id: nextHistoryId('assistant'),
        type: 'assistant',
        content,
        timestamp: Date.now(),
      });
      this._trimHistory();

      this._broadcast('assistantMessage', { agentId: this.id, content });
    });

    d.on('result', (data) => {
      const cost = data.totalCost || data.cost || 0;
      const usage = data.usage || {};
      const duration = data.duration || 0;
      const isError = data.isError || false;

      if (cost > 0) this.totalCost = cost; // cumulative
      this.outputTokens += usage.output_tokens || 0;
      if (usage.input_tokens != null) {
        const totalInput = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        this.contextUsedPercent = Math.min(100, Math.round((totalInput / 200000) * 100));
      }

      if (!this.sessionId && data.sessionId) {
        this.sessionId = data.sessionId;
      }

      this._broadcast('agentResult', {
        agentId: this.id,
        cost,
        totalCost: this.totalCost,
        usage,
        duration,
        isError,
        outputTokens: this.outputTokens,
        contextUsedPercent: this.contextUsedPercent,
      });

      // Check if the branch changed during this turn
      this._checkBranchChange();
    });

    d.on('permission', (data) => {
      const { requestId, toolName, toolInput } = data;

      // Some drivers can't switch approval policy mid-thread. Enforce
      // auto-approve at the session layer to keep behavior consistent.
      if (this.autoApprove) {
        this.driver.respondPermission(
          requestId,
          'allow',
          toolInput || {},
        );
        this._setStatus('running');
        return;
      }

      this.pendingPermissions.set(requestId, {
        requestId,
        toolName,
        toolInput: toolInput || {},
        timestamp: Date.now(),
      });

      this._setStatus('awaiting_permission');
      this._broadcast('permissionRequest', {
        agentId: this.id,
        requestId,
        toolName,
        toolInput: toolInput || {},
      });
    });

    d.on('toolProgress', (data) => {
      this._broadcast('toolProgress', {
        agentId: this.id,
        toolName: data.toolName || null,
        elapsed: data.elapsed || 0,
      });
    });

    d.on('toolResults', (data) => {
      // Merge tool_result blocks into the preceding assistant message
      const content = data.content;
      if (!Array.isArray(content)) return;

      const merged = [];
      const lastAssistant = [...this.messageHistory].reverse().find(m => m.type === 'assistant');
      if (lastAssistant && Array.isArray(lastAssistant.content)) {
        for (const b of content) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            let resultText = '';
            if (typeof b.content === 'string') {
              resultText = b.content;
            } else if (Array.isArray(b.content)) {
              resultText = b.content
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text)
                .join('\n');
            }
            const block = { type: 'tool_result', toolUseId: b.tool_use_id, content: resultText };
            lastAssistant.content.push(block);
            merged.push(block);
          }
        }
      }

      // Broadcast so the mobile app knows these tools completed and can
      // update its UI (e.g. remove "running" spinners on tool_use blocks).
      if (merged.length > 0) {
        this._broadcast('toolResults', { agentId: this.id, results: merged });
      }
    });

    d.on('status', (data) => {
      this._setStatus(data.status);
    });

    d.on('error', (data) => {
      console.error(`[Agent ${this.id.slice(0, 8)}] Driver error:`, data.message);
      this._setStatus('error');
    });

    d.on('exit', (data) => {
      console.log(`[Agent ${this.id.slice(0, 8)}] Driver exited: code=${data.code} signal=${data.signal}`);
      this._setStatus('exited');
    });
  }

  /**
   * Populate from a transcript read from CLI session storage.
   */
  loadTranscript(transcript) {
    if (transcript.model) this.model = transcript.model;
    if (transcript.lastOutput) this.lastOutput = transcript.lastOutput;
    if (transcript.messages?.length > 0) {
      this.messageHistory = transcript.messages;
    }
    this._initialized = true;
  }

  setOnBroadcast(fn) {
    this._onBroadcast = fn;
  }

  _broadcast(type, data = {}) {
    if (this._onBroadcast) {
      this._onBroadcast(this.id, type, data);
    }
  }

  _setStatus(status) {
    if (status === 'connected' && this._initialized) {
      status = 'idle';
    }
    this.status = status;
    this._broadcast('agentUpdated', { agentId: this.id, status });
  }

  _checkBranchChange() {
    if (!this.cwd) return;
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.cwd, encoding: 'utf-8', timeout: 3000,
      }).trim();
      if (branch && branch !== this.gitBranch) {
        this.gitBranch = branch;
        this._broadcast('agentUpdated', {
          agentId: this.id,
          gitBranch: this.gitBranch,
        });
        console.log(`[Agent ${this.id.slice(0, 8)}] Branch changed to: ${branch}`);
      }
    } catch { /* git not available or not a repo */ }
  }

  _updateLastOutput(text) {
    this.lastOutput += text;
    if (this.lastOutput.length > MAX_LAST_OUTPUT) {
      this.lastOutput = this.lastOutput.slice(-MAX_LAST_OUTPUT);
    }
  }

  _trimHistory() {
    if (this.messageHistory.length > MAX_HISTORY) {
      this.messageHistory = this.messageHistory.slice(-MAX_HISTORY);
    }
  }

  // --- Public API (transport-agnostic) ---

  /**
   * Start the agent process. Delegates to driver.start().
   */
  spawn(serverPort, resumeSessionId = null, cwd = null) {
    // Set cwd/projectName early so the initial snapshot includes them
    if (cwd) {
      this.cwd = cwd;
      this.projectName = basename(cwd);
      try {
        this.gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd, encoding: 'utf-8', timeout: 3000,
        }).trim();
      } catch { /* not a git repo or git not available */ }
    }

    this.driver.start(this.id, {
      serverPort,
      resumeSessionId,
      cwd,
      model: this.model,
    });
  }

  /**
   * Send a user prompt. Delegates to driver.sendPrompt().
   */
  sendPrompt(text) {
    this._checkBranchChange();

    if (!this.sessionName) {
      this.sessionName = text.slice(0, 60) + (text.length > 60 ? '...' : '');
      this._broadcast('agentUpdated', { agentId: this.id, sessionName: this.sessionName });
    }

    this.messageHistory.push({
      id: nextHistoryId('user'),
      type: 'user',
      content: text,
      timestamp: Date.now(),
    });
    this._trimHistory();
    this._setStatus('running');

    this.driver.sendPrompt(text, this.sessionId);
  }

  /**
   * Respond to a permission request. Delegates to driver.respondPermission().
   */
  respondToPermission(requestId, behavior, updatedInput) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      console.log(`[Agent ${this.id.slice(0, 8)}] No pending permission: ${requestId}`);
      return false;
    }

    this.pendingPermissions.delete(requestId);

    this.driver.respondPermission(
      requestId,
      behavior,
      updatedInput || pending.toolInput || {},
    );

    if (this.pendingPermissions.size === 0) {
      this._setStatus('running');
    }

    return true;
  }

  /**
   * Interrupt the current turn, if any.
   * Returns true if an interrupt was requested.
   */
  async interrupt() {
    if (!['running', 'awaiting_permission'].includes(this.status)) {
      return false;
    }

    try {
      await this.driver.interrupt();
      this._currentStreamContent = '';
      this.pendingPermissions.clear();
      this._setStatus('idle');
      return true;
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`[Agent ${this.id.slice(0, 8)}] Interrupt failed: ${message}`);
      this._setStatus('error');
      return false;
    }
  }

  /**
   * Change the agent's permission mode. Delegates to driver.setPermissionMode().
   */
  setPermissionMode(mode) {
    this.driver.setPermissionMode(mode);
  }

  /**
   * Called by the bridge when a CLI WebSocket connects back.
   * Only relevant for drivers that use websocket-server transport (Claude).
   */
  attachCliSocket(ws) {
    if (typeof this.driver.attachSocket === 'function') {
      this.driver.attachSocket(ws);
    } else {
      console.log(`[Agent ${this.id.slice(0, 8)}] Driver ${this.type} does not support attachSocket`);
      ws.close(4005, 'Agent type does not accept CLI connections');
    }
  }

  getSnapshot() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      sessionId: this.sessionId,
      sessionName: this.sessionName || 'New Agent',
      model: this.model,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      projectName: this.projectName,
      totalCost: this.totalCost,
      contextUsedPercent: this.contextUsedPercent,
      outputTokens: this.outputTokens,
      lastOutput: this.lastOutput,
      pendingPermissions: Array.from(this.pendingPermissions.values()),
      createdAt: this.createdAt,
      autoApprove: this.autoApprove,
    };
  }

  getHistory() {
    return {
      messages: this.messageHistory,
      pendingPermissions: Array.from(this.pendingPermissions.values()),
    };
  }

  destroy() {
    console.log(`[Agent ${this.id.slice(0, 8)}] Destroying`);
    this.driver.stop();
    this.status = 'exited';
    this.pendingPermissions.clear();
  }
}
