// ClaudeDriver — transport adapter for Claude Code CLI via --sdk-url WebSocket.
//
// Spawns the Claude CLI with --sdk-url, which makes it connect TO our server
// as a WebSocket client. Messages are NDJSON (one JSON object per WS frame).
//
// Protocol flow:
//   1. We spawn `claude --sdk-url ws://localhost:PORT/ws/cli/AGENT_ID`
//   2. CLI connects back to our WebSocket server
//   3. Bridge calls attachSocket(ws) to hand us the connection
//   4. We parse NDJSON messages and emit normalized events

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { BaseDriver } from './BaseDriver.js';

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

export class ClaudeDriver extends BaseDriver {
  constructor() {
    super('Claude Code', 'websocket-server');
    this._process = null;
    this._cliSocket = null;
    this._promptQueue = [];
    this._agentId = null;
  }

  async start(agentId, opts = {}) {
    const { serverPort, resumeSessionId = null, cwd = null, model = null } = opts;
    this._agentId = agentId;

    const sdkUrl = `ws://127.0.0.1:${serverPort}/ws/cli/${agentId}`;

    // Detect initial git branch
    let gitBranch = null;
    if (cwd) {
      try {
        gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd, encoding: 'utf-8', timeout: 3000,
        }).trim();
      } catch { /* not a git repo */ }
    }

    // Emit init-like info we already know before CLI connects
    if (cwd) {
      this.emit('init', {
        cwd,
        projectName: basename(cwd),
        gitBranch,
      });
    }

    const args = [
      '--sdk-url', sdkUrl,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    if (model) {
      args.push('--model', model);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    console.log(`[Claude ${agentId.slice(0, 8)}] Spawning: ${CLAUDE_PATH} ${resumeSessionId ? `--resume ${resumeSessionId.slice(0, 8)}...` : '--sdk-url'} ws://.../${agentId.slice(0, 8)}...`);

    this._process = spawn(CLAUDE_PATH, args, {
      cwd: cwd || process.env.HOME,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._process.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Claude ${agentId.slice(0, 8)}] stdout: ${text.slice(0, 200)}`);
    });

    this._process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Claude ${agentId.slice(0, 8)}] stderr: ${text.slice(0, 200)}`);
    });

    this._process.on('exit', (code, signal) => {
      console.log(`[Claude ${agentId.slice(0, 8)}] Exited: code=${code} signal=${signal}`);
      this._ready = false;
      this.emit('exit', { code, signal });
    });

    this._process.on('error', (err) => {
      console.error(`[Claude ${agentId.slice(0, 8)}] Process error:`, err.message);
      this._ready = false;
      this.emit('error', { message: err.message });
    });
  }

  /**
   * Called by the bridge when the CLI connects back via WebSocket.
   * This is Claude-specific — other drivers don't use this pattern.
   */
  attachSocket(ws) {
    this._cliSocket = ws;
    this._ready = true;
    this.emit('status', { status: 'connected' });
    console.log(`[Claude ${this._agentId?.slice(0, 8)}] CLI WebSocket attached`);

    ws.on('message', (data) => {
      const text = data.toString();
      try {
        this._handleMessage(JSON.parse(text));
      } catch {
        // Might be multiple JSON objects in one frame (NDJSON)
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this._handleMessage(JSON.parse(trimmed));
          } catch {
            console.log(`[Claude ${this._agentId?.slice(0, 8)}] Non-JSON from CLI: ${trimmed.slice(0, 100)}`);
          }
        }
      }
    });

    ws.on('close', (code) => {
      console.log(`[Claude ${this._agentId?.slice(0, 8)}] CLI WebSocket closed: ${code}`);
      this._cliSocket = null;
      this._ready = false;
      this.emit('status', { status: 'error' });
    });

    ws.on('error', (err) => {
      console.error(`[Claude ${this._agentId?.slice(0, 8)}] CLI WebSocket error:`, err.message);
    });

    // Flush any queued prompts
    this._flushPromptQueue();
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.emit('init', {
            sessionId: msg.session_id || null,
            model: msg.model || null,
            tools: msg.tools || [],
            cwd: msg.cwd || null,
            projectName: msg.cwd ? basename(msg.cwd) : null,
            gitBranch: this._detectBranch(msg.cwd),
          });
        }
        break;
      }

      case 'stream_event': {
        const event = msg.event;
        if (!event) break;
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text || '';
          if (text) {
            this.emit('stream', { text });
          }
        }
        break;
      }

      case 'assistant': {
        const content = msg.message?.content || [];
        const normalized = this._normalizeContentBlocks(content);
        this.emit('message', { content: normalized });
        this.emit('status', { status: 'running' });
        break;
      }

      case 'result': {
        const cost = msg.total_cost_usd || msg.cost_usd || 0;
        const usage = msg.usage || {};
        const duration = msg.duration_ms || 0;
        const isError = msg.is_error || false;

        this.emit('result', {
          cost,
          totalCost: cost,
          usage,
          duration,
          isError,
          sessionId: msg.session_id || null,
        });
        this.emit('status', { status: 'idle' });
        break;
      }

      case 'control_request': {
        const request = msg.request || {};
        const subtype = request.subtype || msg.subtype;

        if (subtype === 'can_use_tool') {
          const requestId = msg.request_id || request.id || uuidv4();
          const toolName = request.tool_name || 'unknown';
          const toolInput = request.input || request.tool_input || {};

          this.emit('permission', { requestId, toolName, toolInput });
          this.emit('status', { status: 'awaiting_permission' });
        } else {
          console.log(`[Claude ${this._agentId?.slice(0, 8)}] control_request subtype: ${subtype}`);
        }
        break;
      }

      case 'tool_progress': {
        this.emit('toolProgress', {
          toolName: msg.tool_name || null,
          elapsed: msg.elapsed_ms || 0,
        });
        break;
      }

      case 'user': {
        // Tool results from CLI — forward raw for AgentSession to merge
        this.emit('toolResults', { content: msg.message?.content });
        break;
      }

      default:
        if (msg.type) {
          console.log(`[Claude ${this._agentId?.slice(0, 8)}] Unhandled: ${msg.type}`);
        }
    }
  }

  async sendPrompt(text, sessionId) {
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      session_id: sessionId || '',
    };

    if (this._cliSocket?.readyState === 1) {
      this._send(message);
    } else {
      console.log(`[Claude ${this._agentId?.slice(0, 8)}] CLI not connected, queuing`);
      this._promptQueue.push(text);
    }
  }

  async respondPermission(requestId, behavior, updatedInput) {
    let innerResponse;
    if (behavior === 'allow') {
      innerResponse = {
        behavior: 'allow',
        updatedInput: updatedInput || {},
      };
    } else {
      innerResponse = {
        behavior: 'deny',
        message: 'Denied by user',
      };
    }

    this._send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: innerResponse,
      },
    });
  }

  async setPermissionMode(mode) {
    const requestId = `req_perm_${uuidv4().slice(0, 8)}`;
    this._send({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'set_permission_mode',
        mode,
      },
    });
    console.log(`[Claude ${this._agentId?.slice(0, 8)}] Permission mode -> ${mode}`);
  }

  async interrupt() {
    // The --sdk-url stream-json protocol does not have an interrupt control
    // message. The only reliable way to cancel an active turn is to send
    // SIGINT to the CLI process, which triggers its graceful abort handler.
    if (this._process) {
      try {
        this._process.kill('SIGINT');
        console.log(`[Claude ${this._agentId?.slice(0, 8)}] SIGINT sent`);
      } catch (err) {
        console.error(`[Claude ${this._agentId?.slice(0, 8)}] Failed to send SIGINT:`, err.message);
        throw err;
      }
    }
  }

  async stop() {
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

    this._ready = false;
    this._promptQueue = [];
  }

  _send(msg) {
    if (!this._cliSocket || this._cliSocket.readyState !== 1) return;
    this._cliSocket.send(JSON.stringify(msg) + '\n');
  }

  _flushPromptQueue() {
    while (this._promptQueue.length > 0 && this._cliSocket?.readyState === 1) {
      const text = this._promptQueue.shift();
      this._send({
        type: 'user',
        message: { role: 'user', content: text },
        session_id: '',
      });
    }
  }

  _detectBranch(cwd) {
    if (!cwd) return null;
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd, encoding: 'utf-8', timeout: 3000,
      }).trim();
    } catch {
      return null;
    }
  }
}
