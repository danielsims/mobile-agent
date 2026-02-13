// Tests for AgentSession — the transport-agnostic agent lifecycle manager.
//
// These tests verify that AgentSession correctly:
//   1. Delegates to drivers for protocol-specific work
//   2. Maintains message history, permissions, and cost tracking
//   3. Broadcasts events to mobile clients
//   4. Handles all driver event types consistently

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// We test AgentSession by creating it with 'claude' type, then directly
// emitting events on the driver to verify the session layer handles them
// correctly. This avoids needing to mock the module.
import { AgentSession } from '../AgentSession.js';

describe('AgentSession', () => {
  let session;
  let broadcasts;

  beforeEach(() => {
    session = new AgentSession('agent-123', 'claude');
    broadcasts = [];
    session.setOnBroadcast((id, type, data) => {
      broadcasts.push({ id, type, data });
    });
  });

  describe('Constructor', () => {
    it('initializes with correct defaults', () => {
      expect(session.id).toBe('agent-123');
      expect(session.type).toBe('claude');
      expect(session.status).toBe('starting');
      expect(session.sessionId).toBeNull();
      expect(session.model).toBeNull();
      expect(session.totalCost).toBe(0);
      expect(session.outputTokens).toBe(0);
      expect(session.messageHistory).toEqual([]);
      expect(session.pendingPermissions.size).toBe(0);
    });

    it('creates a driver instance', () => {
      expect(session.driver).toBeTruthy();
      expect(session.driver.name).toBe('Claude Code');
    });

    it('creates codex driver for codex type', () => {
      const codexSession = new AgentSession('agent-456', 'codex');
      expect(codexSession.driver.name).toBe('Codex');
    });

    it('accepts an initial model override', () => {
      const modelSession = new AgentSession('agent-999', 'claude', { model: 'sonnet' });
      expect(modelSession.model).toBe('sonnet');
    });
  });

  describe('spawn()', () => {
    it('passes selected model to driver.start', () => {
      const modelSession = new AgentSession('agent-999', 'claude', { model: 'opus' });
      const startSpy = vi.spyOn(modelSession.driver, 'start').mockResolvedValue(undefined);

      modelSession.spawn(3000, null, null);

      expect(startSpy).toHaveBeenCalledWith('agent-999', expect.objectContaining({
        serverPort: 3000,
        resumeSessionId: null,
        cwd: null,
        model: 'opus',
      }));
    });
  });

  describe('Driver event: init', () => {
    it('updates session state from init event', () => {
      session.driver.emit('init', {
        sessionId: 'sess-456',
        model: 'claude-sonnet-4-5-20250929',
        tools: ['Read', 'Write'],
        cwd: '/project',
        projectName: 'project',
        gitBranch: 'main',
      });

      expect(session.sessionId).toBe('sess-456');
      expect(session.model).toBe('claude-sonnet-4-5-20250929');
      expect(session.tools).toEqual(['Read', 'Write']);
      expect(session.cwd).toBe('/project');
      expect(session.gitBranch).toBe('main');
    });

    it('broadcasts agentUpdated with session info', () => {
      session.driver.emit('init', {
        sessionId: 'sess-456',
        model: 'claude-sonnet-4-5-20250929',
        tools: ['Read'],
      });

      const update = broadcasts.find(b => b.type === 'agentUpdated' && b.data.sessionId);
      expect(update).toBeTruthy();
      expect(update.data.sessionId).toBe('sess-456');
      expect(update.data.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('marks session as initialized', () => {
      expect(session._initialized).toBe(false);
      session.driver.emit('init', { sessionId: 'sess-1' });
      expect(session._initialized).toBe(true);
    });

    it('moves session to idle after init when starting', () => {
      expect(session.status).toBe('starting');
      session.driver.emit('init', { sessionId: 'sess-1' });
      expect(session.status).toBe('idle');
    });

    it('does not mark init as running', () => {
      session.driver.emit('init', { sessionId: 'sess-1' });
      const runningUpdate = broadcasts.find(
        b => b.type === 'agentUpdated' && b.data.status === 'running',
      );
      expect(runningUpdate).toBeFalsy();
    });
  });

  describe('Driver event: stream', () => {
    it('broadcasts streamChunk and updates lastOutput', () => {
      session.driver.emit('stream', { text: 'Hello ' });
      session.driver.emit('stream', { text: 'world!' });

      const chunks = broadcasts.filter(b => b.type === 'streamChunk');
      expect(chunks).toHaveLength(2);
      expect(chunks[0].data.text).toBe('Hello ');
      expect(chunks[1].data.text).toBe('world!');

      expect(session.lastOutput).toContain('Hello world!');
    });

    it('truncates lastOutput at MAX_LAST_OUTPUT', () => {
      const longText = 'x'.repeat(3000);
      session.driver.emit('stream', { text: longText });
      expect(session.lastOutput.length).toBeLessThanOrEqual(2000);
    });

    it('ignores empty stream text', () => {
      session.driver.emit('stream', { text: '' });
      expect(broadcasts.filter(b => b.type === 'streamChunk')).toHaveLength(0);
    });
  });

  describe('Driver event: message', () => {
    it('adds assistant message to history', () => {
      session.driver.emit('message', {
        content: [{ type: 'text', text: 'I will help you.' }],
      });

      expect(session.messageHistory).toHaveLength(1);
      expect(session.messageHistory[0].type).toBe('assistant');
      expect(session.messageHistory[0].content[0].text).toBe('I will help you.');
    });

    it('broadcasts assistantMessage', () => {
      session.driver.emit('message', {
        content: [{ type: 'text', text: 'response' }],
      });

      const msg = broadcasts.find(b => b.type === 'assistantMessage');
      expect(msg).toBeTruthy();
      expect(msg.data.agentId).toBe('agent-123');
    });

    it('resets stream content accumulator', () => {
      session._currentStreamContent = 'accumulated text';
      session.driver.emit('message', {
        content: [{ type: 'text', text: 'final' }],
      });
      expect(session._currentStreamContent).toBe('');
    });

    it('trims history at MAX_HISTORY', () => {
      for (let i = 0; i < 250; i++) {
        session.driver.emit('message', {
          content: [{ type: 'text', text: `message ${i}` }],
        });
      }
      expect(session.messageHistory.length).toBeLessThanOrEqual(200);
    });
  });

  describe('Driver event: result', () => {
    it('updates cost tracking', () => {
      session.driver.emit('result', {
        cost: 0.05,
        totalCost: 0.05,
        usage: { input_tokens: 5000, output_tokens: 1200 },
        duration: 8000,
        isError: false,
        sessionId: 'sess-1',
      });

      expect(session.totalCost).toBe(0.05);
      expect(session.outputTokens).toBe(1200);
      expect(session.contextUsedPercent).toBeGreaterThan(0);
    });

    it('broadcasts agentResult', () => {
      session.driver.emit('result', {
        cost: 0.03,
        totalCost: 0.03,
        usage: { input_tokens: 2000, output_tokens: 500 },
        duration: 3000,
        isError: false,
      });

      const result = broadcasts.find(b => b.type === 'agentResult');
      expect(result).toBeTruthy();
      expect(result.data.totalCost).toBe(0.03);
      expect(result.data.outputTokens).toBe(500);
    });

    it('sets sessionId from result if not already set', () => {
      expect(session.sessionId).toBeNull();
      session.driver.emit('result', {
        cost: 0, usage: {}, duration: 0, isError: false,
        sessionId: 'from-result',
      });
      expect(session.sessionId).toBe('from-result');
    });

    it('accumulates outputTokens across multiple results', () => {
      session.driver.emit('result', {
        cost: 0.01, totalCost: 0.01,
        usage: { output_tokens: 100 },
        duration: 1000, isError: false,
      });
      session.driver.emit('result', {
        cost: 0.02, totalCost: 0.02,
        usage: { output_tokens: 200 },
        duration: 2000, isError: false,
      });

      expect(session.outputTokens).toBe(300);
    });

    it('calculates context usage percent', () => {
      session.driver.emit('result', {
        cost: 0.01, totalCost: 0.01,
        usage: { input_tokens: 100000, output_tokens: 100 },
        duration: 1000, isError: false,
      });
      // 100000/200000 = 50%
      expect(session.contextUsedPercent).toBe(50);
    });

    it('includes cache tokens in context calculation', () => {
      session.driver.emit('result', {
        cost: 0.01, totalCost: 0.01,
        usage: { input_tokens: 50000, cache_read_input_tokens: 50000, output_tokens: 100 },
        duration: 1000, isError: false,
      });
      // (50000 + 50000)/200000 = 50%
      expect(session.contextUsedPercent).toBe(50);
    });
  });

  describe('Driver event: permission', () => {
    it('stores pending permission and broadcasts', () => {
      session.driver.emit('permission', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });

      expect(session.pendingPermissions.size).toBe(1);
      const pending = session.pendingPermissions.get('req-1');
      expect(pending.toolName).toBe('Bash');
      expect(pending.toolInput.command).toBe('npm test');

      const permBroadcast = broadcasts.find(b => b.type === 'permissionRequest');
      expect(permBroadcast).toBeTruthy();
      expect(permBroadcast.data.requestId).toBe('req-1');
    });

    it('sets status to awaiting_permission', () => {
      session.driver.emit('permission', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: {},
      });

      expect(session.status).toBe('awaiting_permission');
    });

    it('handles multiple simultaneous permissions', () => {
      session.driver.emit('permission', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {},
      });
      session.driver.emit('permission', {
        requestId: 'req-2', toolName: 'Write', toolInput: {},
      });

      expect(session.pendingPermissions.size).toBe(2);
    });

    it('auto-approves permissions when autoApprove is enabled', () => {
      session.autoApprove = true;
      const respondSpy = vi.spyOn(session.driver, 'respondPermission');

      session.driver.emit('permission', {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });

      expect(respondSpy).toHaveBeenCalledWith('req-1', 'allow', { command: 'npm test' });
      expect(session.pendingPermissions.size).toBe(0);
      const permBroadcast = broadcasts.find(b => b.type === 'permissionRequest');
      expect(permBroadcast).toBeFalsy();
      expect(session.status).toBe('running');
    });
  });

  describe('Driver event: toolResults', () => {
    it('merges tool results into preceding assistant message', () => {
      session.driver.emit('message', {
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/file.txt' } },
        ],
      });

      session.driver.emit('toolResults', {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' },
        ],
      });

      const lastMsg = session.messageHistory[session.messageHistory.length - 1];
      expect(lastMsg.content).toHaveLength(3);
      expect(lastMsg.content[2].type).toBe('tool_result');
      expect(lastMsg.content[2].toolUseId).toBe('tu-1');
      expect(lastMsg.content[2].content).toBe('file contents here');
    });

    it('handles array tool result content', () => {
      session.driver.emit('message', {
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
      });

      session.driver.emit('toolResults', {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }],
        }],
      });

      const lastMsg = session.messageHistory[0];
      expect(lastMsg.content[1].content).toBe('line 1\nline 2');
    });

    it('broadcasts toolResults so mobile app can mark tools as completed', () => {
      session.driver.emit('message', {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/file.txt' } },
        ],
      });

      session.driver.emit('toolResults', {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'done' },
        ],
      });

      const toolResultsBroadcast = broadcasts.find(b => b.type === 'toolResults');
      expect(toolResultsBroadcast).toBeTruthy();
      expect(toolResultsBroadcast.data.agentId).toBe('agent-123');
      expect(toolResultsBroadcast.data.results).toHaveLength(1);
      expect(toolResultsBroadcast.data.results[0].toolUseId).toBe('tu-1');
    });

    it('does not broadcast when no tool_result blocks are present', () => {
      session.driver.emit('message', {
        content: [{ type: 'text', text: 'hi' }],
      });

      session.driver.emit('toolResults', {
        content: [{ type: 'text', text: 'not a tool result' }],
      });

      const toolResultsBroadcast = broadcasts.find(b => b.type === 'toolResults');
      expect(toolResultsBroadcast).toBeFalsy();
    });
  });

  describe('Driver event: status', () => {
    it('updates session status', () => {
      session.driver.emit('status', { status: 'running' });
      expect(session.status).toBe('running');

      session.driver.emit('status', { status: 'idle' });
      expect(session.status).toBe('idle');
    });

    it('normalizes connected to idle when initialized', () => {
      session._initialized = true;
      session.driver.emit('status', { status: 'connected' });
      expect(session.status).toBe('idle');
    });

    it('keeps connected when not initialized', () => {
      session._initialized = false;
      session.driver.emit('status', { status: 'connected' });
      expect(session.status).toBe('connected');
    });

    it('broadcasts status changes', () => {
      session.driver.emit('status', { status: 'running' });
      const update = broadcasts.find(b => b.type === 'agentUpdated' && b.data.status === 'running');
      expect(update).toBeTruthy();
    });
  });

  describe('Driver event: error', () => {
    it('sets status to error', () => {
      session.driver.emit('error', { message: 'Connection lost' });
      expect(session.status).toBe('error');
    });
  });

  describe('Driver event: exit', () => {
    it('sets status to exited', () => {
      session.driver.emit('exit', { code: 0, signal: null });
      expect(session.status).toBe('exited');
    });
  });

  describe('Driver event: toolProgress', () => {
    it('broadcasts toolProgress', () => {
      session.driver.emit('toolProgress', {
        toolName: 'Bash',
        elapsed: 5000,
      });

      const progress = broadcasts.find(b => b.type === 'toolProgress');
      expect(progress).toBeTruthy();
      expect(progress.data.toolName).toBe('Bash');
      expect(progress.data.elapsed).toBe(5000);
    });
  });

  describe('sendPrompt()', () => {
    it('adds user message to history', () => {
      session.sendPrompt('Hello');
      expect(session.messageHistory).toHaveLength(1);
      expect(session.messageHistory[0].type).toBe('user');
      expect(session.messageHistory[0].content).toBe('Hello');
    });

    it('sets session name from first prompt', () => {
      session.sendPrompt('Fix the authentication bug in login.ts');
      expect(session.sessionName).toBe('Fix the authentication bug in login.ts');
    });

    it('truncates long session names', () => {
      session.sendPrompt('x'.repeat(100));
      expect(session.sessionName.length).toBeLessThanOrEqual(63);
    });

    it('sets status to running', () => {
      session.sendPrompt('Hello');
      expect(session.status).toBe('running');
    });

    it('broadcasts sessionName update', () => {
      session.sendPrompt('My task');
      const update = broadcasts.find(b => b.type === 'agentUpdated' && b.data.sessionName);
      expect(update).toBeTruthy();
      expect(update.data.sessionName).toBe('My task');
    });

    it('does not overwrite session name on second prompt', () => {
      session.sendPrompt('First message');
      session.sendPrompt('Second message');
      expect(session.sessionName).toBe('First message');
    });

    it('passes image data to driver and stores image metadata in history', () => {
      const sendSpy = vi.spyOn(session.driver, 'sendPrompt').mockResolvedValue(undefined);
      const imageData = {
        uri: 'file:///tmp/photo.jpg',
        base64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      };

      session.sendPrompt('Describe this image', null, imageData);

      expect(sendSpy).toHaveBeenCalledWith('Describe this image', null, imageData);
      expect(session.messageHistory[0].imageData).toEqual({
        uri: 'file:///tmp/photo.jpg',
        mimeType: 'image/jpeg',
      });
    });
  });

  describe('respondToPermission()', () => {
    it('removes pending permission after response', () => {
      session.pendingPermissions.set('req-1', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {}, timestamp: Date.now(),
      });

      const result = session.respondToPermission('req-1', 'allow');
      expect(result).toBe(true);
      expect(session.pendingPermissions.size).toBe(0);
    });

    it('returns false for unknown requestId', () => {
      const result = session.respondToPermission('nonexistent', 'allow');
      expect(result).toBe(false);
    });

    it('sets status back to running when last permission resolved', () => {
      session.status = 'awaiting_permission';
      session.pendingPermissions.set('req-1', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {}, timestamp: Date.now(),
      });

      session.respondToPermission('req-1', 'allow');
      expect(session.status).toBe('running');
    });
  });

  describe('interrupt()', () => {
    it('interrupts running session and sets status to idle', async () => {
      session.status = 'running';
      const spy = vi.spyOn(session.driver, 'interrupt').mockResolvedValue(undefined);

      const ok = await session.interrupt();

      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
      expect(session.status).toBe('idle');
    });

    it('returns false when session is not running', async () => {
      session.status = 'idle';
      const spy = vi.spyOn(session.driver, 'interrupt').mockResolvedValue(undefined);

      const ok = await session.interrupt();

      expect(ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('loadTranscript()', () => {
    it('loads model, messages, and lastOutput', () => {
      session.loadTranscript({
        model: 'claude-opus-4-6',
        messages: [
          { id: 't-0', type: 'user', content: 'hello', timestamp: 1000 },
          { id: 't-1', type: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2000 },
        ],
        lastOutput: 'hi there',
      });

      expect(session.model).toBe('claude-opus-4-6');
      expect(session.messageHistory).toHaveLength(2);
      expect(session.lastOutput).toBe('hi there');
      expect(session._initialized).toBe(true);
    });
  });

  describe('getSnapshot()', () => {
    it('returns complete snapshot', () => {
      session.model = 'claude-sonnet-4-5-20250929';
      session.totalCost = 0.05;
      session.outputTokens = 1200;
      session.sessionName = 'My Session';

      const snapshot = session.getSnapshot();

      expect(snapshot.id).toBe('agent-123');
      expect(snapshot.type).toBe('claude');
      expect(snapshot.model).toBe('claude-sonnet-4-5-20250929');
      expect(snapshot.totalCost).toBe(0.05);
      expect(snapshot.sessionName).toBe('My Session');
      expect(Array.isArray(snapshot.pendingPermissions)).toBe(true);
    });

    it('converts pendingPermissions Map to array', () => {
      session.pendingPermissions.set('req-1', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {}, timestamp: 1000,
      });

      const snapshot = session.getSnapshot();
      expect(snapshot.pendingPermissions).toHaveLength(1);
      expect(snapshot.pendingPermissions[0].requestId).toBe('req-1');
    });

    it('defaults sessionName to New Agent', () => {
      const snapshot = session.getSnapshot();
      expect(snapshot.sessionName).toBe('New Agent');
    });
  });

  describe('getHistory()', () => {
    it('returns messages and pending permissions', () => {
      session.sendPrompt('hello');
      session.pendingPermissions.set('req-1', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {}, timestamp: 1000,
      });

      const history = session.getHistory();
      expect(history.messages).toHaveLength(1);
      expect(history.pendingPermissions).toHaveLength(1);
    });
  });

  describe('destroy()', () => {
    it('clears permissions and sets status to exited', () => {
      session.pendingPermissions.set('req-1', {
        requestId: 'req-1', toolName: 'Bash', toolInput: {}, timestamp: 1000,
      });

      session.destroy();

      expect(session.status).toBe('exited');
      expect(session.pendingPermissions.size).toBe(0);
    });
  });

  describe('attachCliSocket()', () => {
    it('delegates to driver.attachSocket when supported (Claude)', () => {
      // ClaudeDriver has attachSocket
      const mockWs = new EventEmitter();
      mockWs.readyState = 1;
      mockWs.send = vi.fn();
      mockWs.close = vi.fn();

      // Should not throw since ClaudeDriver has attachSocket
      session.attachCliSocket(mockWs);
      // The driver should now be ready
      expect(session.driver.isReady()).toBe(true);
    });

    it('closes socket for non-websocket drivers', () => {
      const codexSession = new AgentSession('agent-789', 'codex');
      const mockWs = { close: vi.fn() };

      codexSession.attachCliSocket(mockWs);
      expect(mockWs.close).toHaveBeenCalledWith(4005, expect.any(String));
    });
  });
});
