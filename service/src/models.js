import { spawn, execFileSync } from 'node:child_process';
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

function makeAutoOption(type) {
  if (type === 'codex') {
    return {
      value: 'auto',
      label: 'Auto (Recommended)',
      note: 'Use account-compatible Codex default model',
    };
  }
  return {
    value: 'auto',
    label: 'Auto (Recommended)',
    note: 'Use provider default model',
  };
}

function parseClaudeAliasesFromHelp() {
  const claudePath = findBinary('CLAUDE_PATH', 'claude');
  try {
    const help = execFileSync(claudePath, ['--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const line = help.split('\n').find(l => l.includes('--model <model>')) || '';
    const aliasRegex = /'([a-z0-9-]+)'/g;
    const out = [];
    let match;
    while ((match = aliasRegex.exec(line)) !== null) {
      const value = match[1];
      // Skip full IDs; only keep short aliases from the docs line.
      if (value.startsWith('claude-')) continue;
      out.push(value);
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

function formatClaudeModelLabel(model) {
  const m = model.match(/^claude-([a-z0-9_]+)-(\d+)-(\d+)/);
  if (!m) return model;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `Claude ${family} ${m[2]}.${m[3]}`;
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
      label: formatClaudeModelLabel(value),
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
        const raw = Array.isArray(modelResult?.data)
          ? modelResult.data
          : (Array.isArray(modelResult) ? modelResult : []);
        const mapped = raw
          .map((m) => ({
            value: m?.model || m?.id,
            label: m?.displayName || m?.model || m?.id,
            note: typeof m?.description === 'string' ? m.description : undefined,
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

export async function listModelsForAgentType(type) {
  const cached = cache.get(type);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.models;
  }

  let options = [makeAutoOption(type)];

  try {
    if (type === 'codex') {
      const codex = await listCodexModels();
      const seen = new Set(options.map(m => m.value));
      for (const m of codex) {
        if (seen.has(m.value)) continue;
        seen.add(m.value);
        options.push(m);
      }
    } else if (type === 'claude') {
      const discovered = scanClaudeModelsFromSessions();
      const seen = new Set(options.map(m => m.value));
      // Surface environment override first if present.
      const envModel = process.env.CLAUDE_MODEL?.trim();
      if (envModel && !seen.has(envModel)) {
        seen.add(envModel);
        options.push({
          value: envModel,
          label: formatClaudeModelLabel(envModel),
          note: 'Configured via CLAUDE_MODEL',
        });
      }
      for (const m of discovered) {
        if (seen.has(m.value)) continue;
        seen.add(m.value);
        options.push(m);
      }

      // Use aliases advertised by the installed CLI help text.
      // This keeps options fresh across CLI updates without hardcoding names.
      for (const alias of parseClaudeAliasesFromHelp()) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        options.push({
          value: alias,
          label: alias.charAt(0).toUpperCase() + alias.slice(1),
          note: 'CLI model alias',
        });
      }
    }
  } catch (err) {
    console.error(`[models] Failed to list models for ${type}:`, err.message);
  }

  cache.set(type, { ts: Date.now(), models: options });
  return options;
}
