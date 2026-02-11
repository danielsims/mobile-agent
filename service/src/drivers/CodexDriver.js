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
import { basename } from 'node:path';
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
    this._approvalPolicy = 'on-request'; // 'untrusted' | 'on-request' | 'on-failure' | 'never'
    this._currentStreamContent = '';

    // Map codex item IDs to our permission request IDs
    this._approvalRequests = new Map(); // itemId -> requestId
  }

  async start(agentId, opts = {}) {
    const { cwd = null, resumeSessionId = null, model = null } = opts;
    this._agentId = agentId;
    this._cwd = cwd;
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
        threadResult = await this._rpcRequest('thread/resume', {
          threadId: resumeSessionId,
        });
      } else {
        const baseParams = {
          cwd: cwd || process.env.HOME,
          approvalPolicy: this._approvalPolicy,
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
    // JSON-RPC responses (have an `id` field matching our request)
    if (msg.id != null && this._pendingRpc.has(msg.id)) {
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
        const itemId = params.itemId || params.item?.id;
        this._approvalRequests.set(itemId, requestId);

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
        const itemId = params.itemId || params.item?.id;
        this._approvalRequests.set(itemId, requestId);

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
        const text = item.text || item.content || '';
        if (text) {
          this.emit('message', {
            content: [{ type: 'thinking', text }],
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
      });
    } catch (err) {
      console.error(`[Codex ${this._agentId?.slice(0, 8)}] turn/start failed:`, err.message);
      this.emit('error', { message: err.message });
      this.emit('status', { status: 'idle' });
    }
  }

  async respondPermission(requestId, behavior, updatedInput) {
    // Find the itemId for this requestId
    let targetItemId = null;
    for (const [itemId, rId] of this._approvalRequests) {
      if (rId === requestId) {
        targetItemId = itemId;
        this._approvalRequests.delete(itemId);
        break;
      }
    }

    if (!targetItemId) {
      console.log(`[Codex ${this._agentId?.slice(0, 8)}] No approval found for requestId: ${requestId}`);
      return;
    }

    const decision = behavior === 'allow' ? 'accept' : 'decline';

    // Codex uses JSON-RPC request/response for approvals:
    // The server sent us a request, we respond with { id, result: { decision } }
    // But since we receive it as a notification, we send back via a separate method
    try {
      await this._rpcRequest('item/approve', {
        itemId: targetItemId,
        decision,
      });
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
    // Map our generic modes to Codex approval policies
    const policyMap = {
      'bypassPermissions': 'never',  // never ask for approval
      'default': 'on-request',       // ask for approval on each action
    };
    this._approvalPolicy = policyMap[mode] || mode;
    console.log(`[Codex ${this._agentId?.slice(0, 8)}] Approval policy -> ${this._approvalPolicy}`);
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
