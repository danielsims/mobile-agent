// CodexDriver — transport adapter for OpenAI Codex via `codex app-server`.
//
// Spawns `codex app-server` as a child process and communicates via
// stdin/stdout using JSON-RPC 2.0 lite (JSONL — one JSON object per line).
//
// Protocol lifecycle:
//   1. Spawn `codex app-server` → stdin/stdout JSONL
//   2. Send `initialize` request → receive response with capabilities
//   3. Send `initialized` notification
//   4. Send `thread/start` → receive thread ID
//   5. Send `turn/start` with user input → streaming begins
//
// Streaming notifications from codex:
//   - turn/started, turn/completed, turn/failed
//   - item/started, item/completed
//   - item/agentMessage/delta — token-by-token streaming
//   - item/commandExecution/outputDelta — command output
//   - item/commandExecution/requestApproval — permission request
//   - item/fileChange/requestApproval — file change approval
//   - turn/diff/updated — file diffs
//   - turn/plan/updated — agent plan

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { BaseDriver } from './BaseDriver.js';

function findCodex() {
  const paths = [
    process.env.CODEX_PATH,
    `${process.env.HOME}/.local/bin/codex`,
    '/usr/local/bin/codex',
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return 'codex';
}

const CODEX_PATH = findCodex();

export class CodexDriver extends BaseDriver {
  constructor() {
    super('Codex', 'stdio-jsonrpc');
    this._process = null;
    this._agentId = null;
    this._threadId = null;
    this._turnId = null;
    this._cwd = null;
    this._rpcId = 0;
    this._pendingRpc = new Map(); // id -> { resolve, reject }
    this._buffer = '';            // incomplete line buffer for stdout
    this._initialized = false;
    this._model = process.env.CODEX_MODEL?.trim() || null;
    this._approvalPolicy = 'untrusted'; // 'untrusted' | 'on-request' | 'on-failure' | 'never'
    this._sandboxMode = 'read-only'; // 'read-only' | 'workspace-write' | 'danger-full-access'
    this._workspaceWritableRoots = [];
    this._currentStreamContent = '';
    this._activeToolUseIds = new Set();  // tool items currently in progress (web search, etc.)
    this._lastReasoningText = '';
    this._lastReasoningAt = 0;

    // Track pending approval requests keyed by our UI requestId.
    // entry: { rpcRequestId?: string|number, itemId?: string }
    this._approvalRequests = new Map();
  }

  async start(agentId, opts = {}) {
    const { cwd = null, resumeSessionId = null, model = null } = opts;
    this._agentId = agentId;
    this._cwd = cwd;
    this._workspaceWritableRoots = this._detectWorkspaceWritableRoots(cwd);
    if (typeof model === 'string' && model.trim()) {
      this._model = model.trim();
    }

    // Detect git info
    let gitBranch = null;
    if (cwd) {
      try {
        gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd, encoding: 'utf-8', timeout: 3000,
        }).trim();
      } catch { /* not a git repo */ }
    }

    console.log(`[Codex ${agentId.slice(0, 8)}] Spawning: ${CODEX_PATH} app-server (stdio JSONL)`);

    this._process = spawn(CODEX_PATH, ['app-server'], {
      cwd: cwd || process.env.HOME,
      env: {
        ...process.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse JSONL from stdout
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
          console.log(`[Codex ${agentId.slice(0, 8)}] Non-JSON stdout: ${trimmed.slice(0, 100)}`);
        }
      }
    });

    this._process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Codex ${agentId.slice(0, 8)}] stderr: ${text.slice(0, 200)}`);
    });

    this._process.on('exit', (code, signal) => {
      console.log(`[Codex ${agentId.slice(0, 8)}] Exited: code=${code} signal=${signal}`);
      this._ready = false;
      this._rejectAllPending('Process exited');
      this.emit('exit', { code, signal });
    });

    this._process.on('error', (err) => {
      console.error(`[Codex ${agentId.slice(0, 8)}] Process error:`, err.message);
      this._ready = false;
      this.emit('error', { message: err.message });
    });

    // Start the JSON-RPC initialization handshake
    await this._initialize(cwd, gitBranch, resumeSessionId);
  }

  async _initialize(cwd, gitBranch, resumeSessionId) {
    try {
      // Step 1: Send initialize request
      const initResult = await this._rpcRequest('initialize', {
        clientInfo: {
          name: 'mobile-agent',
          version: '1.0.0',
        },
      });
      console.log(`[Codex ${this._agentId?.slice(0, 8)}] Initialized:`, JSON.stringify(initResult).slice(0, 200));

      // Step 2: Send initialized notification (no response expected)
      this._rpcNotify('initialized', {});

      // Step 3: Start or resume a thread
      let threadResult;
      if (resumeSessionId) {
        try {
          threadResult = await this._rpcRequest('thread/resume', {
            threadId: resumeSessionId,
            approvalPolicy: this._approvalPolicy,
            sandbox: this._sandboxMode,
          });
        } catch (err) {
          const msg = String(err?.message || err || '');
          if (!/approvalPolicy|sandbox/i.test(msg)) throw err;
          // Compatibility fallback for older app-server variants.
          threadResult = await this._rpcRequest('thread/resume', {
            threadId: resumeSessionId,
          });
        }
      } else {
        const baseParams = {
          cwd: cwd || process.env.HOME,
          approvalPolicy: this._approvalPolicy,
          sandbox: this._sandboxMode,
        };
        if (this._model) baseParams.model = this._model;

        try {
          threadResult = await this._rpcRequest('thread/start', baseParams);
        } catch (err) {
          const msg = String(err?.message || err || '');
          const canRetryWithoutModel =
            Boolean(baseParams.model) &&
            /model.+not supported|not supported.+model|unsupported.+model/i.test(msg);

          if (!canRetryWithoutModel) throw err;

          // Some account tiers don't support certain model IDs. Fall back to
          // Codex's own default model selection when this happens.
          console.warn(`[Codex ${this._agentId?.slice(0, 8)}] Model "${baseParams.model}" unsupported; retrying thread/start without explicit model`);
          this._model = null;
          threadResult = await this._rpcRequest('thread/start', {
            cwd: cwd || process.env.HOME,
            approvalPolicy: this._approvalPolicy,
            sandbox: this._sandboxMode,
          });
        }
      }

      this._threadId = threadResult?.thread?.id || threadResult?.threadId || null;
      const resolvedModel = threadResult?.thread?.model || threadResult?.model || null;
      if (resolvedModel) this._model = resolvedModel;
      this._ready = true;

      console.log(`[Codex ${this._agentId?.slice(0, 8)}] Thread started: ${this._threadId?.slice(0, 8)}...`);

      this.emit('init', {
        sessionId: this._threadId,
        model: this._model,
        tools: [], // Codex doesn't enumerate tools upfront
        cwd,
        projectName: cwd ? basename(cwd) : null,
        gitBranch,
      });
    } catch (err) {
      console.error(`[Codex ${this._agentId?.slice(0, 8)}] Initialization failed:`, err.message);
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

    // JSON-RPC notifications (have `method` but no `id`)
    const method = msg.method;
    if (!method) return;

    const params = msg.params || {};

    switch (method) {
      case 'turn/started': {
        this._turnId = params.turnId || params.turn?.id || null;
        this._currentStreamContent = '';
        this.emit('status', { status: 'running' });
        break;
      }

      case 'turn/completed': {
        const turn = params.turn || params;
        const status = turn.status || 'completed';
        const usage = turn.usage || params.usage || {};

        this.emit('result', {
          cost: 0, // Codex doesn't report cost per-turn via app-server
          totalCost: 0,
          usage: {
            input_tokens: usage.input_tokens || usage.inputTokens || 0,
            output_tokens: usage.output_tokens || usage.outputTokens || 0,
          },
          duration: 0,
          isError: status === 'failed',
          sessionId: this._threadId,
        });
        this.emit('status', { status: 'idle' });
        this._currentStreamContent = '';
        this._checkBranchChange();
        if (status === 'failed') {
          const err = turn.error || params.error || 'Turn failed';
          this.emit('error', { message: typeof err === 'string' ? err : JSON.stringify(err) });
        }
        break;
      }

      case 'turn/failed': {
        const error = params.error || params.message || 'Turn failed';
        this.emit('result', {
          cost: 0,
          totalCost: 0,
          usage: {},
          duration: 0,
          isError: true,
          sessionId: this._threadId,
        });
        this.emit('error', { message: typeof error === 'string' ? error : JSON.stringify(error) });
        this.emit('status', { status: 'idle' });
        break;
      }

      case 'item/started': {
        const item = params.item || params;
        console.log(`[Codex ${this._agentId?.slice(0, 8)}] Item started: ${item.type} (${item.id})`);
        this._handleItemStarted(item);
        break;
      }

      case 'item/completed': {
        const item = params.item || params;
        this._handleItemCompleted(item);
        break;
      }

      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string'
          ? params.delta
          : (params.delta?.text || params.text || '');
        if (delta) {
          this._currentStreamContent += delta;
          this.emit('stream', { text: delta });
        }
        break;
      }

      case 'item/commandExecution/outputDelta': {
        const output = typeof params.output === 'string'
          ? params.output
          : (params.output?.text || params.delta || '');
        if (output) {
          this.emit('toolProgress', {
            toolName: 'command_execution',
            elapsed: 0,
            output,
          });
        }
        break;
      }

      case 'item/commandExecution/requestApproval': {
        const requestId = uuidv4();
        const itemId = params.itemId || params.item?.id || params.id || null;
        this._approvalRequests.set(requestId, {
          rpcRequestId: isServerRequest ? msg.id : null,
          itemId,
        });

        this.emit('permission', {
          requestId,
          toolName: 'command_execution',
          toolInput: {
            command: params.parsedCmd?.cmd || params.command || '',
            args: params.parsedCmd?.args || [],
            reason: params.reason || '',
          },
        });
        this.emit('status', { status: 'awaiting_permission' });
        break;
      }

      case 'item/fileChange/requestApproval': {
        const requestId = uuidv4();
        const itemId = params.itemId || params.item?.id || params.id || null;
        this._approvalRequests.set(requestId, {
          rpcRequestId: isServerRequest ? msg.id : null,
          itemId,
        });

        this.emit('permission', {
          requestId,
          toolName: 'file_change',
          toolInput: {
            file: params.filePath || params.file || '',
            reason: params.reason || '',
          },
        });
        this.emit('status', { status: 'awaiting_permission' });
        break;
      }

      case 'turn/diff/updated': {
        // File diff update — could emit as toolProgress for visibility
        break;
      }

      case 'turn/plan/updated': {
        // Agent plan — could show in UI
        break;
      }

      case 'codex/event/agent_reasoning': {
        const text = params.msg?.text || params.text || '';
        this._emitReasoningMessage(text);
        break;
      }

      case 'item/tool/call': {
        // Dynamic tool calls are not implemented by mobile-agent yet.
        // Respond explicitly so the turn does not stall waiting on output.
        if (isServerRequest) {
          this._rpcRespond(msg.id, {
            success: false,
            contentItems: [{
              type: 'inputText',
              text: 'Dynamic tool calls are not supported by this client.',
            }],
          });
        }
        break;
      }

      case 'item/tool/requestUserInput': {
        // Experimental request-user-input flow is not wired in mobile UI yet.
        // Reply with an empty answer map so the server can continue gracefully.
        if (isServerRequest) {
          this._rpcRespond(msg.id, { answers: {} });
        }
        break;
      }

      case 'error':
      case 'codex/event/error': {
        const err = params.error || params.event?.error || params.message || params;
        const message = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
        this.emit('error', { message });
        break;
      }

      default: {
        console.log(`[Codex ${this._agentId?.slice(0, 8)}] Notification: ${method}`);
      }
    }
  }

  _handleItemCompleted(item) {
    if (!item) return;

    switch (item.type) {
      case 'agentMessage':
      case 'agent_message': {
        const text = item.text || item.content || this._currentStreamContent || '';
        this._currentStreamContent = '';
        if (text) {
          this.emit('message', {
            content: [{ type: 'text', text }],
          });
        }
        break;
      }

      case 'commandExecution':
      case 'command_execution': {
        const toolId = item.id || uuidv4();
        // Emit as a tool_use + tool_result pair
        this.emit('message', {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'command_execution',
              input: { command: item.command || '' },
            },
            {
              type: 'tool_result',
              toolUseId: toolId,
              content: item.output || item.result || '',
            },
          ],
        });
        break;
      }

      case 'fileChange':
      case 'file_change': {
        const toolId = item.id || uuidv4();
        this.emit('message', {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: 'file_change',
              input: {
                file: item.filePath || item.file || '',
                action: item.action || 'modify',
              },
            },
            {
              type: 'tool_result',
              toolUseId: toolId,
              content: item.diff || `File ${item.action || 'modified'}: ${item.filePath || item.file || ''}`,
            },
          ],
        });
        break;
      }

      case 'reasoning': {
        const text = this._extractReasoningText(item);
        this._emitReasoningMessage(text);
        break;
      }

      case 'webSearch':
      case 'web_search': {
        const toolId = item.id || uuidv4();
        const resultText = this._formatWebSearchResult(item);

        if (this._activeToolUseIds.has(toolId)) {
          this._activeToolUseIds.delete(toolId);
          this.emit('message', {
            content: [{ type: 'tool_result', toolUseId: toolId, content: resultText }],
          });
        } else {
          // Fallback if start event was missed.
          this.emit('message', {
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'web_search',
                input: { query: item.query || item.action?.query || '' },
              },
              {
                type: 'tool_result',
                toolUseId: toolId,
                content: resultText,
              },
            ],
          });
        }
        break;
      }

      default:
        console.log(`[Codex ${this._agentId?.slice(0, 8)}] Item completed: ${item.type}`);
    }
  }

  async sendPrompt(text, sessionId) {
    if (!this._ready || !this._threadId) {
      console.log(`[Codex ${this._agentId?.slice(0, 8)}] Not ready, cannot send prompt`);
      this.emit('error', { message: 'Codex not ready' });
      return;
    }

    this.emit('status', { status: 'running' });

    try {
      await this._rpcRequest('turn/start', {
        threadId: this._threadId,
        input: [{ type: 'text', text }],
        approvalPolicy: this._approvalPolicy,
        sandboxPolicy: this._buildTurnSandboxPolicy(),
      });
    } catch (err) {
      console.error(`[Codex ${this._agentId?.slice(0, 8)}] turn/start failed:`, err.message);
      this.emit('error', { message: err.message });
      this.emit('status', { status: 'idle' });
    }
  }

  async respondPermission(requestId, behavior, updatedInput) {
    const pending = this._approvalRequests.get(requestId);
    if (!pending) {
      console.log(`[Codex ${this._agentId?.slice(0, 8)}] No approval found for requestId: ${requestId}`);
      return;
    }
    this._approvalRequests.delete(requestId);

    const decision = behavior === 'allow' ? 'accept' : 'decline';

    try {
      // Current Codex app-server protocol sends approval prompts as server
      // requests (with msg.id) and expects a JSON-RPC response with the same id.
      if (pending.rpcRequestId != null) {
        this._rpcRespond(pending.rpcRequestId, { decision });
      } else if (pending.itemId) {
        // Legacy fallback for older app-server variants.
        await this._rpcRequest('item/approve', {
          itemId: pending.itemId,
          decision,
        });
      } else {
        console.log(`[Codex ${this._agentId?.slice(0, 8)}] Missing approval routing metadata for requestId: ${requestId}`);
      }
    } catch (err) {
      console.error(`[Codex ${this._agentId?.slice(0, 8)}] Approval response failed:`, err.message);
    }

    if (this._approvalRequests.size === 0) {
      this.emit('status', { status: 'running' });
    }
  }

  async interrupt() {
    if (!this._threadId || !this._turnId) return;

    try {
      await this._rpcRequest('turn/interrupt', {
        threadId: this._threadId,
        turnId: this._turnId,
      });
    } catch (err) {
      console.error(`[Codex ${this._agentId?.slice(0, 8)}] Interrupt failed:`, err.message);
    }
  }

  async setPermissionMode(mode) {
    // Map shared app modes (Ask / Auto) to Codex-native policies.
    // Auto uses on-failure, not never, so write failures can still escalate.
    const modeMap = {
      // Auto mode: allow sandboxed writes by default, escalate when needed.
      bypassPermissions: { approvalPolicy: 'on-failure', sandboxMode: 'workspace-write' },
      // Ask mode: force explicit permission path before writes.
      default: { approvalPolicy: 'untrusted', sandboxMode: 'read-only' },
    };
    const mapped = modeMap[mode];
    if (mapped) {
      this._approvalPolicy = mapped.approvalPolicy;
      this._sandboxMode = mapped.sandboxMode;
    } else {
      this._approvalPolicy = mode;
    }
    console.log(
      `[Codex ${this._agentId?.slice(0, 8)}] Policy -> approval=${this._approvalPolicy}, sandbox=${this._sandboxMode}`,
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

    this._threadId = null;
    this._turnId = null;
    this._approvalRequests.clear();
    this._activeToolUseIds.clear();
  }

  // --- JSON-RPC helpers ---

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

  _extractReasoningText(item) {
    if (!item || typeof item !== 'object') return '';
    const parts = [];

    const addText = (value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed) return;
      // Reasoning summaries commonly come wrapped in markdown bold markers.
      const unwrapped = trimmed.replace(/^\*\*(.+)\*\*$/s, '$1').trim();
      if (unwrapped) parts.push(unwrapped);
    };

    addText(item.text);

    if (Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (typeof s === 'string') {
          addText(s);
          continue;
        }
        if (!s || typeof s !== 'object') continue;
        addText(s.text);
        addText(s.summary_text);
      }
    }

    if (Array.isArray(item.summary_text)) {
      for (const s of item.summary_text) addText(s);
    }

    const content = item.content;
    if (typeof content === 'string') {
      addText(content);
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        addText(c.text);
        addText(c.summary_text);
      }
    } else if (content && typeof content === 'object') {
      addText(content.text);
      addText(content.summary_text);
    }

    return parts.join('\n\n').trim();
  }

  _emitReasoningMessage(text) {
    if (typeof text !== 'string') return;
    const normalized = text.trim().replace(/^\*\*(.+)\*\*$/s, '$1').trim();
    if (!normalized) return;

    const now = Date.now();
    if (normalized === this._lastReasoningText && now - this._lastReasoningAt < 2000) {
      return;
    }
    this._lastReasoningText = normalized;
    this._lastReasoningAt = now;

    this.emit('message', {
      content: [{ type: 'thinking', text: normalized }],
    });
  }

  _handleItemStarted(item) {
    if (!item || typeof item !== 'object') return;
    const type = item.type;

    if (type === 'webSearch' || type === 'web_search') {
      const toolId = item.id || uuidv4();
      this._activeToolUseIds.add(toolId);
      this.emit('message', {
        content: [
          {
            type: 'tool_use',
            id: toolId,
            name: 'web_search',
            input: {
              query: item.query || item.action?.query || '',
            },
          },
        ],
      });
    }
  }

  _formatWebSearchResult(item) {
    const action = item?.action || {};
    const query = action.query || item?.query || '';
    const queries = Array.isArray(action.queries) ? action.queries.filter((q) => typeof q === 'string') : [];

    const lines = [];
    if (query) lines.push(`Query: ${query}`);
    if (queries.length > 0) {
      lines.push('Expanded queries:');
      for (const q of queries) lines.push(`- ${q}`);
    }
    if (lines.length === 0) {
      return 'Web search completed.';
    }
    return lines.join('\n');
  }

  _buildTurnSandboxPolicy() {
    switch (this._sandboxMode) {
      case 'danger-full-access':
        return { type: 'dangerFullAccess' };
      case 'read-only':
        return { type: 'readOnly' };
      case 'workspace-write':
      default: {
        const policy = {
          type: 'workspaceWrite',
          networkAccess: false,
        };
        if (this._workspaceWritableRoots.length > 0) {
          policy.writableRoots = this._workspaceWritableRoots;
        }
        return policy;
      }
    }
  }

  _detectWorkspaceWritableRoots(cwd) {
    if (!cwd) return [];

    const roots = new Set();
    const addRoot = (value) => {
      if (typeof value !== 'string' || !value.trim()) return;
      const abs = isAbsolute(value) ? value : resolve(cwd, value);
      roots.add(abs);
    };

    try {
      // In git worktrees, commit/index lock files often live under the
      // common git dir outside cwd. Allowing these roots keeps workspace-write
      // functional without falling back to full disk access.
      const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd,
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      addRoot(gitDir);
    } catch {
      // not a git repo or git unavailable
    }

    try {
      const commonGitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      addRoot(commonGitDir);
    } catch {
      // not a git repo or git unavailable
    }

    return Array.from(roots);
  }
}
