// OpenCodeDriver — transport adapter for OpenCode via `opencode acp`.
//
// Spawns `opencode acp` as a child process and communicates via
// stdin/stdout using JSON-RPC 2.0 (nd-JSON — one JSON object per line).
// This is the Agent Client Protocol (ACP), a standardized protocol for
// communication between code editors/clients and AI coding agents.
//
// Protocol lifecycle:
//   1. Spawn `opencode acp` → stdin/stdout nd-JSON
//   2. Send `initialize` request → capabilities negotiation
//   3. Send `session/new` or `session/load` → get sessionId
//   4. Send `session/prompt` with user input → streaming begins
//   5. Agent streams `session/update` notifications (text, tool calls, etc.)
//   6. Agent may send `session/request_permission` (reverse RPC)
//   7. `session/prompt` returns with stopReason when turn completes
//
// ACP streaming notifications (via session/update):
//   - agent_message_chunk — token-by-token streaming
//   - agent_thought_chunk — reasoning/thinking
//   - tool_call — tool invocation start
//   - tool_call_update — tool status/result updates
//   - plan — execution plan updates

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { BaseDriver } from './BaseDriver.js';

function findOpenCode() {
  const paths = [
    process.env.OPENCODE_PATH,
    `${process.env.HOME}/.local/bin/opencode`,
    '/usr/local/bin/opencode',
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return 'opencode';
}

const OPENCODE_PATH = findOpenCode();

export class OpenCodeDriver extends BaseDriver {
  constructor() {
    super('OpenCode', 'stdio-jsonrpc');
    this._process = null;
    this._agentId = null;
    this._sessionId = null;
    this._cwd = null;
    this._rpcId = 0;
    this._pendingRpc = new Map(); // id -> { resolve, reject, timer }
    this._buffer = '';            // incomplete line buffer for stdout
    this._initialized = false;
    this._currentStreamContent = '';
    this._autoApprovePermissions = false;

    // Track pending permission requests keyed by our UI requestId.
    // entry: { rpcRequestId: string|number }
    this._approvalRequests = new Map();
  }

  async start(agentId, opts = {}) {
    const { cwd = null, resumeSessionId = null, model = null } = opts;
    this._agentId = agentId;
    this._cwd = cwd;

    // Detect git info
    let gitBranch = null;
    if (cwd) {
      try {
        gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd, encoding: 'utf-8', timeout: 3000,
        }).trim();
      } catch { /* not a git repo */ }
    }

    console.log(`[OpenCode ${agentId.slice(0, 8)}] Spawning: ${OPENCODE_PATH} acp (stdio nd-JSON)`);

    this._process = spawn(OPENCODE_PATH, ['acp'], {
      cwd: cwd || process.env.HOME,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse nd-JSON from stdout
    this._process.stdout.on('data', (data) => {
      this._buffer += data.toString();
      const lines = this._buffer.split('\n');
      // Keep the last incomplete line in the buffer
      this._buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this._handleMessage(JSON.parse(trimmed));
        } catch {
          console.log(`[OpenCode ${agentId.slice(0, 8)}] Non-JSON stdout: ${trimmed.slice(0, 100)}`);
        }
      }
    });

    this._process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[OpenCode ${agentId.slice(0, 8)}] stderr: ${text.slice(0, 200)}`);
    });

    this._process.on('exit', (code, signal) => {
      console.log(`[OpenCode ${agentId.slice(0, 8)}] Exited: code=${code} signal=${signal}`);
      this._ready = false;
      this._rejectAllPending('Process exited');
      this.emit('exit', { code, signal });
    });

    this._process.on('error', (err) => {
      console.error(`[OpenCode ${agentId.slice(0, 8)}] Process error:`, err.message);
      this._ready = false;
      this.emit('error', { message: err.message });
    });

    // Start the ACP initialization handshake
    await this._initialize(cwd, gitBranch, resumeSessionId);
  }

  async _initialize(cwd, gitBranch, resumeSessionId) {
    try {
      // Step 1: Send initialize request with capabilities
      const initResult = await this._rpcRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true },
          terminal: true,
        },
        clientInfo: {
          name: 'mobile-agent',
          version: '1.0.0',
        },
      });
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Initialized:`, JSON.stringify(initResult).slice(0, 200));

      // Step 2: Create or resume a session
      let sessionResult;
      if (resumeSessionId) {
        try {
          sessionResult = await this._rpcRequest('session/load', {
            sessionId: resumeSessionId,
          });
        } catch (err) {
          console.warn(`[OpenCode ${this._agentId?.slice(0, 8)}] session/load failed, creating new: ${err.message}`);
          sessionResult = await this._rpcRequest('session/new', {
            cwd: cwd || process.env.HOME,
          });
        }
      } else {
        sessionResult = await this._rpcRequest('session/new', {
          cwd: cwd || process.env.HOME,
        });
      }

      this._sessionId = sessionResult?.sessionId || sessionResult?.id || null;
      this._ready = true;

      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Session started: ${this._sessionId?.slice(0, 8)}...`);

      this.emit('init', {
        sessionId: this._sessionId,
        model: initResult?.agentInfo?.name || null,
        tools: [],
        cwd,
        projectName: cwd ? basename(cwd) : null,
        gitBranch,
      });
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] Initialization failed:`, err.message);
      this.emit('error', { message: `Initialization failed: ${err.message}` });
      this.emit('status', { status: 'error' });
    }
  }

  _handleMessage(msg) {
    const isServerRequest =
      msg?.id != null &&
      typeof msg?.method === 'string' &&
      msg?.result == null &&
      msg?.error == null;

    // JSON-RPC responses (have an `id` field matching our request)
    if (!isServerRequest && msg.id != null && this._pendingRpc.has(msg.id)) {
      const pending = this._pendingRpc.get(msg.id);
      this._pendingRpc.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notifications and server requests
    const method = msg.method;
    if (!method) return;

    const params = msg.params || {};

    switch (method) {
      case 'session/update': {
        this._handleSessionUpdate(params);
        break;
      }

      case 'session/request_permission': {
        this._handlePermissionRequest(msg, params);
        break;
      }

      case 'fs/read_text_file': {
        this._handleFsReadTextFile(msg, params);
        break;
      }

      case 'fs/write_text_file': {
        this._handleFsWriteTextFile(msg, params);
        break;
      }

      case 'terminal/create':
      case 'terminal/output':
      case 'terminal/wait_for_exit':
      case 'terminal/kill':
      case 'terminal/release': {
        // Terminal operations — respond with unsupported for now.
        // The agent handles tool execution internally in ACP mode.
        if (isServerRequest) {
          this._rpcRespond(msg.id, {
            error: 'Terminal operations not supported by this client.',
          });
        }
        break;
      }

      case 'error': {
        const err = params.error || params.message || params;
        const message = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
        this.emit('error', { message });
        break;
      }

      default: {
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Notification: ${method}`);
      }
    }
  }

  _handleSessionUpdate(params) {
    const update = params.update || params;
    const type = update?.type || params?.type;

    switch (type) {
      case 'agent_message_chunk': {
        const blocks = update.content || update.blocks || [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            this._currentStreamContent += block.text;
            this.emit('stream', { text: block.text });
          }
        }
        // If content is a string directly
        if (typeof update.content === 'string' && update.content) {
          this._currentStreamContent += update.content;
          this.emit('stream', { text: update.content });
        }
        break;
      }

      case 'agent_thought_chunk': {
        const text = typeof update.content === 'string'
          ? update.content
          : (update.content?.[0]?.text || update.text || '');
        if (text) {
          this.emit('message', {
            content: [{ type: 'thinking', text }],
          });
        }
        break;
      }

      case 'tool_call': {
        const toolCallId = update.toolCallId || update.id || uuidv4();
        const title = update.title || update.name || 'unknown';
        const status = update.status || 'pending';

        if (status === 'pending' || status === 'in_progress') {
          this.emit('message', {
            content: [{
              type: 'tool_use',
              id: toolCallId,
              name: title,
              input: update.input || {},
            }],
          });
          this.emit('status', { status: 'running' });
        }
        break;
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId || update.id || uuidv4();
        const status = update.status;

        if (status === 'completed') {
          const resultContent = this._extractToolResultContent(update);
          this.emit('message', {
            content: [{
              type: 'tool_result',
              toolUseId: toolCallId,
              content: resultContent,
            }],
          });
        } else if (status === 'failed') {
          const errorMsg = update.error || update.message || 'Tool call failed';
          this.emit('message', {
            content: [{
              type: 'tool_result',
              toolUseId: toolCallId,
              content: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg),
            }],
          });
        }
        break;
      }

      case 'user_message_chunk': {
        // User message echo — ignore (we already track user messages at session level)
        break;
      }

      case 'plan': {
        // Agent plan — could show in UI, log for now
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Plan update`);
        break;
      }

      case 'available_commands_update': {
        // Slash commands available — log for now
        break;
      }

      case 'current_mode_update': {
        // Agent mode changed
        break;
      }

      case 'config_option_update': {
        // Config changed
        break;
      }

      default: {
        if (type) {
          console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Session update: ${type}`);
        }
      }
    }
  }

  _handlePermissionRequest(msg, params) {
    const requestId = uuidv4();
    const rpcRequestId = msg.id;
    const options = params.options || [];

    // Extract tool info from the permission request
    const toolName = params.title || params.toolName || 'unknown';
    const toolInput = params.input || params.description || {};

    this._approvalRequests.set(requestId, { rpcRequestId });

    // Auto-approve if bypass mode is on
    if (this._autoApprovePermissions) {
      const allowOption = options.find(o => o.kind === 'allow_once') || options[0];
      if (allowOption && rpcRequestId != null) {
        this._rpcRespond(rpcRequestId, { optionId: allowOption.optionId });
      }
      this._approvalRequests.delete(requestId);
      this.emit('status', { status: 'running' });
      return;
    }

    this.emit('permission', {
      requestId,
      toolName,
      toolInput: typeof toolInput === 'string' ? { description: toolInput } : toolInput,
    });
    this.emit('status', { status: 'awaiting_permission' });
  }

  _handleFsReadTextFile(msg, params) {
    if (msg.id == null) return;

    const filePath = params.path || params.filePath;
    if (!filePath) {
      this._rpcRespond(msg.id, { error: 'No file path provided' });
      return;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      this._rpcRespond(msg.id, { content });
    } catch (err) {
      this._rpcRespond(msg.id, { error: err.message });
    }
  }

  _handleFsWriteTextFile(msg, params) {
    if (msg.id == null) return;

    // For safety, we don't write files from the driver.
    // The agent should handle file writes internally.
    this._rpcRespond(msg.id, {
      error: 'File write operations not supported by this client.',
    });
  }

  _extractToolResultContent(update) {
    const content = update.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n') || 'Completed';
    }
    if (content && typeof content === 'object' && content.text) {
      return content.text;
    }
    return update.result || update.output || 'Completed';
  }

  async sendPrompt(text, sessionId) {
    if (!this._ready || !this._sessionId) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Not ready, cannot send prompt`);
      this.emit('error', { message: 'OpenCode not ready' });
      return;
    }

    this.emit('status', { status: 'running' });
    this._currentStreamContent = '';

    try {
      const result = await this._rpcRequest('session/prompt', {
        sessionId: this._sessionId,
        prompt: [{ type: 'text', text }],
      });

      // Prompt returned — turn is complete
      const stopReason = result?.stopReason || 'end_turn';
      const isError = stopReason === 'refusal';

      // Emit any accumulated stream content as a final message
      if (this._currentStreamContent) {
        this.emit('message', {
          content: [{ type: 'text', text: this._currentStreamContent }],
        });
        this._currentStreamContent = '';
      }

      this.emit('result', {
        cost: 0, // ACP doesn't report cost
        totalCost: 0,
        usage: {},
        duration: 0,
        isError,
        sessionId: this._sessionId,
      });
      this.emit('status', { status: 'idle' });
      this._checkBranchChange();
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] session/prompt failed:`, err.message);

      // Emit any accumulated content before the error
      if (this._currentStreamContent) {
        this.emit('message', {
          content: [{ type: 'text', text: this._currentStreamContent }],
        });
        this._currentStreamContent = '';
      }

      this.emit('error', { message: err.message });
      this.emit('result', {
        cost: 0,
        totalCost: 0,
        usage: {},
        duration: 0,
        isError: true,
        sessionId: this._sessionId,
      });
      this.emit('status', { status: 'idle' });
    }
  }

  async respondPermission(requestId, behavior, updatedInput) {
    const pending = this._approvalRequests.get(requestId);
    if (!pending) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] No approval found for requestId: ${requestId}`);
      return;
    }
    this._approvalRequests.delete(requestId);

    const optionId = behavior === 'allow' ? 'allow-once' : 'reject-once';

    if (pending.rpcRequestId != null) {
      this._rpcRespond(pending.rpcRequestId, { optionId });
    } else {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Missing rpcRequestId for permission: ${requestId}`);
    }

    if (this._approvalRequests.size === 0) {
      this.emit('status', { status: 'running' });
    }
  }

  async interrupt() {
    if (!this._sessionId) return;

    try {
      await this._rpcRequest('session/cancel', {
        sessionId: this._sessionId,
      });
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] Cancel failed:`, err.message);
    }
  }

  async setPermissionMode(mode) {
    if (mode === 'bypassPermissions') {
      this._autoApprovePermissions = true;
    } else {
      this._autoApprovePermissions = false;
    }
    console.log(
      `[OpenCode ${this._agentId?.slice(0, 8)}] Permission mode -> ${mode} (autoApprove=${this._autoApprovePermissions})`,
    );
  }

  async stop() {
    this._ready = false;
    this._rejectAllPending('Driver stopped');

    if (this._process) {
      try { this._process.kill('SIGTERM'); } catch {}
      const proc = this._process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
      this._process = null;
    }

    this._sessionId = null;
    this._approvalRequests.clear();
  }

  // --- JSON-RPC helpers (same pattern as CodexDriver) ---

  _rpcRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._rpcId;

      const timer = setTimeout(() => {
        if (this._pendingRpc.has(id)) {
          this._pendingRpc.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);

      this._pendingRpc.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
      this._write(msg);
    });
  }

  _rpcNotify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this._write(msg);
  }

  _rpcRespond(id, result = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    this._write(msg);
  }

  _write(data) {
    if (!this._process?.stdin?.writable) return;
    this._process.stdin.write(data + '\n');
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this._pendingRpc) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingRpc.clear();
  }

  _checkBranchChange() {
    if (!this._cwd) return;
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this._cwd, encoding: 'utf-8', timeout: 3000,
      }).trim();
      if (branch) {
        this.emit('init', { gitBranch: branch });
      }
    } catch { /* git not available */ }
  }
}
