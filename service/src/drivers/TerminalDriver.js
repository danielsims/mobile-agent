// TerminalDriver — interactive shell session driver.
//
// Security notes:
// - CWD is provided by bridge project/worktree resolution.
// - Service-local auth/pairing secrets are stripped from child env.
// - Input size is capped to prevent abuse.
// - Output strips OSC control sequences and NUL bytes.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { BaseDriver } from './BaseDriver.js';

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

const OSC_ESCAPE_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

let ptyLoadAttempted = false;
let cachedPtySpawn = null;

export function sanitizeOutput(raw) {
  if (!raw) return '';
  let text = typeof raw === 'string' ? raw : String(raw);
  if (Buffer.byteLength(text, 'utf-8') > MAX_OUTPUT_CHUNK_BYTES) {
    const buf = Buffer.from(text, 'utf-8');
    text = buf.subarray(buf.length - MAX_OUTPUT_CHUNK_BYTES).toString('utf-8');
  }
  return text
    .replace(OSC_ESCAPE_RE, '')
    .replace(/\u0000/g, '');
}

export function resolveShell() {
  if (process.platform === 'win32') {
    const comspec = process.env.COMSPEC || 'powershell.exe';
    return { shell: comspec, args: [] };
  }

  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/') && existsSync(candidate)) {
      return { shell: candidate, args: ['-i'] };
    }
  }

  return { shell: candidates[0] || 'sh', args: ['-i'] };
}

