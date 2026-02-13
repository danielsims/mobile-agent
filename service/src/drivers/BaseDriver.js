// BaseDriver — abstract base class for agent transport adapters.
//
// Each agent type (Claude, Codex, OpenCode) communicates via a different
// transport and protocol. Drivers normalize these into a common event
// interface that AgentSession consumes.
//
// Events emitted:
//   'init'           → { sessionId, model, tools, cwd }
//   'stream'         → { text }
//   'message'        → { content: ContentBlock[] }
//   'result'         → { cost, totalCost, usage, duration, isError, sessionId }
//   'permission'     → { requestId, toolName, toolInput }
//   'toolUseUpdated' → { toolCallId, input }   (input became richer after initial emit)
//   'toolProgress'   → { toolName, elapsed }
//   'status'         → { status }
//   'error'          → { message }
//   'exit'           → { code, signal }

import { EventEmitter } from 'node:events';

export class BaseDriver extends EventEmitter {
  constructor(name, transportType) {
    super();
    this.name = name;               // e.g. "Claude Code", "Codex"
    this.transportType = transportType; // 'websocket-server' | 'stdio-jsonrpc' | 'http-client'
    this._ready = false;
  }

  /**
   * Start the agent process/connection.
   * @param {string} agentId — unique agent identifier
   * @param {Object} opts — { serverPort, resumeSessionId, cwd, model }
   */
  async start(agentId, opts) {
    throw new Error(`${this.name}: start() not implemented`);
  }

  /**
   * Gracefully stop the agent.
   */
  async stop() {
    throw new Error(`${this.name}: stop() not implemented`);
  }

  /**
   * Whether the transport is connected and ready to accept messages.
   */
  isReady() {
    return this._ready;
  }

  /**
   * Send a user prompt to the agent.
   * @param {string} text — user message text
   * @param {string|null} sessionId — session identifier for multi-turn
   */
  async sendPrompt(text, sessionId, imageData) {
    throw new Error(`${this.name}: sendPrompt() not implemented`);
  }

  /**
   * Respond to a permission/approval request.
   * @param {string} requestId — the permission request identifier
   * @param {'allow'|'deny'} behavior
   * @param {Object} [updatedInput] — modified tool input (for allow)
   */
  async respondPermission(requestId, behavior, updatedInput) {
    throw new Error(`${this.name}: respondPermission() not implemented`);
  }

  /**
   * Interrupt/abort the current task.
   */
  async interrupt() {
    throw new Error(`${this.name}: interrupt() not implemented`);
  }

  /**
   * Set the agent's permission/approval mode.
   * @param {string} mode — driver-specific mode string
   */
  async setPermissionMode(mode) {
    // Optional — not all drivers support runtime mode changes
  }

  /**
   * Normalize content blocks from the driver's native format to our
   * canonical ContentBlock[] format:
   *   TextBlock:       { type: 'text', text }
   *   ToolUseBlock:    { type: 'tool_use', id, name, input }
   *   ToolResultBlock: { type: 'tool_result', toolUseId, content }
   *   ThinkingBlock:   { type: 'thinking', text }
   */
  _normalizeContentBlocks(blocks) {
    if (!Array.isArray(blocks)) return [];
    return blocks.map(block => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text || '' };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return { type: 'tool_result', toolUseId: block.tool_use_id || block.toolUseId, content: block.content };
        case 'thinking':
          return { type: 'thinking', text: block.thinking || block.text || '' };
        default:
          return { type: block.type, ...block };
      }
    });
  }
}
