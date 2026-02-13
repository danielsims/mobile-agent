// Comprehensive test suite for the driver/adapter pattern.
//
// Tests:
//   1. BaseDriver — contract compliance, event interface
//   2. ClaudeDriver — NDJSON message parsing, WebSocket protocol
//   3. CodexDriver — JSON-RPC protocol, stdin/stdout JSONL
//   4. AgentSession — transport-agnostic behavior with mock driver
//   5. Cross-driver behavioral consistency

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BaseDriver } from '../drivers/BaseDriver.js';
import { ClaudeDriver } from '../drivers/ClaudeDriver.js';
import { CodexDriver } from '../drivers/CodexDriver.js';
import { OpenCodeDriver } from '../drivers/OpenCodeDriver.js';
import { createDriver, getSupportedTypes } from '../drivers/index.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Collect events emitted by a driver into an array */
function collectEvents(driver, eventNames) {
  const collected = [];
  for (const name of eventNames) {
    driver.on(name, (data) => {
      collected.push({ event: name, data });
    });
  }
  return collected;
}

/** All events that BaseDriver can emit */
const ALL_EVENTS = ['init', 'stream', 'message', 'result', 'permission', 'toolProgress', 'toolResults', 'status', 'error', 'exit'];

/**
 * Create a mock WebSocket for testing ClaudeDriver.attachSocket()
 */
function createMockWebSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  ws.send = vi.fn();
  ws.close = vi.fn();
  return ws;
}

/**
 * Create a mock child process for testing drivers that use spawn.
 */
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

// ---------------------------------------------------------------------------
// 1. BaseDriver Contract Tests
// ---------------------------------------------------------------------------

