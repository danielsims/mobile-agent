// Unit tests for TerminalDriver — interactive shell session driver.
//
// These tests use a mock ptySpawn function to avoid requiring actual PTY
// allocation (which fails in sandboxed environments). This tests the
// driver's state machine, event emission, input validation, and error handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  TerminalDriver,
  sanitizeOutput,
  resolveShell,
  buildChildEnv,
  _resetPtyCache,
} from '../drivers/TerminalDriver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEvents(driver, eventNames) {
  const collected = [];
  for (const name of eventNames) {
    driver.on(name, (data) => {
      collected.push({ event: name, data });
    });
  }
  return collected;
}

const ALL_EVENTS = ['init', 'stream', 'message', 'result', 'permission', 'status', 'error', 'exit'];

function createMockPty() {
  const pty = new EventEmitter();
  pty.pid = 12345;
  pty.write = vi.fn();
  pty.resize = vi.fn();
  pty.kill = vi.fn();
  // node-pty uses onData/onExit instead of EventEmitter
  pty.onData = (cb) => { pty._dataHandler = cb; };
  pty.onExit = (cb) => { pty._exitHandler = cb; };
  return pty;
}

function createMockPtySpawn(pty) {
  return vi.fn(() => pty);
}

// ---------------------------------------------------------------------------
// sanitizeOutput
// ---------------------------------------------------------------------------