export function buildChildEnv(cwd) {
  const env = { ...process.env };

  // Never leak bridge auth-related values to interactive shells.
  const blockedKeys = [
    'AUTH_TOKEN',
    'DESKTOP_TOKEN',
    'MOBILE_AGENT_DESKTOP_TOKEN',
    'MOBILE_AGENT_AUTH_TOKEN',
    'CLOUDFLARED_TOKEN',
    // Strip Claude Code session markers so nested claude invocations work
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
  ];
  for (const key of blockedKeys) {
    delete env[key];
  }

  env.PWD = cwd;
  env.MOBILE_AGENT_TERMINAL = '1';
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

async function loadPtySpawn() {
  if (ptyLoadAttempted) return cachedPtySpawn;
  ptyLoadAttempted = true;

  try {
    const mod = await import('node-pty');
    cachedPtySpawn = mod?.spawn || mod?.default?.spawn || null;
    if (cachedPtySpawn) {
      console.log('[TerminalDriver] node-pty loaded');
    }
  } catch {
    cachedPtySpawn = null;
    console.warn('[TerminalDriver] node-pty not available');
  }

  return cachedPtySpawn;
}

// Allow tests to reset the cached spawn function
export function _resetPtyCache() {
  ptyLoadAttempted = false;
  cachedPtySpawn = null;
}

export class TerminalDriver extends BaseDriver {
  constructor() {
    super('Interactive Terminal', 'pty');
    this._agentId = null;
    this._sessionId = null;
    this._cwd = null;
    this._shell = null;
    this._cols = 120;
    this._rows = 40;

    this._pty = null;
    this._mode = 'none'; // 'pty' | 'none'
  }

  async start(agentId, opts = {}) {
    const tag = `[Terminal ${agentId.slice(0, 8)}]`;
    try {
      const { cwd = process.env.HOME, resumeSessionId = null } = opts;
      this._agentId = agentId;
      this._cwd = cwd || process.env.HOME;
      this._sessionId = resumeSessionId || uuidv4();

      let gitBranch = null;
      try {
        gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: this._cwd,
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
      } catch {
        // Not a git repo.
      }

      const { shell, args } = resolveShell();
      this._shell = shell;
      const env = buildChildEnv(this._cwd);

      const ptySpawn = await loadPtySpawn();
      if (!ptySpawn) {
        this._ready = false;
        this.emit('stream', {
          text: '\r\n[mobile-agent] Interactive terminal unavailable: node-pty is not installed in service.\r\nRun: cd service && npm i node-pty\r\n',
        });
        this.emit('error', {
          message: 'Interactive terminal requires node-pty in the service environment.',
        });
        this.emit('status', { status: 'error' });
        return;
      }

      try {
        this._startPty(ptySpawn, shell, args, env);
      } catch (err) {
        console.error(`${tag} PTY spawn failed:`, err.message);
        this._ready = false;
        this.emit('error', { message: `Failed to start terminal: ${err.message}` });
        this.emit('status', { status: 'error' });
        return;
      }

      this._ready = true;
      this.emit('init', {
        sessionId: this._sessionId,
        model: null,
        tools: [],
        cwd: this._cwd,
        projectName: basename(this._cwd),
        gitBranch,
      });
      this.emit('status', { status: 'idle' });
      console.log(`${tag} Started: ${shell} (pid=${this._pty?.pid}) in ${basename(this._cwd)}`);
    } catch (err) {
      console.error(`${tag} Unexpected error in start():`, err);
      this._ready = false;
      this.emit('error', { message: `Terminal start failed: ${err?.message || err}` });
      this.emit('status', { status: 'error' });
    }
  }

  _startPty(ptySpawn, shell, args, env) {
    this._mode = 'pty';

    this._pty = ptySpawn(shell, args, {
      name: 'xterm-256color',
      cols: this._cols,
      rows: this._rows,
      cwd: this._cwd,
      env,
    });

    this._pty.onData((chunk) => {
      const text = sanitizeOutput(chunk);
      if (text) this.emit('stream', { text });
    });

    this._pty.onExit(({ exitCode, signal }) => {
      this._ready = false;
      this.emit('status', { status: 'exited' });
      this.emit('exit', { code: exitCode, signal });
    });
  }

  async sendPrompt(text) {
    if (!this._ready) {
      this.emit('error', { message: 'Terminal is not ready.' });
      return;
    }

    let payload = typeof text === 'string' ? text : String(text ?? '');
    payload = payload.replace(/\u0000/g, '');

    if (Buffer.byteLength(payload, 'utf-8') > MAX_INPUT_BYTES) {
      this.emit('error', { message: `Input too large (max ${MAX_INPUT_BYTES} bytes).` });
      return;
    }

    if (!payload.endsWith('\n')) {
      payload += '\n';
    }

    this.write(payload);

    // Keep composer enabled in the mobile UI for command entry.
    this.emit('status', { status: 'idle' });
  }

  write(data) {
    if (!this._ready) {
      this.emit('error', { message: 'Terminal is not ready.' });
      return;
    }

    let payload = typeof data === 'string' ? data : String(data ?? '');
    payload = payload.replace(/\u0000/g, '');

    if (!payload) return;

    if (Buffer.byteLength(payload, 'utf-8') > MAX_INPUT_BYTES) {
      this.emit('error', { message: `Input too large (max ${MAX_INPUT_BYTES} bytes).` });
      return;
    }

    if (this._mode === 'pty' && this._pty) {
      this._pty.write(payload);
      return;
    }

    this.emit('error', { message: 'Terminal transport unavailable.' });
  }

  async respondPermission() {
    // Terminal sessions do not use permission RPCs.
    return;
  }

  async interrupt() {
    if (!this._ready) return;

    if (this._mode === 'pty' && this._pty) {
      this._pty.write('\u0003'); // Ctrl-C
    }
    this.emit('status', { status: 'idle' });
  }

  async setPermissionMode() {
    // No-op for terminal sessions.
  }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 20 || rows < 5) return;
    this._cols = cols;
    this._rows = rows;
    if (this._mode === 'pty' && this._pty?.resize) {
      this._pty.resize(cols, rows);
    }
  }

  async stop() {
    this._ready = false;

    if (this._mode === 'pty' && this._pty) {
      try { this._pty.kill(); } catch {}
      this._pty = null;
    }

    this._mode = 'none';
  }
}
