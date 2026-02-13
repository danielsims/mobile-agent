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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { BaseDriver } from './BaseDriver.js';

function findOpenCode() {
  const paths = [
    process.env.OPENCODE_PATH,
    `${process.env.HOME}/.opencode/bin/opencode`,
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
    this._model = null;
    this._rpcId = 0;
    this._pendingRpc = new Map(); // id -> { resolve, reject, timer }
    this._buffer = '';            // incomplete line buffer for stdout
    this._initialized = false;
    this._currentStreamContent = '';
    this._currentThinkingContent = '';
    this._autoApprovePermissions = false;
    this._turnActive = false;
    this._activeToolCalls = new Map(); // toolCallId -> { name, input }

    // Track pending permission requests keyed by our UI requestId.
    // entry: { rpcRequestId: string|number, toolCallId?: string }
    this._approvalRequests = new Map();

    // Question tool handling: ACP delivers question data via tool_call events
    // but session/request_permission NEVER arrives for questions (ACP only
    // subscribes to permission.asked, not question.asked). We emit the
    // permission from tool_call so the UI is interactive, then when the user
    // answers, we kill the process, restart it with session/load, and send
    // the answer as a new user prompt.
    this._emittedQuestionToolCalls = new Set();  // toolCallIds already shown
    this._isRestartingForQuestion = false;       // suppresses error events during restart
    this._suppressReplayEvents = false;          // suppresses session/load history replay

    // Terminal management: terminalId -> { process, output, exitCode, resolved }
    this._terminals = new Map();
    this._nextTerminalId = 1;

    // Capabilities advertised by the agent during initialization
    this._promptCapabilities = {};
  }

  async start(agentId, opts = {}) {
    const { cwd = null, resumeSessionId = null, model = null } = opts;
    this._agentId = agentId;
    this._cwd = cwd;
    if (model) this._model = model;

    // Detect git info
    let gitBranch = null;
    if (cwd) {
      try {
        gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd, encoding: 'utf-8', timeout: 3000,
        }).trim();
      } catch { /* not a git repo */ }
    }

    // Set the model via OPENCODE_CONFIG_CONTENT env var — this takes highest
    // precedence in OpenCode's config chain and is the only reliable way to
    // choose a model when spawning via ACP (session/new has no model param).
    const env = { ...process.env };
    if (model) {
      const configOverride = { model };
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(configOverride);
      console.log(`[OpenCode ${agentId.slice(0, 8)}] Spawning with model override: ${model}`);
    }
    console.log(`[OpenCode ${agentId.slice(0, 8)}] Spawning: ${OPENCODE_PATH} acp (stdio nd-JSON)`);

    this._process = spawn(OPENCODE_PATH, ['acp'], {
      cwd: cwd || process.env.HOME,
      env,
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
          const parsed = JSON.parse(trimmed);
          this._handleMessage(parsed);
        } catch (err) {
          console.log(`[OpenCode ${agentId.slice(0, 8)}] Non-JSON stdout: ${trimmed.slice(0, 200)}`);
          console.log(`[OpenCode ${agentId.slice(0, 8)}] Parse error: ${err.message}`);
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
    await this._initialize(cwd, gitBranch, resumeSessionId, model);
  }

  async _initialize(cwd, gitBranch, resumeSessionId, model) {
    try {
    // Step 1: Send initialize request with capabilities
    const initResult = await this._rpcRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: 'mobile-agent',
        version: '1.0.0',
      },
    });
    console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Initialized:`, JSON.stringify(initResult).slice(0, 200));

    // Extract tools/capabilities from init response
    const agentCapabilities = initResult?.agentCapabilities || {};
    const availableTools = agentCapabilities?.tools || [];
    const sessionCapabilities = agentCapabilities?.sessionCapabilities || {};
    const promptCapabilities = agentCapabilities?.promptCapabilities || {};
    this._promptCapabilities = promptCapabilities;
    console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Prompt capabilities:`, JSON.stringify(promptCapabilities));

      // Step 2: Create or resume a session
      // ACP's session/new does not accept a model parameter — model
      // selection is done via session/set_config_option after creation.
      let sessionResult;
      const sessionParams = {
        cwd: cwd || process.env.HOME,
        mcpServers: [],
      };
      if (resumeSessionId && (agentCapabilities?.loadSession || sessionCapabilities?.loadSession)) {
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] session/load ${resumeSessionId.slice(0, 12)}... (model: ${model || 'auto'})`);
        // Suppress replay events — session/load replays conversation history
        // as notifications, which would duplicate thinking/messages/tools.
        this._suppressReplayEvents = true;
        try {
          sessionResult = await this._rpcRequest('session/load', {
            sessionId: resumeSessionId,
            cwd: sessionParams.cwd,
            mcpServers: sessionParams.mcpServers,
          });
        } catch (err) {
          console.warn(`[OpenCode ${this._agentId?.slice(0, 8)}] session/load failed, creating new: ${err.message}`);
          sessionResult = await this._rpcRequest('session/new', sessionParams);
        } finally {
          this._suppressReplayEvents = false;
          // Discard any thinking/stream content accumulated during replay
          this._currentThinkingContent = '';
          this._currentStreamContent = '';
        }
      } else {
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] session/new (model: ${model || 'auto'})`);
        sessionResult = await this._rpcRequest('session/new', sessionParams);
      }

      this._sessionId = sessionResult?.sessionId || sessionResult?.id || null;
      this._ready = true;

      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] session/new response:`, JSON.stringify(sessionResult).slice(0, 400));

      // Verify the model — it should match what we requested since we set it
      // via OPENCODE_CONFIG_CONTENT at spawn time.
      const currentModelId = sessionResult?.models?.currentModelId;
      let activeModel = currentModelId || null;

      if (model && currentModelId && model !== currentModelId) {
        console.warn(`[OpenCode ${this._agentId?.slice(0, 8)}] Model mismatch: expected=${model}, actual=${currentModelId}`);
        activeModel = currentModelId;
      } else if (model) {
        activeModel = model;
      }

      // Extract modes from session result
      const modes = sessionResult?.modes || {};
      const availableModes = modes?.availableModes || [];
      const currentMode = modes?.currentMode || null;

      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Session started: ${this._sessionId?.slice(0, 8)}...`);
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Available modes: ${JSON.stringify(availableModes).slice(0, 200) || 'none'}, current: ${currentMode}`);

      // Use the active model (after potential switch), falling back to
      // the agent product name only as a last resort.
      const resolvedModel = activeModel
        || model
        || initResult?.agentInfo?.name
        || null;
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Active model: ${resolvedModel}`);

      this.emit('init', {
        sessionId: this._sessionId,
        model: resolvedModel,
        tools: availableTools,
        cwd,
        projectName: cwd ? basename(cwd) : null,
        gitBranch,
        capabilities: agentCapabilities,
        availableModes,
        currentMode,
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
        this._handleTerminalRequest(msg, params, method);
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
    const type = update?.type || update?.sessionUpdate || params?.type || params?.sessionUpdate;

    // During session/load, OpenCode replays the conversation history as
    // notifications. Suppress content events to avoid duplicating thinking,
    // messages, and tool calls that the UI already has.
    if (this._suppressReplayEvents) {
      return;
    }

    console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Session update type: ${type}, content:`, JSON.stringify(update).slice(0, 200));

    switch (type) {
      case 'agent_message_chunk': {
        // Don't flush thinking here — it will be combined with the final
        // text message when sendPrompt completes, reducing message count.
        const content = update.content;

        // Handle different content formats
        if (typeof content === 'string') {
          // Direct string content
          this._currentStreamContent += content;
          this.emit('stream', { text: content });
        } else if (content?.type === 'text' && content?.text) {
          // Single content object with type and text
          this._currentStreamContent += content.text;
          this.emit('stream', { text: content.text });
        } else if (Array.isArray(content)) {
          // Array of content blocks
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              this._currentStreamContent += block.text;
              this.emit('stream', { text: block.text });
            }
          }
        }
        break;
      }

      case 'agent_thought_chunk': {
        let text = '';
        if (typeof update.content === 'string') {
          text = update.content;
        } else if (update.content?.type === 'text' && update.content?.text) {
          // Single content object: { type: 'text', text: '...' }
          text = update.content.text;
        } else if (Array.isArray(update.content)) {
          text = update.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        } else {
          text = update.text || '';
        }
        if (text) {
          // Accumulate thinking chunks — they arrive as many small fragments
          // but should be rendered as a single thinking block (consistent
          // with Claude which delivers thinking as one block).
          this._currentThinkingContent += text;
        }
        break;
      }

      case 'tool_call': {
        const thinkingBlocks = this._flushThinking();
        const toolCallId = this._extractToolCallId(update);
        const toolName = this._extractToolName(update);
        const toolInput = this._extractToolInput(update);
        const status = this._normalizeStatus(update.status || 'pending');

        if (status === 'pending' || status === 'in_progress') {
          this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
          this._maybeEmitQuestionPermission(toolCallId, toolName, toolInput);
          if (this._turnActive || this._approvalRequests.size > 0) {
            this.emit('status', { status: 'running' });
          }
        } else if (status === 'completed' || status === 'failed') {
          this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
          if (status === 'completed') {
            this._emitToolResult(toolCallId, this._extractToolResultContent(update));
          } else {
            const errorMsg = update.error || update.message || 'Tool call failed';
            this._emitToolResult(toolCallId, typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
          }
          this._activeToolCalls.delete(toolCallId);
        }
        break;
      }

      case 'tool_call_update': {
        const thinkingBlocks = this._flushThinking();
        const toolCallId = this._extractToolCallId(update, true);
        const toolName = this._extractToolName(update);
        const toolInput = this._extractToolInput(update);
        const status = this._normalizeStatus(update.status);

        if (status === 'completed') {
          // Some OpenCode streams only send completion updates without a prior
          // tool_call start event; emit a fallback tool_use so UI can render.
          this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
          const resultContent = this._extractToolResultContent(update);
          this._emitToolResult(toolCallId, resultContent);
          this._activeToolCalls.delete(toolCallId);
        } else if (status === 'failed') {
          this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
          const errorMsg = update.error || update.message || 'Tool call failed';
          this._emitToolResult(toolCallId, typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
          this._activeToolCalls.delete(toolCallId);
        } else if (status === 'in_progress' || status === 'pending') {
          this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
          this._maybeEmitQuestionPermission(toolCallId, toolName, toolInput);
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
        // Slash commands available — emit for UI
        const commands = update.availableCommands || [];
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Available commands: ${commands.map(c => c.name).join(', ')}`);
        this.emit('availableCommands', { commands });
        break;
      }

      case 'current_mode_update': {
        // Agent mode changed
        const modeState = update.mode || update;
        const currentMode = modeState?.currentMode || modeState?.mode || null;
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Mode changed to: ${currentMode}`);
        this.emit('modeChanged', { mode: currentMode });
        break;
      }

      case 'config_option_update': {
        // Config changed — log details so we can see available config IDs
        const configOptions = update.configOptions || [];
        const summary = configOptions.map(o => `${o.id}(${o.category || '?'})=${o.value || '?'}`).join(', ');
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Config options: ${summary || JSON.stringify(update).slice(0, 300)}`);
        this.emit('configChanged', { configOptions });
        break;
      }

      case 'message_stop': {
        // End of agent message stream — thinking flushed at turn end in sendPrompt
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Message stream complete`);
        break;
      }

      case 'tool_call_start': {
        const thinkingBlocks = this._flushThinking();
        // Tool call is starting (alternative to tool_call)
        const toolCallId = this._extractToolCallId(update);
        const toolName = this._extractToolName(update);
        const toolInput = this._extractToolInput(update);
        this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
        if (this._turnActive || this._approvalRequests.size > 0) {
          this.emit('status', { status: 'running' });
        }
        break;
      }

      case 'tool_call_end': {
        const thinkingBlocks = this._flushThinking();
        // Tool call completed (alternative to tool_call_update)
        const toolCallId = this._extractToolCallId(update, true);
        const toolName = this._extractToolName(update);
        const toolInput = this._extractToolInput(update);
        this._emitToolUseIfNeeded(toolCallId, toolName, toolInput, thinkingBlocks);
        const resultContent = this._extractToolResultContent(update);
        this._emitToolResult(toolCallId, resultContent);
        this._activeToolCalls.delete(toolCallId);
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
    const rpcRequestId = msg.id;
    const options = params.options || [];

    // Extract tool call info from the permission request
    const toolCall = params.toolCall || {};
    const rawToolName = toolCall.name || params.title || params.toolName || 'unknown';
    const rawToolInput = toolCall.input || params.input || params.description || {};
    const toolInput = this._normalizePermissionToolInput(rawToolInput, params, toolCall);
    const isQuestionPermission = this._isQuestionPermission(rawToolName, toolInput, params);
    const toolName = isQuestionPermission ? 'AskUserQuestion' : rawToolName;
    const toolCallId = toolCall.id || toolCall.toolCallId || null;

    console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Permission request: rpc=${rpcRequestId} tool=${toolName} isQuestion=${isQuestionPermission} questions=${Array.isArray(toolInput?.questions) ? toolInput.questions.length : 0}`);

    // If a question permission arrives via RPC (unlikely for ACP, but handle
    // gracefully), link it to any existing synthetic permission we emitted.
    if (isQuestionPermission) {
      const existing = [...this._approvalRequests.entries()]
        .find(([, v]) => v.rpcRequestId == null && v.toolCallId);

      if (existing) {
        const [, entry] = existing;
        entry.rpcRequestId = rpcRequestId;
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Linked question RPC ${rpcRequestId}`);
        return;
      }
    }

    const requestId = uuidv4();
    this._approvalRequests.set(requestId, { rpcRequestId, toolCallId });

    // Auto-approve if bypass mode is on (except question prompts, which
    // require explicit user interaction in the mobile UI).
    if (this._autoApprovePermissions && !isQuestionPermission) {
      const allowOption = options.find(o => o.kind === 'allow_once' || o.id === 'allow-once') || options[0];
      if (allowOption && rpcRequestId != null) {
        this._rpcRespond(rpcRequestId, { optionId: allowOption.optionId || allowOption.id || 'allow-once' });
      }
      this._approvalRequests.delete(requestId);
      if (this._turnActive) {
        this.emit('status', { status: 'running' });
      }
      return;
    }

    this.emit('permission', {
      requestId,
      toolName,
      toolInput,
      toolCallId,
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

    const filePath = params.path || params.filePath;
    const content = params.content;

    if (!filePath) {
      this._rpcRespond(msg.id, { error: 'No file path provided' });
      return;
    }

    if (content == null) {
      this._rpcRespond(msg.id, { error: 'No content provided' });
      return;
    }

    try {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Wrote file: ${filePath}`);
      this._rpcRespond(msg.id, {});
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] Write failed: ${err.message}`);
      this._rpcRespond(msg.id, { error: err.message });
    }
  }

  _handleTerminalRequest(msg, params, method) {
    if (msg.id == null) return;

    const terminalId = params.terminalId || `term_${this._nextTerminalId++}`;
    const sessionId = params.sessionId || this._sessionId;

    switch (method) {
      case 'terminal/create': {
        const command = params.command;
        const args = params.args || [];
        const cwd = params.cwd || this._cwd || process.env.HOME;

        if (!command) {
          this._rpcRespond(msg.id, { error: 'No command provided' });
          return;
        }

        try {
          console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Spawning terminal: ${command} ${args.join(' ')} in ${cwd}`);

          const proc = spawn(command, args, {
            cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const termData = {
            process: proc,
            output: '',
            exitCode: null,
            resolved: false,
          };
          this._terminals.set(terminalId, termData);

          proc.stdout.on('data', (data) => {
            termData.output += data.toString();
          });
          proc.stderr.on('data', (data) => {
            termData.output += data.toString();
          });

          proc.on('exit', (code, signal) => {
            termData.exitCode = code;
            termData.signal = signal;
            console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Terminal ${terminalId} exited: code=${code} signal=${signal}`);
            // Resolve any pending wait_for_exit request
            if (termData.pendingWaitId != null) {
              this._rpcRespond(termData.pendingWaitId, { exitCode: code, signal });
              termData.pendingWaitId = null;
            }
          });

          this._rpcRespond(msg.id, { terminalId });
        } catch (err) {
          this._rpcRespond(msg.id, { error: err.message });
        }
        break;
      }

      case 'terminal/output': {
        const termData = this._terminals.get(terminalId);
        if (!termData) {
          this._rpcRespond(msg.id, { output: '', truncated: false, exitStatus: null });
          return;
        }

        const truncated = false;
        this._rpcRespond(msg.id, {
          output: termData.output,
          truncated,
          exitStatus: termData.exitCode != null
            ? { exitCode: termData.exitCode, signal: termData.signal }
            : null,
        });
        break;
      }

      case 'terminal/wait_for_exit': {
        const termData = this._terminals.get(terminalId);
        if (!termData) {
          this._rpcRespond(msg.id, { exitCode: null, signal: null });
          return;
        }

        if (termData.exitCode != null) {
          this._rpcRespond(msg.id, { exitCode: termData.exitCode, signal: termData.signal });
        } else {
          termData.pendingWaitId = msg.id;
        }
        break;
      }

      case 'terminal/kill': {
        const termData = this._terminals.get(terminalId);
        if (termData?.process) {
          try {
            termData.process.kill('SIGTERM');
            setTimeout(() => {
              try { termData.process.kill('SIGKILL'); } catch {}
            }, 2000);
          } catch {}
        }
        this._rpcRespond(msg.id, {});
        break;
      }

      case 'terminal/release': {
        const termData = this._terminals.get(terminalId);
        if (termData?.process) {
          try { termData.process.kill('SIGTERM'); } catch {}
        }
        this._terminals.delete(terminalId);
        this._rpcRespond(msg.id, {});
        break;
      }

      default:
        this._rpcRespond(msg.id, { error: `Unknown terminal method: ${method}` });
    }
  }

  _normalizeStatus(status) {
    return typeof status === 'string' ? status.toLowerCase() : '';
  }

  _extractToolCallId(update, allowActiveFallback = false) {
    const candidates = [
      update?.toolCallId,
      update?.tool_call_id,
      update?.toolUseId,
      update?.tool_use_id,
      update?.id,
      update?.callId,
      update?.toolCall?.id,
      update?.tool_call?.id,
      update?.tool?.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
      if (typeof candidate === 'number') return String(candidate);
    }

    if (allowActiveFallback && this._activeToolCalls.size === 1) {
      return Array.from(this._activeToolCalls.keys())[0];
    }
    if (allowActiveFallback && this._activeToolCalls.size > 1) {
      const toolName = this._extractToolName(update);
      const matches = Array.from(this._activeToolCalls.entries())
        .filter(([, meta]) => meta.name === toolName);
      if (matches.length === 1) return matches[0][0];
    }
    return uuidv4();
  }

  _extractToolName(update) {
    const candidates = [
      update?.title,
      update?.name,
      update?.toolName,
      update?.tool_name,
      update?.tool?.name,
      update?.toolCall?.name,
      update?.tool_call?.name,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return 'unknown';
  }

  _extractToolInput(update) {
    const candidate =
      update?.input ??
      update?.rawInput ??
      update?.arguments ??
      update?.args ??
      update?.toolInput ??
      update?.tool_input ??
      update?.toolCall?.input ??
      update?.toolCall?.arguments ??
      update?.tool_call?.input;

    if (candidate == null) return {};
    if (typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;

    if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
      return { value: candidate };
    }

    return { value: candidate };
  }

  _normalizePermissionToolInput(rawToolInput, params, toolCall) {
    let toolInput = {};

    if (rawToolInput && typeof rawToolInput === 'object' && !Array.isArray(rawToolInput)) {
      toolInput = { ...rawToolInput };
    } else if (typeof rawToolInput === 'string' && rawToolInput.trim()) {
      try {
        const parsed = JSON.parse(rawToolInput);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          toolInput = parsed;
        } else {
          toolInput = { description: rawToolInput };
        }
      } catch {
        toolInput = { description: rawToolInput };
      }
    }

    if (!Array.isArray(toolInput.questions) && Array.isArray(params?.questions)) {
      toolInput.questions = params.questions;
    } else if (!Array.isArray(toolInput.questions) && Array.isArray(toolCall?.questions)) {
      toolInput.questions = toolCall.questions;
    }

    return toolInput;
  }

  _isQuestionPermission(toolName, toolInput, params) {
    const normalizedName =
      typeof toolName === 'string'
        ? toolName.toLowerCase().replace(/[^a-z0-9]/g, '')
        : '';

    if (normalizedName === 'askuserquestion' || normalizedName === 'question' || normalizedName === 'requestuserinput') {
      return true;
    }

    if (Array.isArray(toolInput?.questions) && toolInput.questions.length > 0) {
      return true;
    }

    if (Array.isArray(params?.questions) && params.questions.length > 0) {
      return true;
    }

    return false;
  }

  _formatQuestionAnswer(updatedInput) {
    const answers = updatedInput?.answers || {};
    const entries = Object.entries(answers);
    if (entries.length === 0) return 'Yes';

    if (entries.length === 1) {
      const [question, answer] = entries[0];
      return `For "${question}": ${answer}`;
    }

    return entries.map(([question, answer]) => `- ${question}: ${answer}`).join('\n');
  }

  _maybeEmitQuestionPermission(toolCallId, toolName, toolInput) {
    // Only emit for question tools that have actual question data.
    // The initial tool_call arrives with empty rawInput; the actual
    // questions come in tool_call_update — so we wait for real data.
    if (!this._isQuestionPermission(toolName, toolInput, {})) return;
    if (!Array.isArray(toolInput?.questions) || toolInput.questions.length === 0) return;
    if (this._emittedQuestionToolCalls.has(toolCallId)) return;

    this._emittedQuestionToolCalls.add(toolCallId);
    const requestId = uuidv4();
    this._approvalRequests.set(requestId, { rpcRequestId: null, toolCallId });

    console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Question permission: ${toolCallId} (${toolInput.questions.length} questions)`);

    this.emit('permission', {
      requestId,
      toolName: 'AskUserQuestion',
      toolInput,
      toolCallId,
    });
    this.emit('status', { status: 'awaiting_permission' });
  }

  async _restartForQuestion(answerText) {
    const sessionId = this._sessionId;
    const cwd = this._cwd;
    const agentId = this._agentId;
    const model = this._model;

    this._isRestartingForQuestion = true;

    // Tear down the current process without emitting exit/error events.
    this._ready = false;
    this._rejectAllPending('Restarting for question answer');
    if (this._process) {
      this._process.removeAllListeners();
      this._process.stdout.removeAllListeners();
      this._process.stderr.removeAllListeners();
      try { this._process.kill('SIGTERM'); } catch {}
      const proc = this._process;
      this._process = null;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }

    // Clean up turn state (keep _emittedQuestionToolCalls so the replayed
    // question from session/load is recognized as already-shown and skipped).
    this._turnActive = false;
    this._activeToolCalls.clear();
    this._approvalRequests.clear();
    this._buffer = '';

    // Brief pause for process cleanup
    await new Promise(r => setTimeout(r, 300));
    this._isRestartingForQuestion = false;

    // Restart the process and resume the session
    try {
      console.log(`[OpenCode ${agentId?.slice(0, 8)}] Restarting to re-send question answer`);
      await this.start(agentId, { cwd, resumeSessionId: sessionId, model });
      console.log(`[OpenCode ${agentId?.slice(0, 8)}] Restarted, emitting questionAnswered`);
      this.emit('questionAnswered', { text: answerText });
    } catch (err) {
      console.error(`[OpenCode ${agentId?.slice(0, 8)}] Restart failed:`, err.message);
      this.emit('error', { message: `Restart failed: ${err.message}` });
      this.emit('exit', { code: 1, signal: null });
    }
  }

  _flushThinking() {
    if (this._currentThinkingContent) {
      const blocks = [{ type: 'thinking', text: this._currentThinkingContent }];
      this._currentThinkingContent = '';
      return blocks;
    }
    return [];
  }

  _emitToolUseIfNeeded(toolCallId, toolName, toolInput, prefixBlocks = []) {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._activeToolCalls.set(toolCallId, {
        name: toolName,
        input: toolInput,
      });
      this.emit('message', {
        content: [
          ...prefixBlocks,
          {
            type: 'tool_use',
            id: toolCallId,
            name: toolName,
            input: toolInput,
          },
        ],
      });
    } else {
      // Emit any pending thinking blocks as their own message
      if (prefixBlocks.length > 0) {
        this.emit('message', { content: prefixBlocks });
      }
      // Update input if the new payload has richer data (e.g. rawInput
      // populated after the initial pending event with empty input).
      const existing = this._activeToolCalls.get(toolCallId);
      const newKeys = Object.keys(toolInput || {});
      const existingKeys = Object.keys(existing.input || {});
      if (newKeys.length > existingKeys.length) {
        existing.input = toolInput;
        this.emit('toolUseUpdated', {
          toolCallId,
          input: toolInput,
        });
      }
    }
  }

  _emitToolResult(toolCallId, content) {
    this.emit('message', {
      content: [{
        type: 'tool_result',
        toolUseId: toolCallId,
        content,
      }],
    });
  }

  _extractToolResultContent(update) {
    const content = update.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts = [];
      for (const c of content) {
        // Direct text blocks: { type: 'text', text: '...' }
        if (c.type === 'text' && c.text) {
          texts.push(c.text);
        // Nested content blocks (OpenCode format): { type: 'content', content: { type: 'text', text: '...' } }
        } else if (c.type === 'content' && c.content?.type === 'text' && c.content?.text) {
          texts.push(c.content.text);
        }
      }
      return texts.join('\n') || 'Completed';
    }
    if (content && typeof content === 'object' && content.text) {
      return content.text;
    }
    return update.result || update.output || 'Completed';
  }

  async sendPrompt(text, sessionId, imageData) {
    if (!this._ready || !this._sessionId) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Not ready, cannot send prompt`);
      this.emit('error', { message: 'OpenCode not ready' });
      return;
    }

    this._turnActive = true;
    this._activeToolCalls.clear();
    this.emit('status', { status: 'running' });
    this._currentStreamContent = '';
    this._currentThinkingContent = '';

    try {
      const prompt = [];
      let promptText = text;

      // Add image if provided
      if (imageData?.base64) {
        const mimeType = imageData.mimeType || 'image/png';
        const b64Len = imageData.base64.length;
        console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Image: ${mimeType}, base64 length=${b64Len}, promptCapabilities.image=${this._promptCapabilities?.image}`);

        if (this._promptCapabilities?.image) {
          // ACP image support is advertised — send as a content block
          prompt.push({ type: 'text', text: promptText });
          prompt.push({ type: 'image', data: imageData.base64, mimeType });
          promptText = null; // already added to prompt
        } else {
          // ACP image support NOT advertised — save to a temp file so the
          // agent can read it via its filesystem tools.
          const ext = mimeType === 'image/png' ? '.png'
            : mimeType === 'image/gif' ? '.gif'
            : '.jpg';
          const imgDir = join(this._cwd || tmpdir(), '.opencode-images');
          try { mkdirSync(imgDir, { recursive: true }); } catch {}
          const imgPath = join(imgDir, `image_${Date.now()}${ext}`);
          writeFileSync(imgPath, Buffer.from(imageData.base64, 'base64'));
          console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Saved image to ${imgPath} (ACP image capability not advertised)`);
          promptText = `${text}\n\n[An image has been saved to ${imgPath} for your reference.]`;
        }
      }

      if (promptText != null) {
        prompt.unshift({ type: 'text', text: promptText });
      }

      // No timeout — agent turns can run for many minutes (tool calls,
      // subagents, etc.).  Cleanup is handled by process exit or interrupt.
      const result = await this._rpcRequest('session/prompt', {
        sessionId: this._sessionId,
        prompt,
      }, 0);

      // Prompt returned — turn is complete
      const stopReason = result?.stopReason || 'end_turn';
      const isError = stopReason === 'refusal';

      // Flush any remaining thinking/stream content as a single message
      const thinkingBlocks = this._flushThinking();
      if (this._currentStreamContent || thinkingBlocks.length > 0) {
        const content = [
          ...thinkingBlocks,
          ...(this._currentStreamContent
            ? [{ type: 'text', text: this._currentStreamContent }]
            : []),
        ];
        this.emit('message', { content });
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
      this._turnActive = false;
      this._activeToolCalls.clear();
      this.emit('status', { status: 'idle' });
      this._checkBranchChange();
    } catch (err) {
      // If we're restarting for a question answer, suppress error events —
      // the restart handler will re-establish the session and send the answer.
      if (this._isRestartingForQuestion) {
        this._turnActive = false;
        this._activeToolCalls.clear();
        return;
      }

      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] session/prompt failed:`, err.message);

      // Emit any accumulated content before the error
      const errorThinkingBlocks = this._flushThinking();
      if (this._currentStreamContent || errorThinkingBlocks.length > 0) {
        const content = [
          ...errorThinkingBlocks,
          ...(this._currentStreamContent
            ? [{ type: 'text', text: this._currentStreamContent }]
            : []),
        ];
        this.emit('message', { content });
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
      this._turnActive = false;
      this._activeToolCalls.clear();
      this.emit('status', { status: 'idle' });
    }
  }

  async respondPermission(requestId, behavior, updatedInput) {
    const pending = this._approvalRequests.get(requestId);
    if (!pending) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] No approval found for requestId: ${requestId}`);
      return;
    }

    const response = {
      optionId: behavior === 'allow' ? 'allow-once' : 'reject-once'
    };

    if (behavior === 'allow' && updatedInput) {
      response.updatedInput = updatedInput;
    }

    if (pending.rpcRequestId != null) {
      // RPC available — respond immediately
      this._approvalRequests.delete(requestId);
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Responding to permission RPC ${pending.rpcRequestId}`);
      this._rpcRespond(pending.rpcRequestId, response);
    } else if (pending.toolCallId) {
      // Question from tool_call — ACP never sends session/request_permission
      // for questions. Kill the process, restart with session/load, and send
      // the answer as a new user prompt.
      this._approvalRequests.delete(requestId);
      const answerText = this._formatQuestionAnswer(updatedInput);
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Question answered, restarting to re-send: "${answerText.slice(0, 80)}"`);
      this._restartForQuestion(answerText);
      return;
    } else {
      this._approvalRequests.delete(requestId);
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Missing rpcRequestId for permission: ${requestId}`);
    }

    if (this._approvalRequests.size === 0 && this._turnActive) {
      this.emit('status', { status: 'running' });
    }
  }

  async interrupt() {
    if (!this._process) return;

    // ACP does not define a cancel RPC — send SIGINT to the process,
    // which triggers the agent's graceful abort handler.
    try {
      this._process.kill('SIGINT');
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] SIGINT sent`);
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] SIGINT failed:`, err.message);
    }

    this._turnActive = false;
    this._activeToolCalls.clear();
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

  async setSessionMode(modeId) {
    if (!this._ready || !this._sessionId) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Not ready, cannot set mode`);
      return;
    }

    try {
      const result = await this._rpcRequest('session/set_mode', {
        sessionId: this._sessionId,
        modeId,
      });
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Mode set to ${modeId}`);
      return result;
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] setSessionMode failed:`, err.message);
      throw err;
    }
  }

  async setConfigOption(configId, value) {
    if (!this._ready || !this._sessionId) {
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Not ready, cannot set config`);
      return;
    }

    try {
      const result = await this._rpcRequest('session/set_config_option', {
        sessionId: this._sessionId,
        configId,
        value,
      });
      console.log(`[OpenCode ${this._agentId?.slice(0, 8)}] Config ${configId} set to ${value}`);
      return result;
    } catch (err) {
      console.error(`[OpenCode ${this._agentId?.slice(0, 8)}] setConfigOption failed:`, err.message);
      throw err;
    }
  }

  async stop() {
    this._ready = false;
    this._rejectAllPending('Driver stopped');

    // Clean up all terminals
    for (const [termId, termData] of this._terminals) {
      if (termData.process) {
        try { termData.process.kill('SIGTERM'); } catch {}
      }
    }
    this._terminals.clear();

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
    this._emittedQuestionToolCalls.clear();
    this._isRestartingForQuestion = false;
    this._turnActive = false;
    this._activeToolCalls.clear();
  }

  // --- JSON-RPC helpers (same pattern as CodexDriver) ---

  _rpcRequest(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this._rpcId;

      // timeoutMs <= 0 means no timeout (wait indefinitely for the response)
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (this._pendingRpc.has(id)) {
              this._pendingRpc.delete(id);
              reject(new Error(`RPC timeout: ${method}`));
            }
          }, timeoutMs)
        : null;

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