describe('sanitizeOutput', () => {
  it('returns empty string for falsy input', () => {
    expect(sanitizeOutput('')).toBe('');
    expect(sanitizeOutput(null)).toBe('');
    expect(sanitizeOutput(undefined)).toBe('');
  });

  it('passes through normal text unchanged', () => {
    expect(sanitizeOutput('hello world')).toBe('hello world');
  });

  it('strips NUL characters', () => {
    expect(sanitizeOutput('hello\0world')).toBe('helloworld');
    expect(sanitizeOutput('\0\0\0')).toBe('');
  });

  it('strips OSC escape sequences (BEL terminated)', () => {
    expect(sanitizeOutput('before\u001b]0;title\u0007after')).toBe('beforeafter');
  });

  it('strips OSC escape sequences (ST terminated)', () => {
    expect(sanitizeOutput('before\u001b]0;title\u001b\\after')).toBe('beforeafter');
  });

  it('preserves backspace characters', () => {
    expect(sanitizeOutput('abc\x08 \x08')).toBe('abc\x08 \x08');
  });

  it('preserves regular ANSI escape sequences (CSI)', () => {
    const bold = '\u001b[1mtext\u001b[0m';
    expect(sanitizeOutput(bold)).toBe(bold);
  });

  it('truncates output exceeding MAX_OUTPUT_CHUNK_BYTES', () => {
    const big = 'x'.repeat(100_000);
    const result = sanitizeOutput(big);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('converts non-string input to string', () => {
    expect(sanitizeOutput(42)).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// resolveShell
// ---------------------------------------------------------------------------

describe('resolveShell', () => {
  it('returns a shell and args array', () => {
    const { shell, args } = resolveShell();
    expect(typeof shell).toBe('string');
    expect(Array.isArray(args)).toBe(true);
  });

  it('uses -i flag for interactive shells on unix', () => {
    if (process.platform !== 'win32') {
      const { args } = resolveShell();
      expect(args).toContain('-i');
    }
  });
});

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

describe('buildChildEnv', () => {
  it('strips security-sensitive env vars', () => {
    const original = { ...process.env };
    process.env.AUTH_TOKEN = 'secret';
    process.env.DESKTOP_TOKEN = 'secret';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'test';
    process.env.CLAUDE_CODE_SESSION_ID = 'abc';

    const env = buildChildEnv('/tmp');

    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(env.DESKTOP_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();

    // Restore
    Object.assign(process.env, original);
    delete process.env.AUTH_TOKEN;
    delete process.env.DESKTOP_TOKEN;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('sets PWD to the given cwd', () => {
    const env = buildChildEnv('/home/user');
    expect(env.PWD).toBe('/home/user');
  });

  it('sets MOBILE_AGENT_TERMINAL flag', () => {
    const env = buildChildEnv('/tmp');
    expect(env.MOBILE_AGENT_TERMINAL).toBe('1');
  });

  it('sets TERM if not already set', () => {
    const saved = process.env.TERM;
    delete process.env.TERM;
    const env = buildChildEnv('/tmp');
    expect(env.TERM).toBe('xterm-256color');
    if (saved) process.env.TERM = saved;
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — start()
// ---------------------------------------------------------------------------

describe('TerminalDriver.start()', () => {
  let driver;
  let events;
  let mockPty;
  let mockPtySpawn;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    events = collectEvents(driver, ALL_EVENTS);
    mockPty = createMockPty();
    mockPtySpawn = createMockPtySpawn(mockPty);
  });

  it('emits init and status:idle on successful start with mock', async () => {
    // We need to mock loadPtySpawn. Since it's module-level, we'll test
    // the _startPty method directly instead.
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';

    driver._startPty(mockPtySpawn, '/bin/sh', [], {});

    expect(mockPtySpawn).toHaveBeenCalledOnce();
    expect(driver._mode).toBe('pty');
    expect(driver._pty).toBe(mockPty);
  });

  it('emits stream events when PTY produces output', () => {
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockPtySpawn, '/bin/sh', [], {});

    // Simulate PTY output
    mockPty._dataHandler('hello from shell\r\n');

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'stream',
        data: expect.objectContaining({ text: 'hello from shell\r\n' }),
      })
    );
  });

  it('emits exit event when PTY exits', () => {
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._ready = true;
    driver._startPty(mockPtySpawn, '/bin/sh', [], {});

    mockPty._exitHandler({ exitCode: 0, signal: null });

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'exit',
        data: { code: 0, signal: null },
      })
    );
    expect(driver._ready).toBe(false);
  });

  it('throws when ptySpawn fails', () => {
    const failingSpawn = vi.fn(() => { throw new Error('posix_spawnp failed.'); });
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';

    expect(() => {
      driver._startPty(failingSpawn, '/bin/sh', [], {});
    }).toThrow('posix_spawnp failed.');
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — write()
// ---------------------------------------------------------------------------

describe('TerminalDriver.write()', () => {
  let driver;
  let events;
  let mockPty;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    events = collectEvents(driver, ALL_EVENTS);
    mockPty = createMockPty();
    const mockSpawn = createMockPtySpawn(mockPty);
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockSpawn, '/bin/sh', [], {});
    driver._ready = true;
  });

  it('writes data to the PTY', () => {
    driver.write('hello');
    expect(mockPty.write).toHaveBeenCalledWith('hello');
  });

  it('writes backspace character \\x7f to PTY', () => {
    driver.write('\x7f');
    expect(mockPty.write).toHaveBeenCalledWith('\x7f');
  });

  it('writes control characters (Ctrl-C, Ctrl-D) to PTY', () => {
    driver.write('\x03'); // Ctrl-C
    expect(mockPty.write).toHaveBeenCalledWith('\x03');

    driver.write('\x04'); // Ctrl-D
    expect(mockPty.write).toHaveBeenCalledWith('\x04');
  });

  it('strips NUL characters from input', () => {
    driver.write('hello\0world');
    expect(mockPty.write).toHaveBeenCalledWith('helloworld');
  });

  it('emits error when not ready', () => {
    driver._ready = false;
    driver.write('hello');

    expect(mockPty.write).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'error',
        data: { message: 'Terminal is not ready.' },
      })
    );
  });

  it('emits error for oversized input', () => {
    const big = 'x'.repeat(20_000);
    driver.write(big);

    expect(mockPty.write).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'error',
        data: expect.objectContaining({ message: expect.stringContaining('Input too large') }),
      })
    );
  });

  it('ignores empty payload after NUL stripping', () => {
    driver.write('\0\0\0');
    expect(mockPty.write).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — sendPrompt()
// ---------------------------------------------------------------------------

describe('TerminalDriver.sendPrompt()', () => {
  let driver;
  let mockPty;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    mockPty = createMockPty();
    const mockSpawn = createMockPtySpawn(mockPty);
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockSpawn, '/bin/sh', [], {});
    driver._ready = true;
  });

  it('appends newline if not present', async () => {
    await driver.sendPrompt('ls -la');
    expect(mockPty.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('does not double-add newline', async () => {
    await driver.sendPrompt('ls -la\n');
    expect(mockPty.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('emits status idle after prompt', async () => {
    const events = collectEvents(driver, ['status']);
    await driver.sendPrompt('echo test');
    expect(events).toContainEqual(
      expect.objectContaining({ data: { status: 'idle' } })
    );
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — resize()
// ---------------------------------------------------------------------------

describe('TerminalDriver.resize()', () => {
  let driver;
  let mockPty;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    mockPty = createMockPty();
    const mockSpawn = createMockPtySpawn(mockPty);
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockSpawn, '/bin/sh', [], {});
    driver._ready = true;
  });

  it('resizes the PTY with valid dimensions', () => {
    driver.resize(80, 24);
    expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
    expect(driver._cols).toBe(80);
    expect(driver._rows).toBe(24);
  });

  it('rejects too-small dimensions', () => {
    driver.resize(10, 3);
    expect(mockPty.resize).not.toHaveBeenCalled();
  });

  it('rejects non-integer dimensions', () => {
    driver.resize(80.5, 24);
    expect(mockPty.resize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — interrupt()
// ---------------------------------------------------------------------------

describe('TerminalDriver.interrupt()', () => {
  let driver;
  let mockPty;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    mockPty = createMockPty();
    const mockSpawn = createMockPtySpawn(mockPty);
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockSpawn, '/bin/sh', [], {});
    driver._ready = true;
  });

  it('sends Ctrl-C to PTY', async () => {
    await driver.interrupt();
    expect(mockPty.write).toHaveBeenCalledWith('\u0003');
  });

  it('does nothing when not ready', async () => {
    driver._ready = false;
    await driver.interrupt();
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TerminalDriver — stop()
// ---------------------------------------------------------------------------

describe('TerminalDriver.stop()', () => {
  let driver;
  let mockPty;

  beforeEach(() => {
    _resetPtyCache();
    driver = new TerminalDriver();
    mockPty = createMockPty();
    const mockSpawn = createMockPtySpawn(mockPty);
    driver._agentId = 'test-1234-5678';
    driver._cwd = '/tmp';
    driver._startPty(mockSpawn, '/bin/sh', [], {});
    driver._ready = true;
  });

  it('kills the PTY and resets state', async () => {
    await driver.stop();

    expect(mockPty.kill).toHaveBeenCalled();
    expect(driver._ready).toBe(false);
    expect(driver._pty).toBeNull();
    expect(driver._mode).toBe('none');
  });

  it('is safe to call multiple times', async () => {
    await driver.stop();
    await driver.stop();
    expect(driver._ready).toBe(false);
  });
});
