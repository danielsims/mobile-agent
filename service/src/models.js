import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // type -> { ts, models }

function findBinary(envVar, localName) {
  const paths = [
    process.env[envVar],
    `${process.env.HOME}/.local/bin/${localName}`,
    `/usr/local/bin/${localName}`,
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return localName;
}

function capitalizeToken(token) {
  if (!token) return token;
  const lower = token.toLowerCase();
  if (lower === 'gpt') return 'GPT';
  if (lower === 'claude') return 'Claude';
  if (/^\d+(\.\d+)?$/.test(token)) return token;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatModelLabel(type, value) {
  if (!value || value === 'auto') return 'Auto (Recommended)';

  if (type === 'claude') {
    const m = value.match(/^claude-([a-z0-9]+)-(\d+)-(\d+)(?:-\d{8})?$/i);
    if (m) {
      const family = capitalizeToken(m[1]);
      return `Claude ${family} ${m[2]}.${m[3]}`;
    }
  }

  const parts = value.split('-').filter(Boolean);
  if (parts.length >= 2 && parts[0].toLowerCase() === 'gpt' && /^\d/.test(parts[1])) {
    const tail = parts.slice(2).map(capitalizeToken).join(' ');
    return `GPT-${parts[1]}${tail ? ` ${tail}` : ''}`;
  }
  return parts.map(capitalizeToken).join(' ') || value;
}

function scanClaudeModelsFromSessions(limit = 50) {
  const root = join(process.env.HOME || '', '.claude', 'projects');
  if (!existsSync(root)) return [];

  const files = [];
  try {
    for (const projectDir of readdirSync(root)) {
      const projectPath = join(root, projectDir);
      let children = [];
      try {
        children = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const name of children) {
        if (!name.endsWith('.jsonl')) continue;
        const full = join(projectPath, name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          continue;
        }
        files.push({ full, mtime });
      }
    }
  } catch {
    return [];
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const recent = files.slice(0, limit);
  const seen = new Map(); // model -> mtime

  for (const f of recent) {
    let text = '';
    try {
      text = readFileSync(f.full, 'utf-8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    // Scan backwards to bias toward currently-active model IDs.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const model = entry?.message?.model;
      if (typeof model !== 'string' || !model) continue;
      if (!seen.has(model)) seen.set(model, f.mtime);
      if (seen.size >= 20) break;
    }
    if (seen.size >= 20) break;
  }

  const models = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value)
    .filter(value => typeof value === 'string' && value.length > 0 && !value.startsWith('<') && !value.includes('synthetic'))
    .map(value => ({
      value,
      label: formatModelLabel('claude', value),
    }));

  return models;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function listCodexModels() {
  const codexPath = findBinary('CODEX_PATH', 'codex');

  return withTimeout(new Promise((resolve, reject) => {
    const proc = spawn(codexPath, ['app-server'], {
      cwd: process.env.HOME,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 1000);
    };

    let buf = '';
    let rpcId = 0;
    const pending = new Map();

    proc.stdout.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: done, reject: fail } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) fail(new Error(msg.error.message || JSON.stringify(msg.error)));
          else done(msg.result);
        }
      }
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });

    const request = (method, params = {}) => new Promise((done, fail) => {
      const id = ++rpcId;
      pending.set(id, { resolve: done, reject: fail });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    const notify = (method, params = {}) => {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };

    (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'mobile-agent', version: '1.0.0' },
        });
        notify('initialized', {});
        const modelResult = await request('model/list', {});
        const collections = [
          modelResult,
          modelResult?.data,
          modelResult?.models,
          modelResult?.items,
          modelResult?.data?.models,
          modelResult?.data?.items,
        ];
        const raw = collections.flatMap((c) => (Array.isArray(c) ? c : []));
        const mapped = raw
          .map((m) => ({
            value: m?.model || m?.id || m?.name || m?.slug,
            label: m?.model || m?.id || m?.name || m?.slug,
          }))
          .filter((m) => typeof m.value === 'string' && m.value.length > 0);
        cleanup();
        resolve(mapped);
      } catch (err) {
        cleanup();
        reject(err);
      }
    })();
  }), 10_000, 'codex model discovery');
}

async function listOpenCodeModels() {
  const opencodePath = findBinary('OPENCODE_PATH', 'opencode');

  return withTimeout(new Promise((resolve, reject) => {
    const proc = spawn(opencodePath, ['acp'], {
      cwd: process.env.HOME,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 1000);
    };

    let buf = '';
    let rpcId = 0;
    const pending = new Map();

    proc.stdout.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: done, reject: fail } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) fail(new Error(msg.error.message || JSON.stringify(msg.error)));
          else done(msg.result);
        }
      }
    });

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });

    const request = (method, params = {}) => new Promise((done, fail) => {
      const id = ++rpcId;
      pending.set(id, { resolve: done, reject: fail });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    (async () => {
      try {
        const initResult = await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'mobile-agent', version: '1.0.0' },
        });

        // ACP doesn't have a model/list method. Check if the init response
        // or agent capabilities expose available models.
        const models = [];
        const agentInfo = initResult?.agentInfo || {};

        // If the agent reports its current model, include it.
        if (agentInfo.model) {
          models.push({ value: agentInfo.model, label: agentInfo.model });
        }

        cleanup();
        resolve(models);
      } catch (err) {
        cleanup();
        reject(err);
      }
    })();
  }), 10_000, 'opencode model discovery');
}

export async function listModelsForAgentType(type) {
  const cached = cache.get(type);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.models;
  }

  let options = [];

  try {
    if (type === 'codex') {
      const codex = await listCodexModels();
      const seen = new Set();
      for (const m of codex) {
        if (seen.has(m.value)) continue;
        seen.add(m.value);
        options.push({
          value: m.value,
          label: formatModelLabel('codex', m.value),
        });
      }
    } else if (type === 'opencode') {
      const opencode = await listOpenCodeModels();
      const seen = new Set();
      for (const m of opencode) {
        if (seen.has(m.value)) continue;
        seen.add(m.value);
        options.push({
          value: m.value,
          label: formatModelLabel('opencode', m.value),
        });
      }
    } else if (type === 'claude') {
      const discovered = scanClaudeModelsFromSessions();
      const seen = new Set();

      // Include explicit env override when set.
      const envModel = process.env.CLAUDE_MODEL?.trim();
      if (envModel && !seen.has(envModel)) {
        seen.add(envModel);
        options.push({
          value: envModel,
          label: formatModelLabel('claude', envModel),
        });
      }
      for (const m of discovered) {
        if (seen.has(m.value)) continue;
        seen.add(m.value);
        options.push({
          value: m.value,
          label: formatModelLabel('claude', m.value),
        });
      }
    }
  } catch (err) {
    console.error(`[models] Failed to list models for ${type}:`, err.message);
  }

  cache.set(type, { ts: Date.now(), models: options });
  return options;
}
