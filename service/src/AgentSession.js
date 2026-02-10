import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const MAX_HISTORY = 200;
const MAX_LAST_OUTPUT = 500;

let historyMsgSeq = 0;
function nextHistoryId(suffix) {
  return `h-${++historyMsgSeq}-${suffix}`;
}

function findClaude() {
  const paths = [
    process.env.CLAUDE_PATH,
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

const CLAUDE_PATH = findClaude();

export class AgentSession {
  constructor(id, type = 'claude') {
    this.id = id;
    this.type = type;
    this.status = 'starting';
    this.sessionId = null;
    this.sessionName = null;
    this.messageHistory = [];
    this.pendingPermissions = new Map();
    this.model = null;
    this.tools = [];
    this.cwd = null;
    this.gitBranch = null;
    this.projectName = null;
    this.totalCost = 0;
    this.contextUsedPercent = 0;
    this.outputTokens = 0;
    this.lastOutput = '';
    this.createdAt = Date.now();

    this._process = null;
    this._cliSocket = null;
    this._currentStreamContent = '';
    this._onBroadcast = null;
    this._promptQueue = [];
    this._initialized = false; // True after system/init received
  }

  /**
   * Populate from a transcript read from CLI session storage.
   * Called on restore before the CLI reconnects.
   * @param {{ model: string|null, messages: Array, lastOutput: string }} transcript
   */
  loadTranscript(transcript) {
    if (transcript.model) this.model = transcript.model;
    if (transcript.lastOutput) this.lastOutput = transcript.lastOutput;
    if (transcript.messages?.length > 0) {
      this.messageHistory = transcript.messages;
    }
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
    this.status = status;
    this._broadcast('agentUpdated', { agentId: this.id, status });
  }

  /**
   * Spawn the Claude CLI with --sdk-url. The CLI connects TO our server
   * and waits for prompts over WebSocket. No --print/-p needed.
   * @param {number} serverPort
   * @param {string|null} resumeSessionId - If provided, passes --resume to restore a previous session
   */
  spawn(serverPort, resumeSessionId = null, cwd = null) {
    const sdkUrl = `ws://127.0.0.1:${serverPort}/ws/cli/${this.id}`;

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

    // --sdk-url makes the CLI connect as a WebSocket client to our server.
    // Without --print/-p, it connects and waits for user messages via WS.
    // system/init is sent after the first user message, not on connect.
    const args = [
      '--sdk-url', sdkUrl,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    console.log(`[Agent ${this.id.slice(0, 8)}] Spawning: ${CLAUDE_PATH} ${resumeSessionId ? `--resume ${resumeSessionId.slice(0, 8)}...` : '--sdk-url'} ws://.../${this.id.slice(0, 8)}...`);

    this._process = spawn(CLAUDE_PATH, args, {
      cwd: cwd || process.env.HOME,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._process.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Agent ${this.id.slice(0, 8)}] stdout: ${text.slice(0, 200)}`);
    });

    this._process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Agent ${this.id.slice(0, 8)}] stderr: ${text.slice(0, 200)}`);
    });

    this._process.on('exit', (code, signal) => {
      console.log(`[Agent ${this.id.slice(0, 8)}] Exited: code=${code} signal=${signal}`);
      this._setStatus('exited');
      this._process = null;
    });

    this._process.on('error', (err) => {
      console.error(`[Agent ${this.id.slice(0, 8)}] Process error:`, err.message);
      this._setStatus('error');
    });
  }

  /**
   * Called by the bridge when the CLI connects back via WebSocket.
   * Messages arrive as individual WebSocket frames (one JSON object per frame).
   */
  attachCliSocket(ws) {
    this._cliSocket = ws;
    this._setStatus('connected');
    console.log(`[Agent ${this.id.slice(0, 8)}] CLI WebSocket attached`);

    ws.on('message', (data) => {
      const text = data.toString();

      // Messages come as individual WebSocket frames, each a complete JSON object.
      // Try direct parse first (most common), fall back to newline splitting for NDJSON.
      try {
        const msg = JSON.parse(text);
        this._handleCliMessage(msg);
      } catch {
        // Might be multiple JSON objects in one frame (NDJSON)
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this._handleCliMessage(JSON.parse(trimmed));
          } catch {
            console.log(`[Agent ${this.id.slice(0, 8)}] Non-JSON from CLI: ${trimmed.slice(0, 100)}`);
          }
        }
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[Agent ${this.id.slice(0, 8)}] CLI WebSocket closed: ${code}`);
      this._cliSocket = null;
      if (this.status !== 'exited') {
        this._setStatus('error');
      }
    });

    ws.on('error', (err) => {
      console.error(`[Agent ${this.id.slice(0, 8)}] CLI WebSocket error:`, err.message);
    });

    // Flush any queued prompts now that the socket is connected
    this._flushPromptQueue();
  }

  _flushPromptQueue() {
    while (this._promptQueue.length > 0 && this._cliSocket?.readyState === 1) {
      const text = this._promptQueue.shift();
      this._sendToCliSocket({
        type: 'user',
        message: { role: 'user', content: text },
        session_id: this.sessionId || '',
      });
    }
  }

  /**
   * Handle a parsed message from the Claude CLI.
   */
  _handleCliMessage(msg) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id || null;
          this.model = msg.model || null;
          this.tools = msg.tools || [];
          this._initialized = true;

          // Capture working directory and derive git info
          if (msg.cwd) {
            this.cwd = msg.cwd;
            this.projectName = basename(msg.cwd);
            try {
              this.gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: msg.cwd,
                encoding: 'utf-8',
                timeout: 3000,
              }).trim();
            } catch {
              this.gitBranch = null;
            }
          }

          console.log(`[Agent ${this.id.slice(0, 8)}] Init: model=${this.model}, cwd=${this.projectName || '?'}, branch=${this.gitBranch || '?'}, tools=${this.tools.length}`);
          this._broadcast('agentUpdated', {
            agentId: this.id,
            sessionId: this.sessionId,
            model: this.model,
            tools: this.tools,
            cwd: this.cwd,
            gitBranch: this.gitBranch,
            projectName: this.projectName,
            status: 'running',
          });

          // Don't set idle here — init comes right before first response
          this._setStatus('running');
        }
        break;
      }

      case 'stream_event': {
        const event = msg.event;
        if (!event) break;

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text || '';
          if (text) {
            this._currentStreamContent += text;
            this._updateLastOutput(text);
            this._broadcast('streamChunk', { agentId: this.id, text });
          }
        }
        break;
      }

      case 'assistant': {
        this._currentStreamContent = '';
        const content = msg.message?.content || [];
        const normalized = this._normalizeContentBlocks(content);

        // Also extract text for lastOutput if we didn't get stream_events
        for (const block of normalized) {
          if (block.type === 'text' && block.text) {
            this._updateLastOutput(block.text);
          }
        }

        this.messageHistory.push({
          id: nextHistoryId('assistant'),
          type: 'assistant',
          content: normalized,
          timestamp: Date.now(),
        });
        this._trimHistory();


        this._setStatus('running');
        this._broadcast('assistantMessage', { agentId: this.id, content: normalized });
        break;
      }

      case 'result': {
        // total_cost_usd is the actual field name from Claude CLI
        const cost = msg.total_cost_usd || msg.cost_usd || 0;
        const usage = msg.usage || {};
        const duration = msg.duration_ms || 0;
        const isError = msg.is_error || false;

        this.totalCost = cost; // total_cost_usd is cumulative
        this.outputTokens += usage.output_tokens || 0;
        if (usage.input_tokens != null) {
          const totalInput = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          this.contextUsedPercent = Math.min(100, Math.round((totalInput / 200000) * 100));
        }

        if (!this.sessionId && msg.session_id) {
          this.sessionId = msg.session_id;
        }

        this._setStatus('idle');
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
        break;
      }

      case 'control_request': {
        const request = msg.request || {};
        const subtype = request.subtype || msg.subtype;

        if (subtype === 'can_use_tool') {
          // request_id can be top-level or nested in request
          const requestId = msg.request_id || request.id || uuidv4();
          const toolName = request.tool_name || 'unknown';
          // tool input can be at request.input or request.tool_input
          const toolInput = request.input || request.tool_input || {};

          this.pendingPermissions.set(requestId, {
            requestId,
            toolName,
            toolInput,
            timestamp: Date.now(),
          });

          this._setStatus('awaiting_permission');
          this._broadcast('permissionRequest', {
            agentId: this.id,
            requestId,
            toolName,
            toolInput,
          });
        } else {
          console.log(`[Agent ${this.id.slice(0, 8)}] control_request subtype: ${subtype}`);
        }
        break;
      }

      case 'tool_progress': {
        this._broadcast('toolProgress', {
          agentId: this.id,
          toolName: msg.tool_name || null,
          elapsed: msg.elapsed_ms || 0,
        });
        break;
      }

      case 'user': {
        // Merge tool_result blocks into the preceding assistant message
        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          const lastAssistant = [...this.messageHistory].reverse().find(m => m.type === 'assistant');
          if (lastAssistant && Array.isArray(lastAssistant.content)) {
            for (const b of userContent) {
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
                lastAssistant.content.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: resultText });
              }
            }
          }
        }
        break;
      }

      default:
        if (msg.type) {
          console.log(`[Agent ${this.id.slice(0, 8)}] Unhandled: ${msg.type}`);
        }
    }
  }

  _normalizeContentBlocks(blocks) {
    return blocks.map(block => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text || '' };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return { type: 'tool_result', toolUseId: block.tool_use_id, content: block.content };
        case 'thinking':
          return { type: 'thinking', text: block.thinking || block.text || '' };
        default:
          return { type: block.type, ...block };
      }
    });
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

  sendPrompt(text) {
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

    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      session_id: this.sessionId || '',
    };

    if (this._cliSocket?.readyState === 1) {
      this._sendToCliSocket(message);
    } else {
      console.log(`[Agent ${this.id.slice(0, 8)}] CLI not connected, queuing`);
      this._promptQueue.push(text);
    }
  }

  respondToPermission(requestId, behavior, updatedInput) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      console.log(`[Agent ${this.id.slice(0, 8)}] No pending permission: ${requestId}`);
      return false;
    }

    this.pendingPermissions.delete(requestId);

    let innerResponse;
    if (behavior === 'allow') {
      innerResponse = {
        behavior: 'allow',
        // updatedInput is required for allow — pass through original input
        updatedInput: updatedInput || pending.toolInput || {},
      };
    } else {
      innerResponse = {
        behavior: 'deny',
        message: 'Denied by user',
      };
    }

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: innerResponse,
      },
    };

    if (this._cliSocket?.readyState === 1) {
      this._sendToCliSocket(response);
    }

    if (this.pendingPermissions.size === 0) {
      this._setStatus('running');
    }

    return true;
  }

  _sendToCliSocket(msg) {
    if (!this._cliSocket || this._cliSocket.readyState !== 1) return;
    this._cliSocket.send(JSON.stringify(msg) + '\n');
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

    if (this._cliSocket) {
      try { this._cliSocket.close(); } catch {}
      this._cliSocket = null;
    }

    if (this._process) {
      try { this._process.kill('SIGTERM'); } catch {}
      const proc = this._process;
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
      this._process = null;
    }

    this.status = 'exited';
    this.pendingPermissions.clear();
    this._promptQueue = [];
  }
}