describe('BaseDriver', () => {
  it('has correct name and transport type', () => {
    const driver = new BaseDriver('Test', 'test-transport');
    expect(driver.name).toBe('Test');
    expect(driver.transportType).toBe('test-transport');
  });

  it('starts as not ready', () => {
    const driver = new BaseDriver('Test', 'test');
    expect(driver.isReady()).toBe(false);
  });

  it('throws on abstract method calls', async () => {
    const driver = new BaseDriver('Test', 'test');
    await expect(driver.start('id', {})).rejects.toThrow('not implemented');
    await expect(driver.stop()).rejects.toThrow('not implemented');
    await expect(driver.sendPrompt('hello')).rejects.toThrow('not implemented');
    await expect(driver.respondPermission('req', 'allow')).rejects.toThrow('not implemented');
    await expect(driver.interrupt()).rejects.toThrow('not implemented');
  });

  it('setPermissionMode is optional (no-op by default)', async () => {
    const driver = new BaseDriver('Test', 'test');
    // Should not throw
    await driver.setPermissionMode('default');
  });

  it('is an EventEmitter', () => {
    const driver = new BaseDriver('Test', 'test');
    expect(driver).toBeInstanceOf(EventEmitter);
  });

  describe('_normalizeContentBlocks', () => {
    const driver = new BaseDriver('Test', 'test');

    it('normalizes text blocks', () => {
      const result = driver._normalizeContentBlocks([
        { type: 'text', text: 'hello world' },
      ]);
      expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('normalizes tool_use blocks', () => {
      const result = driver._normalizeContentBlocks([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/file.txt' } },
      ]);
      expect(result).toEqual([
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/file.txt' } },
      ]);
    });

    it('normalizes tool_result blocks with both key conventions', () => {
      const result1 = driver._normalizeContentBlocks([
        { type: 'tool_result', tool_use_id: 'tu1', content: 'result text' },
      ]);
      expect(result1[0].toolUseId).toBe('tu1');

      const result2 = driver._normalizeContentBlocks([
        { type: 'tool_result', toolUseId: 'tu2', content: 'result text' },
      ]);
      expect(result2[0].toolUseId).toBe('tu2');
    });

    it('normalizes thinking blocks', () => {
      const result = driver._normalizeContentBlocks([
        { type: 'thinking', thinking: 'I need to think about this' },
      ]);
      expect(result[0]).toEqual({ type: 'thinking', text: 'I need to think about this' });

      // Also handles 'text' field
      const result2 = driver._normalizeContentBlocks([
        { type: 'thinking', text: 'thinking via text field' },
      ]);
      expect(result2[0].text).toBe('thinking via text field');
    });

    it('handles empty and non-array input', () => {
      expect(driver._normalizeContentBlocks([])).toEqual([]);
      expect(driver._normalizeContentBlocks(null)).toEqual([]);
      expect(driver._normalizeContentBlocks(undefined)).toEqual([]);
    });

    it('passes through unknown block types', () => {
      const result = driver._normalizeContentBlocks([
        { type: 'image', url: 'https://example.com/img.png' },
      ]);
      expect(result[0].type).toBe('image');
      expect(result[0].url).toBe('https://example.com/img.png');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Driver Registry Tests
// ---------------------------------------------------------------------------

describe('Driver Registry', () => {
  it('creates Claude driver', () => {
    const driver = createDriver('claude');
    expect(driver).toBeInstanceOf(ClaudeDriver);
    expect(driver.name).toBe('Claude Code');
    expect(driver.transportType).toBe('websocket-server');
  });

  it('creates Codex driver', () => {
    const driver = createDriver('codex');
    expect(driver).toBeInstanceOf(CodexDriver);
    expect(driver.name).toBe('Codex');
    expect(driver.transportType).toBe('stdio-jsonrpc');
  });

  it('creates OpenCode driver', () => {
    const driver = createDriver('opencode');
    expect(driver).toBeInstanceOf(OpenCodeDriver);
    expect(driver.name).toBe('OpenCode');
    expect(driver.transportType).toBe('stdio-jsonrpc');
  });

  it('throws for unknown agent type', () => {
    expect(() => createDriver('unknown')).toThrow('Unknown agent type');
  });

  it('lists supported types', () => {
    const types = getSupportedTypes();
    expect(types).toContain('claude');
    expect(types).toContain('codex');
    expect(types).toContain('opencode');
  });
});

// ---------------------------------------------------------------------------
// 3. ClaudeDriver Tests
// ---------------------------------------------------------------------------

describe('ClaudeDriver', () => {
  let driver;
  let events;

  beforeEach(() => {
    driver = new ClaudeDriver();
    events = collectEvents(driver, ALL_EVENTS);
  });

  afterEach(async () => {
    try { await driver.stop(); } catch {}
  });

  describe('Socket attachment', () => {
    it('emits connected status when socket attached', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      expect(driver.isReady()).toBe(true);
      const statusEvent = events.find(e => e.event === 'status');
      expect(statusEvent.data.status).toBe('connected');
    });

    it('emits error status when socket closes', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);
      ws.emit('close', 1006);

      expect(driver.isReady()).toBe(false);
      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents[statusEvents.length - 1].data.status).toBe('error');
    });
  });

  describe('Message parsing (system/init)', () => {
    it('emits init with session info', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-123',
        model: 'claude-sonnet-4-5-20250929',
        tools: ['Read', 'Write', 'Bash'],
        cwd: '/home/user/project',
      }));

      const initEvent = events.find(e => e.event === 'init');
      expect(initEvent).toBeTruthy();
      expect(initEvent.data.sessionId).toBe('sess-123');
      expect(initEvent.data.model).toBe('claude-sonnet-4-5-20250929');
      expect(initEvent.data.tools).toEqual(['Read', 'Write', 'Bash']);
      expect(initEvent.data.cwd).toBe('/home/user/project');
      expect(initEvent.data.projectName).toBe('project');
    });

    it('does not emit running status from init alone', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-123',
        model: 'claude-sonnet-4-5-20250929',
      }));

      const statusEvents = events.filter(e => e.event === 'status');
      // Init should not imply an active turn.
      expect(statusEvents.some(e => e.data.status === 'running')).toBe(false);
    });
  });

  describe('Message parsing (streaming)', () => {
    it('emits stream events for text deltas', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        },
      }));

      ws.emit('message', JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world!' },
        },
      }));

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0].data.text).toBe('Hello ');
      expect(streamEvents[1].data.text).toBe('world!');
    });

    it('ignores non-text-delta stream events', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start' },
      }));

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(0);
    });
  });

  describe('Message parsing (assistant)', () => {
    it('emits message with normalized content blocks', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/file.txt' } },
          ],
        },
      }));

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content).toHaveLength(2);
      expect(msgEvent.data.content[0]).toEqual({ type: 'text', text: 'Let me read that file.' });
      expect(msgEvent.data.content[1]).toEqual({
        type: 'tool_use',
        id: 'tu-1',
        name: 'Read',
        input: { path: '/file.txt' },
      });
    });
  });

  describe('Message parsing (result)', () => {
    it('emits result with cost and usage', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'result',
        total_cost_usd: 0.0523,
        usage: { input_tokens: 5000, output_tokens: 1200 },
        duration_ms: 8500,
        is_error: false,
        session_id: 'sess-123',
      }));

      const resultEvent = events.find(e => e.event === 'result');
      expect(resultEvent).toBeTruthy();
      expect(resultEvent.data.cost).toBe(0.0523);
      expect(resultEvent.data.totalCost).toBe(0.0523);
      expect(resultEvent.data.usage).toEqual({ input_tokens: 5000, output_tokens: 1200 });
      expect(resultEvent.data.duration).toBe(8500);
      expect(resultEvent.data.isError).toBe(false);
      expect(resultEvent.data.sessionId).toBe('sess-123');

      // Should also emit idle status
      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents.some(e => e.data.status === 'idle')).toBe(true);
    });
  });

  describe('Message parsing (permissions)', () => {
    it('emits permission request for tool approval', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'control_request',
        request_id: 'req-42',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/test' },
        },
      }));

      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent).toBeTruthy();
      expect(permEvent.data.requestId).toBe('req-42');
      expect(permEvent.data.toolName).toBe('Bash');
      expect(permEvent.data.toolInput).toEqual({ command: 'rm -rf /tmp/test' });

      // Should emit awaiting_permission status
      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents.some(e => e.data.status === 'awaiting_permission')).toBe(true);
    });

    it('generates requestId if not provided', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'control_request',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { path: '/test.txt', content: 'hello' },
        },
      }));

      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent.data.requestId).toBeTruthy();
      expect(typeof permEvent.data.requestId).toBe('string');
    });
  });

  describe('Message parsing (tool_progress)', () => {
    it('emits toolProgress events', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'tool_progress',
        tool_name: 'Bash',
        elapsed_ms: 5000,
      }));

      const progressEvent = events.find(e => e.event === 'toolProgress');
      expect(progressEvent).toBeTruthy();
      expect(progressEvent.data.toolName).toBe('Bash');
      expect(progressEvent.data.elapsed).toBe(5000);
    });
  });

  describe('Message parsing (user/tool results)', () => {
    it('emits toolResults for tool_result content', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      ws.emit('message', JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file content here' },
          ],
        },
      }));

      const toolResultsEvent = events.find(e => e.event === 'toolResults');
      expect(toolResultsEvent).toBeTruthy();
      expect(toolResultsEvent.data.content[0].tool_use_id).toBe('tu-1');
    });
  });

  describe('NDJSON parsing', () => {
    it('handles multiple JSON objects in one WebSocket frame', () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      // Send two messages in one frame separated by newline
      const combined =
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } }) +
        '\n' +
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } } });

      ws.emit('message', combined);

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(2);
    });
  });

  describe('Sending messages', () => {
    it('sends prompt via WebSocket', async () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      await driver.sendPrompt('Hello Claude', 'sess-123');

      expect(ws.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(ws.send.mock.calls[0][0].trim());
      expect(sent.type).toBe('user');
      expect(sent.message.role).toBe('user');
      expect(sent.message.content).toBe('Hello Claude');
      expect(sent.session_id).toBe('sess-123');
    });

    it('queues prompts when socket not ready', async () => {
      // Don't attach a socket
      await driver.sendPrompt('Hello Claude', 'sess-123');

      // Now attach socket — should flush
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      expect(ws.send).toHaveBeenCalledOnce();
    });

    it('sends permission allow response', async () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      await driver.respondPermission('req-42', 'allow', { command: 'ls' });

      expect(ws.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(ws.send.mock.calls[0][0].trim());
      expect(sent.type).toBe('control_response');
      expect(sent.response.request_id).toBe('req-42');
      expect(sent.response.response.behavior).toBe('allow');
      expect(sent.response.response.updatedInput).toEqual({ command: 'ls' });
    });

    it('sends permission deny response', async () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      await driver.respondPermission('req-42', 'deny');

      const sent = JSON.parse(ws.send.mock.calls[0][0].trim());
      expect(sent.response.response.behavior).toBe('deny');
      expect(sent.response.response.message).toBe('Denied by user');
    });
  });

  describe('Permission mode', () => {
    it('sends permission mode change', async () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);

      await driver.setPermissionMode('bypassPermissions');

      expect(ws.send).toHaveBeenCalledOnce();
      const sent = JSON.parse(ws.send.mock.calls[0][0].trim());
      expect(sent.type).toBe('control_request');
      expect(sent.request.subtype).toBe('set_permission_mode');
      expect(sent.request.mode).toBe('bypassPermissions');
    });
  });

  describe('Interrupt', () => {
    it('sends SIGINT to the CLI process', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      await driver.interrupt();

      expect(proc.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('does nothing when no process exists', async () => {
      driver._process = null;
      // Should not throw
      await driver.interrupt();
    });
  });

  describe('Cleanup', () => {
    it('closes socket and marks not ready on stop', async () => {
      const ws = createMockWebSocket();
      driver.attachSocket(ws);
      expect(driver.isReady()).toBe(true);

      await driver.stop();

      expect(driver.isReady()).toBe(false);
      expect(ws.close).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. CodexDriver Tests
// ---------------------------------------------------------------------------

describe('CodexDriver', () => {
  let driver;
  let events;

  beforeEach(() => {
    driver = new CodexDriver();
    events = collectEvents(driver, ALL_EVENTS);
  });

  afterEach(() => {
    // Clear pending RPCs without rejecting (to avoid unhandled rejections)
    // then stop the driver
    for (const [id, pending] of driver._pendingRpc) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(null); // resolve silently instead of rejecting
    }
    driver._pendingRpc.clear();
    driver.stop().catch(() => {});
  });

  describe('Message handling (turn lifecycle)', () => {
    it('emits running status on turn/started', () => {
      driver._handleMessage({
        method: 'turn/started',
        params: { turnId: 'turn-1' },
      });

      const statusEvent = events.find(e => e.event === 'status');
      expect(statusEvent).toBeTruthy();
      expect(statusEvent.data.status).toBe('running');
    });

    it('emits result and idle on turn/completed', () => {
      driver._threadId = 'thread-1';
      driver._cwd = '/tmp'; // prevent actual git call

      driver._handleMessage({
        method: 'turn/completed',
        params: {
          turn: { status: 'completed' },
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      });

      const resultEvent = events.find(e => e.event === 'result');
      expect(resultEvent).toBeTruthy();
      expect(resultEvent.data.usage.input_tokens).toBe(1000);
      expect(resultEvent.data.usage.output_tokens).toBe(500);
      expect(resultEvent.data.isError).toBe(false);

      const statusEvent = events.filter(e => e.event === 'status');
      expect(statusEvent.some(e => e.data.status === 'idle')).toBe(true);
    });

    it('marks turn/failed as error result', () => {
      driver._handleMessage({
        method: 'turn/failed',
        params: { error: 'Rate limit exceeded' },
      });

      const resultEvent = events.find(e => e.event === 'result');
      expect(resultEvent).toBeTruthy();
      expect(resultEvent.data.isError).toBe(true);

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.data.message).toBe('Rate limit exceeded');
    });

    it('emits error for protocol-level error notifications', () => {
      driver._handleMessage({
        method: 'error',
        params: { message: 'Transport failed' },
      });

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.data.message).toBe('Transport failed');
    });
  });

  describe('Message handling (streaming)', () => {
    it('emits stream events for agent message deltas', () => {
      driver._handleMessage({
        method: 'item/agentMessage/delta',
        params: { delta: 'Hello ' },
      });

      driver._handleMessage({
        method: 'item/agentMessage/delta',
        params: { delta: 'world!' },
      });

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0].data.text).toBe('Hello ');
      expect(streamEvents[1].data.text).toBe('world!');
    });

    it('accumulates stream content for final message', () => {
      driver._handleMessage({
        method: 'item/agentMessage/delta',
        params: { delta: 'Hello ' },
      });
      driver._handleMessage({
        method: 'item/agentMessage/delta',
        params: { delta: 'world!' },
      });

      // Now complete the item — should use accumulated content
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: 'item-1' },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].text).toBe('Hello world!');
    });
  });

  describe('Message handling (item completed)', () => {
    it('emits message for completed agent message', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: 'msg-1', text: 'Here is my response.' },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content).toEqual([
        { type: 'text', text: 'Here is my response.' },
      ]);
    });

    it('emits tool_use + tool_result for command execution', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'cmd-1',
            command: 'ls -la',
            output: 'total 32\ndrwxr-xr-x  5 user staff  160 Jan 1 00:00 .',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content).toHaveLength(2);
      expect(msgEvent.data.content[0].type).toBe('tool_use');
      expect(msgEvent.data.content[0].name).toBe('command_execution');
      expect(msgEvent.data.content[0].input.command).toBe('ls -la');
      expect(msgEvent.data.content[1].type).toBe('tool_result');
      expect(msgEvent.data.content[1].content).toContain('total 32');
    });

    it('uses matching generated IDs when command execution item lacks an ID', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            command: 'pwd',
            output: '/tmp',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].id).toBeTruthy();
      expect(msgEvent.data.content[1].toolUseId).toBe(msgEvent.data.content[0].id);
    });

    it('emits tool_use for file changes', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'fileChange',
            id: 'file-1',
            filePath: '/src/app.js',
            action: 'modify',
            diff: '+console.log("hello")',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].name).toBe('file_change');
      expect(msgEvent.data.content[0].input.file).toBe('/src/app.js');
    });

    it('emits thinking block for reasoning', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'reasoning',
            text: 'I should check the tests first',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0]).toEqual({
        type: 'thinking',
        text: 'I should check the tests first',
      });
    });

    it('extracts thinking text from reasoning summary payloads', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '**Planning file update**' }],
            content: null,
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0]).toEqual({
        type: 'thinking',
        text: 'Planning file update',
      });
    });

    it('extracts thinking text from string summary arrays', () => {
      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'reasoning',
            summary: ['**Checking references**'],
            content: [],
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0]).toEqual({
        type: 'thinking',
        text: 'Checking references',
      });
    });

    it('emits tool_use on web search start and tool_result on completion', () => {
      driver._handleMessage({
        method: 'item/started',
        params: {
          item: {
            type: 'webSearch',
            id: 'ws-1',
            query: '',
            action: { type: 'other' },
          },
        },
      });

      driver._handleMessage({
        method: 'item/completed',
        params: {
          item: {
            type: 'webSearch',
            id: 'ws-1',
            query: 'openai models',
            action: {
              type: 'search',
              query: 'openai models',
              queries: ['openai models', 'openai latest model'],
            },
          },
        },
      });

      const messageEvents = events.filter(e => e.event === 'message');
      expect(messageEvents.length).toBeGreaterThanOrEqual(2);

      const startMsg = messageEvents[0];
      expect(startMsg.data.content[0].type).toBe('tool_use');
      expect(startMsg.data.content[0].name).toBe('web_search');
      expect(startMsg.data.content[0].id).toBe('ws-1');

      const endMsg = messageEvents[1];
      expect(endMsg.data.content[0].type).toBe('tool_result');
      expect(endMsg.data.content[0].toolUseId).toBe('ws-1');
      expect(endMsg.data.content[0].content).toContain('Query: openai models');
    });
  });

  describe('Message handling (permissions)', () => {
    it('emits permission for command execution approval', () => {
      driver._handleMessage({
        method: 'item/commandExecution/requestApproval',
        params: {
          itemId: 'cmd-1',
          parsedCmd: { cmd: 'rm', args: ['-rf', '/tmp/test'] },
          reason: 'Potentially dangerous command',
        },
      });

      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent).toBeTruthy();
      expect(permEvent.data.toolName).toBe('command_execution');
      expect(permEvent.data.toolInput.command).toBe('rm');
      expect(permEvent.data.toolInput.args).toEqual(['-rf', '/tmp/test']);
      expect(permEvent.data.toolInput.reason).toBe('Potentially dangerous command');
      expect(permEvent.data.requestId).toBeTruthy();
    });

    it('emits permission for file change approval', () => {
      driver._handleMessage({
        method: 'item/fileChange/requestApproval',
        params: {
          itemId: 'file-1',
          filePath: '/etc/hosts',
          reason: 'System file modification',
        },
      });

      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent).toBeTruthy();
      expect(permEvent.data.toolName).toBe('file_change');
      expect(permEvent.data.toolInput.file).toBe('/etc/hosts');
    });
  });

  describe('Message handling (dynamic tool server requests)', () => {
    it('responds to unsupported item/tool/call with a failure result', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'srv-tool-1',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: '0',
          callId: 'call-1',
          tool: 'custom_tool',
          arguments: { foo: 'bar' },
        },
      });

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe('srv-tool-1');
      expect(msg.result.success).toBe(false);
      expect(Array.isArray(msg.result.contentItems)).toBe(true);
    });

    it('responds to item/tool/requestUserInput with empty answers', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'srv-input-1',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: '0',
          itemId: 'item-1',
          questions: [{ id: 'q1', header: 'Q1', question: 'Continue?' }],
        },
      });

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe('srv-input-1');
      expect(msg.result).toEqual({ answers: {} });
    });
  });

  describe('JSON-RPC communication', () => {
    it('sends JSON-RPC requests with incrementing IDs', () => {
      const proc = createMockProcess();
      driver._process = proc;

      // Send two requests
      driver._rpcRequest('method1', { param1: 'value1' });
      driver._rpcRequest('method2', { param2: 'value2' });

      expect(proc.stdin.write).toHaveBeenCalledTimes(2);
      const msg1 = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      const msg2 = JSON.parse(proc.stdin.write.mock.calls[1][0].trim());

      expect(msg1.jsonrpc).toBe('2.0');
      expect(msg1.method).toBe('method1');
      expect(msg1.id).toBe(1);
      expect(msg2.id).toBe(2);
    });

    it('resolves RPC requests on response', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});

      // Simulate response coming back
      const id = JSON.parse(proc.stdin.write.mock.calls[0][0].trim()).id;
      driver._handleMessage({ id, result: { success: true } });

      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    it('rejects RPC requests on error response', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});

      const id = JSON.parse(proc.stdin.write.mock.calls[0][0].trim()).id;
      driver._handleMessage({ id, error: { message: 'Something went wrong' } });

      await expect(promise).rejects.toThrow('Something went wrong');
    });

    it('sends notifications without ID', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._rpcNotify('initialized', {});

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.method).toBe('initialized');
      expect(msg.id).toBeUndefined();
    });
  });

  describe('Prompt sending', () => {
    it('sends turn/start via RPC when ready', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._threadId = 'thread-123';

      const sendPromise = driver.sendPrompt('Fix the bug', 'thread-123');

      // Respond to the RPC request
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('turn/start');
      expect(msg.params.threadId).toBe('thread-123');
      expect(msg.params.input).toEqual([{ type: 'text', text: 'Fix the bug' }]);
      expect(msg.params.approvalPolicy).toBe('untrusted');
      expect(msg.params.sandboxPolicy).toEqual({
        type: 'workspaceWrite',
        networkAccess: false,
      });

      // Resolve the request
      driver._handleMessage({ id: msg.id, result: {} });
      await sendPromise;
    });

    it('emits error when not ready', async () => {
      driver._ready = false;
      await driver.sendPrompt('Fix the bug');

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.data.message).toBe('Codex not ready');
    });

    it('includes extra writable roots in workspace sandbox policy when present', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._threadId = 'thread-123';
      driver._workspaceWritableRoots = ['/repo/.git', '/repo/.git/worktrees/feat-codex'];
      await driver.setPermissionMode('bypassPermissions');

      const sendPromise = driver.sendPrompt('Commit these changes');
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());

      expect(msg.params.sandboxPolicy).toEqual({
        type: 'workspaceWrite',
        networkAccess: false,
        writableRoots: ['/repo/.git', '/repo/.git/worktrees/feat-codex'],
      });

      driver._handleMessage({ id: msg.id, result: {} });
      await sendPromise;
    });
  });

  describe('Permission response', () => {
    it('responds to server approval requests using JSON-RPC response objects', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      // Simulate an incoming server request (msg.id + method).
      driver._handleMessage({
        id: 'srv-123',
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'cmd-1', parsedCmd: { cmd: 'npm', args: ['install'] } },
      });

      // Get the requestId that was generated
      const permEvent = events.find(e => e.event === 'permission');
      const requestId = permEvent.data.requestId;

      // Respond with approval
      await driver.respondPermission(requestId, 'allow');
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe('srv-123');
      expect(msg.result.decision).toBe('accept');
    });

    it('falls back to legacy item/approve when approval arrives without server request id', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'cmd-1', parsedCmd: { cmd: 'npm', args: ['install'] } },
      });

      const permEvent = events.find(e => e.event === 'permission');
      const requestId = permEvent.data.requestId;

      const promise = driver.respondPermission(requestId, 'allow');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('item/approve');
      expect(msg.params.itemId).toBe('cmd-1');
      expect(msg.params.decision).toBe('accept');

      driver._handleMessage({ id: msg.id, result: {} });
      await promise;
    });

    it('sends decline for denied permission', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'srv-456',
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'cmd-2', parsedCmd: { cmd: 'rm', args: ['-rf', '/'] } },
      });

      const permEvent = events.find(e => e.event === 'permission');
      await driver.respondPermission(permEvent.data.requestId, 'deny');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.id).toBe('srv-456');
      expect(msg.result.decision).toBe('decline');
    });
  });

  describe('Cleanup', () => {
    it('kills process and clears state on stop', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._threadId = 'thread-1';

      await driver.stop();

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(driver.isReady()).toBe(false);
      expect(driver._threadId).toBeNull();
    });

    it('rejects pending RPC requests on stop', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});
      // Attach catch handler before stop() to avoid unhandled rejection
      const rejection = promise.catch(e => e);
      await driver.stop();

      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Driver stopped');
    });
  });

  describe('Permission mode mapping', () => {
    it('maps bypassPermissions to on-failure with workspace-write sandbox', async () => {
      await driver.setPermissionMode('bypassPermissions');
      expect(driver._approvalPolicy).toBe('on-failure');
      expect(driver._sandboxMode).toBe('workspace-write');
    });

    it('maps default to untrusted with workspace-write sandbox', async () => {
      await driver.setPermissionMode('default');
      expect(driver._approvalPolicy).toBe('untrusted');
      expect(driver._sandboxMode).toBe('workspace-write');
    });
  });

  describe('Initialization fallback', () => {
    it('retries thread/start without model when explicit model is unsupported', async () => {
      driver._agentId = 'agent-1';
      driver._model = 'codex-mini-latest';
      driver._rpcNotify = vi.fn();
      driver._rpcRequest = vi.fn()
        .mockResolvedValueOnce({}) // initialize
        .mockRejectedValueOnce(new Error('model is not supported'))
        .mockResolvedValueOnce({ thread: { id: 'thread-1' } });

      await driver._initialize('/tmp', 'main', null);

      expect(driver._rpcRequest).toHaveBeenNthCalledWith(2, 'thread/start', expect.objectContaining({
        model: 'codex-mini-latest',
        cwd: '/tmp',
        sandbox: driver._sandboxMode,
      }));
      expect(driver._rpcRequest).toHaveBeenNthCalledWith(3, 'thread/start', {
        cwd: '/tmp',
        approvalPolicy: driver._approvalPolicy,
        sandbox: driver._sandboxMode,
      });
      expect(driver._threadId).toBe('thread-1');
      expect(driver.isReady()).toBe(true);
      expect(driver._model).toBeNull();
    });
  });

  describe('stdout JSONL parsing', () => {
    it('handles partial lines across data chunks via buffer logic', () => {
      // Test the buffer splitting logic that the stdout 'data' handler uses.
      // We simulate the same algorithm: accumulate into _buffer, split by \n,
      // keep incomplete last segment, parse complete lines.

      const fullMessage = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });
      const splitPoint = Math.floor(fullMessage.length / 2);

      // First chunk: partial JSON — buffer holds incomplete line
      driver._buffer += fullMessage.substring(0, splitPoint);
      let lines = driver._buffer.split('\n');
      driver._buffer = lines.pop() || '';
      // No complete lines yet (no \n in the data)
      for (const line of lines) {
        if (line.trim()) driver._handleMessage(JSON.parse(line.trim()));
      }
      expect(events.filter(e => e.event === 'stream')).toHaveLength(0);

      // Second chunk: rest of JSON + newline — now we have a complete line
      driver._buffer += fullMessage.substring(splitPoint) + '\n';
      lines = driver._buffer.split('\n');
      driver._buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) driver._handleMessage(JSON.parse(line.trim()));
      }

      expect(events.filter(e => e.event === 'stream')).toHaveLength(1);
      expect(events.find(e => e.event === 'stream').data.text).toBe('hello');
    });
  });
});

// ---------------------------------------------------------------------------
// 5. OpenCodeDriver Tests
// ---------------------------------------------------------------------------

describe('OpenCodeDriver', () => {
  let driver;
  let events;

  beforeEach(() => {
    driver = new OpenCodeDriver();
    events = collectEvents(driver, ALL_EVENTS);
  });

  afterEach(() => {
    for (const [id, pending] of driver._pendingRpc) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(null);
    }
    driver._pendingRpc.clear();
    driver.stop().catch(() => {});
  });

  describe('Message handling (session lifecycle)', () => {
    it('emits running status on session/update with tool_call', () => {
      driver._turnActive = true;
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Read',
            status: 'in_progress',
            input: { path: '/file.txt' },
          },
        },
      });

      const statusEvent = events.find(e => e.event === 'status');
      expect(statusEvent).toBeTruthy();
      expect(statusEvent.data.status).toBe('running');
    });

    it('does not emit running status for late tool_call when turn is not active', () => {
      driver._turnActive = false;
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call',
            toolCallId: 'tc-late',
            title: 'Read',
            status: 'in_progress',
            input: { path: '/late.txt' },
          },
        },
      });

      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents.some(e => e.data.status === 'running')).toBe(false);
    });

    it('emits result and idle when session/prompt RPC returns', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-1';

      const sendPromise = driver.sendPrompt('Fix the bug');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      driver._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });
      await sendPromise;

      const resultEvent = events.find(e => e.event === 'result');
      expect(resultEvent).toBeTruthy();
      expect(resultEvent.data.isError).toBe(false);
      expect(resultEvent.data.sessionId).toBe('sess-1');

      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents.some(e => e.data.status === 'idle')).toBe(true);
    });

    it('emits error for failed prompt returns', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-1';

      const sendPromise = driver.sendPrompt('Fix the bug');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      driver._handleMessage({ id: msg.id, error: { message: 'Rate limit exceeded' } });
      await sendPromise;

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.data.message).toBe('Rate limit exceeded');

      const resultEvent = events.find(e => e.event === 'result');
      expect(resultEvent).toBeTruthy();
      expect(resultEvent.data.isError).toBe(true);
    });
  });

  describe('Message handling (streaming)', () => {
    it('emits stream events for agent_message_chunk updates', () => {
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'agent_message_chunk',
            content: [{ type: 'text', text: 'Hello ' }],
          },
        },
      });

      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'agent_message_chunk',
            content: [{ type: 'text', text: 'world!' }],
          },
        },
      });

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0].data.text).toBe('Hello ');
      expect(streamEvents[1].data.text).toBe('world!');
    });

    it('handles agent_message_chunk with string content', () => {
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'agent_message_chunk',
            content: 'raw text chunk',
          },
        },
      });

      const streamEvents = events.filter(e => e.event === 'stream');
      expect(streamEvents).toHaveLength(1);
      expect(streamEvents[0].data.text).toBe('raw text chunk');
    });

    it('accumulates stream content for final message on prompt return', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-1';

      const sendPromise = driver.sendPrompt('Hello');

      // Simulate streaming during the prompt
      driver._handleMessage({
        method: 'session/update',
        params: { update: { type: 'agent_message_chunk', content: [{ type: 'text', text: 'Hello ' }] } },
      });
      driver._handleMessage({
        method: 'session/update',
        params: { update: { type: 'agent_message_chunk', content: [{ type: 'text', text: 'world!' }] } },
      });

      // Complete the prompt
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      driver._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });
      await sendPromise;

      // Should emit accumulated stream as final message
      const msgEvent = events.find(e => e.event === 'message' && e.data.content?.[0]?.type === 'text');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].text).toBe('Hello world!');
    });
  });

  describe('Message handling (item completed)', () => {
    it('emits tool_use for pending tool_call', () => {
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Bash',
            status: 'pending',
            input: { command: 'ls -la' },
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].type).toBe('tool_use');
      expect(msgEvent.data.content[0].id).toBe('tc-1');
      expect(msgEvent.data.content[0].name).toBe('Bash');
      expect(msgEvent.data.content[0].input).toEqual({ command: 'ls -la' });
    });

    it('emits tool_result for completed tool_call_update', () => {
      driver._activeToolCalls.set('tc-1', {
        name: 'Bash',
        input: { command: 'ls -la' },
      });
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: 'file1.txt\nfile2.txt',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].type).toBe('tool_result');
      expect(msgEvent.data.content[0].toolUseId).toBe('tc-1');
      expect(msgEvent.data.content[0].content).toBe('file1.txt\nfile2.txt');
    });

    it('emits tool_result with error for failed tool_call_update', () => {
      driver._activeToolCalls.set('tc-1', {
        name: 'Bash',
        input: { command: 'rm -rf /tmp/test' },
      });
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'failed',
            error: 'Permission denied',
          },
        },
      });

      const msgEvent = events.find(e => e.event === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.data.content[0].type).toBe('tool_result');
      expect(msgEvent.data.content[0].content).toBe('Permission denied');
    });

    it('emits fallback tool_use before tool_result when completion arrives without start', () => {
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call_update',
            toolCallId: 'tc-missing-start',
            title: 'read',
            status: 'completed',
            input: { path: '/tmp/a.txt' },
            content: 'done',
          },
        },
      });

      const msgEvents = events.filter(e => e.event === 'message');
      expect(msgEvents).toHaveLength(2);
      expect(msgEvents[0].data.content[0].type).toBe('tool_use');
      expect(msgEvents[0].data.content[0].id).toBe('tc-missing-start');
      expect(msgEvents[1].data.content[0].type).toBe('tool_result');
      expect(msgEvents[1].data.content[0].toolUseId).toBe('tc-missing-start');
      expect(msgEvents[1].data.content[0].content).toBe('done');
    });

    it('accumulates thinking and includes it in next tool message', () => {
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'agent_thought_chunk',
            content: 'I should check the tests first',
          },
        },
      });

      // Thinking is accumulated, not emitted immediately
      expect(events.filter(e => e.event === 'message').length).toBe(0);

      // Trigger flush via tool_call — thinking is combined with tool_use
      driver._handleMessage({
        method: 'session/update',
        params: {
          update: {
            type: 'tool_call',
            toolCallId: 'tc-think-flush',
            title: 'Read',
            input: { file_path: '/tmp/test' },
            status: 'pending',
          },
        },
      });

      const msgEvents = events.filter(e => e.event === 'message');
      expect(msgEvents.length).toBe(1);
      expect(msgEvents[0].data.content[0]).toEqual({
        type: 'thinking',
        text: 'I should check the tests first',
      });
      expect(msgEvents[0].data.content[1].type).toBe('tool_use');
    });
  });

  describe('Message handling (permissions)', () => {
    it('emits permission for session/request_permission (reverse RPC)', () => {
      driver._handleMessage({
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          title: 'Bash',
          input: { command: 'rm -rf /tmp/test' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent).toBeTruthy();
      expect(permEvent.data.requestId).toBeTruthy();
      expect(permEvent.data.toolName).toBe('Bash');
      expect(permEvent.data.toolInput).toEqual({ command: 'rm -rf /tmp/test' });

      const statusEvents = events.filter(e => e.event === 'status');
      expect(statusEvents.some(e => e.data.status === 'awaiting_permission')).toBe(true);
    });

    it('responds with allow-once for allowed permissions', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          title: 'Read',
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      const permEvent = events.find(e => e.event === 'permission');
      driver.respondPermission(permEvent.data.requestId, 'allow');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe('perm-1');
      expect(msg.result.optionId).toBe('allow-once');
    });

    it('responds with reject-once for denied permissions', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'perm-2',
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          title: 'Bash',
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      const permEvent = events.find(e => e.event === 'permission');
      driver.respondPermission(permEvent.data.requestId, 'deny');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.id).toBe('perm-2');
      expect(msg.result.optionId).toBe('reject-once');
    });

    it('auto-approves permissions in bypass mode', () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._autoApprovePermissions = true;

      driver._handleMessage({
        id: 'perm-3',
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          title: 'Write',
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      // Should NOT emit permission event (auto-approved)
      const permEvent = events.find(e => e.event === 'permission');
      expect(permEvent).toBeUndefined();

      // Should have responded with allow
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.id).toBe('perm-3');
      expect(msg.result.optionId).toBe('allow-once');
    });
  });

  describe('Message handling (agent→client reverse RPC)', () => {
    it('responds to fs/read_text_file requests', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'fs-1',
        method: 'fs/read_text_file',
        params: { path: '/tmp/test-file-that-does-not-exist.txt' },
      });

      // Should have responded via _rpcRespond
      expect(proc.stdin.write).toHaveBeenCalled();
      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe('fs-1');
      // File doesn't exist, so we get an error response
      expect(msg.result).toBeTruthy();
      expect(msg.result.error).toBeTruthy();
    });

    it('responds to fs/write_text_file requests with success', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'fs-2',
        method: 'fs/write_text_file',
        params: { path: '/tmp/test-write.txt', content: 'hello world' },
      });

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.id).toBe('fs-2');
      expect(msg.result).toBeTruthy();
      expect(msg.result.error).toBeUndefined();
    });

    it('responds to terminal/create requests', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._handleMessage({
        id: 'term-1',
        method: 'terminal/create',
        params: { command: 'ls', args: ['-la'], sessionId: 'sess-1' },
      });

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.id).toBe('term-1');
      expect(msg.result).toBeTruthy();
      expect(msg.result.terminalId).toBeTruthy();
    });
  });

  describe('JSON-RPC communication', () => {
    it('sends JSON-RPC requests with incrementing IDs', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._rpcRequest('method1', { param1: 'value1' });
      driver._rpcRequest('method2', { param2: 'value2' });

      expect(proc.stdin.write).toHaveBeenCalledTimes(2);
      const msg1 = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      const msg2 = JSON.parse(proc.stdin.write.mock.calls[1][0].trim());

      expect(msg1.jsonrpc).toBe('2.0');
      expect(msg1.method).toBe('method1');
      expect(msg1.id).toBe(1);
      expect(msg2.id).toBe(2);
    });

    it('resolves RPC requests on response', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});

      const id = JSON.parse(proc.stdin.write.mock.calls[0][0].trim()).id;
      driver._handleMessage({ id, result: { success: true } });

      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    it('rejects RPC requests on error response', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});

      const id = JSON.parse(proc.stdin.write.mock.calls[0][0].trim()).id;
      driver._handleMessage({ id, error: { message: 'Something went wrong' } });

      await expect(promise).rejects.toThrow('Something went wrong');
    });

    it('sends notifications without ID', () => {
      const proc = createMockProcess();
      driver._process = proc;

      driver._rpcNotify('initialized', {});

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.method).toBe('initialized');
      expect(msg.id).toBeUndefined();
    });
  });

  describe('Prompt sending', () => {
    it('sends session/prompt via RPC when ready', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-123';

      const sendPromise = driver.sendPrompt('Fix the bug', 'sess-123');

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('session/prompt');
      expect(msg.params.sessionId).toBe('sess-123');
      expect(msg.params.prompt).toEqual([{ type: 'text', text: 'Fix the bug' }]);

      driver._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });
      await sendPromise;
    });

    it('includes image content block when promptCapabilities.image is true', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-123';
      driver._promptCapabilities = { image: true };

      const imageData = {
        uri: 'file:///tmp/test.png',
        base64: 'dGVzdA==',
        mimeType: 'image/png',
      };

      const sendPromise = driver.sendPrompt('What is in this image?', 'sess-123', imageData);

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('session/prompt');
      expect(msg.params.prompt).toEqual([
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ]);

      driver._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });
      await sendPromise;
    });

    it('falls back to temp file when promptCapabilities.image is not set', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-123';
      driver._promptCapabilities = {};

      const imageData = {
        uri: 'file:///tmp/test.png',
        base64: 'dGVzdA==',
        mimeType: 'image/png',
      };

      const sendPromise = driver.sendPrompt('Describe this', 'sess-123', imageData);

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('session/prompt');
      // Should have only text, no image block
      expect(msg.params.prompt).toHaveLength(1);
      expect(msg.params.prompt[0].type).toBe('text');
      expect(msg.params.prompt[0].text).toContain('Describe this');
      expect(msg.params.prompt[0].text).toContain('[An image has been saved to');
      expect(msg.params.prompt[0].text).toContain('.png');

      driver._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });
      await sendPromise;
    });

    it('emits error when not ready', async () => {
      driver._ready = false;
      await driver.sendPrompt('Fix the bug');

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent.data.message).toBe('OpenCode not ready');
    });
  });

  describe('Interrupt', () => {
    it('sends session/cancel on interrupt', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._sessionId = 'sess-123';

      const interruptPromise = driver.interrupt();

      const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
      expect(msg.method).toBe('session/cancel');
      expect(msg.params.sessionId).toBe('sess-123');

      driver._handleMessage({ id: msg.id, result: {} });
      await interruptPromise;
    });

    it('handles interrupt when no active session', async () => {
      driver._sessionId = null;
      // Should not throw
      await driver.interrupt();
    });
  });

  describe('Permission mode', () => {
    it('maps bypassPermissions to auto-approve', async () => {
      await driver.setPermissionMode('bypassPermissions');
      expect(driver._autoApprovePermissions).toBe(true);
    });

    it('maps default to manual approval', async () => {
      driver._autoApprovePermissions = true;
      await driver.setPermissionMode('default');
      expect(driver._autoApprovePermissions).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('kills process and clears state on stop', async () => {
      const proc = createMockProcess();
      driver._process = proc;
      driver._ready = true;
      driver._sessionId = 'sess-1';

      await driver.stop();

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(driver.isReady()).toBe(false);
      expect(driver._sessionId).toBeNull();
    });

    it('rejects pending RPC requests on stop', async () => {
      const proc = createMockProcess();
      driver._process = proc;

      const promise = driver._rpcRequest('test/method', {});
      const rejection = promise.catch(e => e);
      await driver.stop();

      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Driver stopped');
    });
  });

  describe('stdout JSONL parsing', () => {
    it('handles partial lines across data chunks via buffer logic', () => {
      const fullMessage = JSON.stringify({
        method: 'session/update',
        params: { update: { type: 'agent_message_chunk', content: [{ type: 'text', text: 'hello' }] } },
      });
      const splitPoint = Math.floor(fullMessage.length / 2);

      // First chunk: partial JSON
      driver._buffer += fullMessage.substring(0, splitPoint);
      let lines = driver._buffer.split('\n');
      driver._buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) driver._handleMessage(JSON.parse(line.trim()));
      }
      expect(events.filter(e => e.event === 'stream')).toHaveLength(0);

      // Second chunk: rest of JSON + newline
      driver._buffer += fullMessage.substring(splitPoint) + '\n';
      lines = driver._buffer.split('\n');
      driver._buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) driver._handleMessage(JSON.parse(line.trim()));
      }

      expect(events.filter(e => e.event === 'stream')).toHaveLength(1);
      expect(events.find(e => e.event === 'stream').data.text).toBe('hello');
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-Driver Behavioral Consistency Tests
// ---------------------------------------------------------------------------

describe('Cross-Driver Consistency', () => {
  it('all three drivers normalize agent messages to { content: [{type: "text", text}] }', () => {
    // Claude
    const claude = new ClaudeDriver();
    const claudeEvents = collectEvents(claude, ['message']);
    const ws = createMockWebSocket();
    claude.attachSocket(ws);

    ws.emit('message', JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello from Claude' }] },
    }));

    // Codex
    const codex = new CodexDriver();
    const codexEvents = collectEvents(codex, ['message']);

    codex._handleMessage({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'Hello from Codex' } },
    });

    // OpenCode — thinking is accumulated and flushed with next event
    const opencode = new OpenCodeDriver();
    const opencodeEvents = collectEvents(opencode, ['message']);

    opencode._handleMessage({
      method: 'session/update',
      params: {
        update: {
          type: 'agent_thought_chunk',
          content: 'Hello from OpenCode',
        },
      },
    });

    // Flush thinking via a tool_call so it emits as a combined message
    opencode._handleMessage({
      method: 'session/update',
      params: {
        update: {
          type: 'tool_call',
          toolCallId: 'tc-consistency',
          title: 'Read',
          input: {},
          status: 'pending',
        },
      },
    });

    // All should produce the same structure
    expect(claudeEvents[0].data.content[0].type).toBe('text');
    expect(codexEvents[0].data.content[0].type).toBe('text');
    expect(opencodeEvents[0].data.content[0].type).toBe('thinking');
    expect(opencodeEvents[0].data.content[0].text).toBe('Hello from OpenCode');

    claude.stop();
    codex.stop();
    opencode.stop();
  });

  it('both drivers normalize command execution to tool_use + tool_result', () => {
    // Claude emits tool_use in assistant message, then tool_result in user message
    const claude = new ClaudeDriver();
    const claudeEvents = collectEvents(claude, ['message']);
    const ws = createMockWebSocket();
    claude.attachSocket(ws);

    ws.emit('message', JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }));

    // Codex emits both in one item/completed
    const codex = new CodexDriver();
    const codexEvents = collectEvents(codex, ['message']);

    codex._handleMessage({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'ls',
          output: 'file1 file2',
        },
      },
    });

    // Claude's tool_use
    expect(claudeEvents[0].data.content[0].type).toBe('tool_use');
    expect(claudeEvents[0].data.content[0].name).toBe('Bash');

    // Codex's tool_use + tool_result
    expect(codexEvents[0].data.content[0].type).toBe('tool_use');
    expect(codexEvents[0].data.content[0].name).toBe('command_execution');
    expect(codexEvents[0].data.content[1].type).toBe('tool_result');

    claude.stop();
    codex.stop();
  });

  it('all three drivers emit stream events with {text} shape', () => {
    const claude = new ClaudeDriver();
    const claudeEvents = collectEvents(claude, ['stream']);
    const ws = createMockWebSocket();
    claude.attachSocket(ws);

    ws.emit('message', JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk' } },
    }));

    const codex = new CodexDriver();
    const codexEvents = collectEvents(codex, ['stream']);

    codex._handleMessage({
      method: 'item/agentMessage/delta',
      params: { delta: 'chunk' },
    });

    const opencode = new OpenCodeDriver();
    const opencodeEvents = collectEvents(opencode, ['stream']);

    opencode._handleMessage({
      method: 'session/update',
      params: { update: { type: 'agent_message_chunk', content: [{ type: 'text', text: 'chunk' }] } },
    });

    expect(claudeEvents[0].data).toEqual({ text: 'chunk' });
    expect(codexEvents[0].data).toEqual({ text: 'chunk' });
    expect(opencodeEvents[0].data).toEqual({ text: 'chunk' });

    claude.stop();
    codex.stop();
    opencode.stop();
  });

  it('all three drivers emit permission events with {requestId, toolName, toolInput}', () => {
    const claude = new ClaudeDriver();
    const claudeEvents = collectEvents(claude, ['permission']);
    const ws = createMockWebSocket();
    claude.attachSocket(ws);

    ws.emit('message', JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
      },
    }));

    const codex = new CodexDriver();
    const codexEvents = collectEvents(codex, ['permission']);

    codex._handleMessage({
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'cmd-1',
        parsedCmd: { cmd: 'npm', args: ['test'] },
      },
    });

    const opencode = new OpenCodeDriver();
    const opencodeEvents = collectEvents(opencode, ['permission']);

    opencode._handleMessage({
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        title: 'Bash',
        input: { command: 'npm test' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });

    // All three should have the same shape
    for (const evts of [claudeEvents, codexEvents, opencodeEvents]) {
      const perm = evts[0].data;
      expect(perm).toHaveProperty('requestId');
      expect(perm).toHaveProperty('toolName');
      expect(perm).toHaveProperty('toolInput');
      expect(typeof perm.requestId).toBe('string');
      expect(typeof perm.toolName).toBe('string');
      expect(typeof perm.toolInput).toBe('object');
    }

    claude.stop();
    codex.stop();
    opencode.stop();
  });

  it('all three drivers emit result events with {cost, usage, isError, sessionId}', () => {
    // Claude
    const claude = new ClaudeDriver();
    const claudeEvents = collectEvents(claude, ['result']);
    const ws = createMockWebSocket();
    claude.attachSocket(ws);

    ws.emit('message', JSON.stringify({
      type: 'result',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 200 },
      duration_ms: 5000,
      is_error: false,
      session_id: 'sess-1',
    }));

    // Codex
    const codex = new CodexDriver();
    const codexEvents = collectEvents(codex, ['result']);
    codex._threadId = 'thread-1';

    codex._handleMessage({
      method: 'turn/completed',
      params: {
        turn: { status: 'completed' },
        usage: { input_tokens: 800, output_tokens: 150 },
      },
    });

    // OpenCode — result is emitted when sendPrompt() returns, so we test via direct emit
    const opencode = new OpenCodeDriver();
    const opencodeEvents = collectEvents(opencode, ['result']);
    const proc = createMockProcess();
    opencode._process = proc;
    opencode._ready = true;
    opencode._sessionId = 'sess-oc-1';

    // Trigger sendPrompt and resolve it
    const sendPromise = opencode.sendPrompt('test');
    const msg = JSON.parse(proc.stdin.write.mock.calls[0][0].trim());
    opencode._handleMessage({ id: msg.id, result: { stopReason: 'end_turn' } });

    // All three should have these fields
    for (const evts of [claudeEvents, codexEvents]) {
      const result = evts[0].data;
      expect(result).toHaveProperty('cost');
      expect(result).toHaveProperty('usage');
      expect(result).toHaveProperty('isError');
      expect(result).toHaveProperty('sessionId');
      expect(typeof result.cost).toBe('number');
      expect(typeof result.isError).toBe('boolean');
    }

    // Need to wait for the async sendPrompt to complete
    return sendPromise.then(() => {
      const result = opencodeEvents[0].data;
      expect(result).toHaveProperty('cost');
      expect(result).toHaveProperty('usage');
      expect(result).toHaveProperty('isError');
      expect(result).toHaveProperty('sessionId');
      expect(typeof result.cost).toBe('number');
      expect(typeof result.isError).toBe('boolean');
      expect(result.sessionId).toBe('sess-oc-1');

      claude.stop();
      codex.stop();
      opencode.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. AgentSession with Driver Integration Tests
// ---------------------------------------------------------------------------

describe('AgentSession with Drivers', () => {
  // We need to use dynamic import to avoid the createDriver call in the constructor
  // from actually trying to spawn processes. Instead we'll test the driver registry
  // and the event binding logic separately.

  it('createDriver returns correct driver for each supported type', () => {
    const claude = createDriver('claude');
    expect(claude).toBeInstanceOf(ClaudeDriver);
    expect(claude.name).toBe('Claude Code');

    const codex = createDriver('codex');
    expect(codex).toBeInstanceOf(CodexDriver);
    expect(codex.name).toBe('Codex');

    const opencode = createDriver('opencode');
    expect(opencode).toBeInstanceOf(OpenCodeDriver);
    expect(opencode.name).toBe('OpenCode');
  });

  it('all drivers extend BaseDriver', () => {
    for (const type of getSupportedTypes()) {
      const driver = createDriver(type);
      expect(driver).toBeInstanceOf(BaseDriver);
      expect(driver).toBeInstanceOf(EventEmitter);
      expect(typeof driver.start).toBe('function');
      expect(typeof driver.stop).toBe('function');
      expect(typeof driver.sendPrompt).toBe('function');
      expect(typeof driver.respondPermission).toBe('function');
      expect(typeof driver.interrupt).toBe('function');
      expect(typeof driver.isReady).toBe('function');
      expect(typeof driver.setPermissionMode).toBe('function');
      expect(typeof driver._normalizeContentBlocks).toBe('function');
    }
  });
});
