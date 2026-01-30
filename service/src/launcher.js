#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = uuidv4();

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
console.log(`Claude: ${CLAUDE_PATH}`);

const CLAUDE_PROJECTS_DIR = join(process.env.HOME, '.claude', 'projects');

// Load all sessions from Claude's storage
function loadSessions() {
  const sessions = [];

  try {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      return sessions;
    }

    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const projectDir of projectDirs) {
      const indexPath = join(CLAUDE_PROJECTS_DIR, projectDir, 'sessions-index.json');

      if (existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));

          for (const entry of indexData.entries || []) {
            sessions.push({
              id: entry.sessionId,
              name: entry.firstPrompt?.slice(0, 60) || 'Untitled',
              projectPath: entry.projectPath,
              messageCount: entry.messageCount,
              modified: entry.modified,
              created: entry.created,
            });
          }
        } catch (e) {
          // Skip invalid index files
        }
      }
    }

    // Sort by modified date, newest first
    sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  } catch (e) {
    console.error('Error loading sessions:', e.message);
  }

  return sessions;
}

// State
const clients = new Set();
let outputBuffer = [];
let sessionId = null;
let sessionName = 'New Chat';
let lastContent = '';
let isProcessing = false;
let skipPermissionBroadcast = false;

// Permission mode: 'auto' (skip all) or 'confirm' (ask user)
let permissionMode = process.env.PERMISSION_MODE || 'confirm';

// Track pending permission details
let pendingPermission = null;  // { toolName, toolInput, description }
let lastPermissionToolId = null;  // Prevent duplicate broadcasts for same tool

function broadcast(type, data = {}) {
  const msg = JSON.stringify({ type, ...data, ts: Date.now() });
  clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

function terminalOutput(text) {
  process.stdout.write(text);
}

function mobileOutput(text) {
  outputBuffer.push(text);
  broadcast('output', { data: text });
}

function output(text) {
  terminalOutput(text);
  mobileOutput(text);
}

// Store the last tool use for permission handling
let lastToolUse = null;

function handleClaudeMessage(msg) {
  switch (msg.type) {
    case 'system':
      if (msg.session_id) {
        sessionId = msg.session_id;
        terminalOutput(`[Session: ${sessionId.slice(0, 8)}...]\n`);
        broadcast('session', { sessionId, name: sessionName });
      }
      break;

    case 'assistant':
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            const delta = block.text.slice(lastContent.length);
            lastContent = block.text;
            if (delta) output(delta);
          } else if (block.type === 'tool_use') {
            lastContent = '';
            // Store tool use for potential permission handling
            lastToolUse = {
              id: block.id,
              name: block.name,
              input: block.input,
            };
            terminalOutput(`\n[Tool: ${block.name}]\n`);
            broadcast('tool', {
              name: block.name,
              input: block.input ? JSON.stringify(block.input, null, 2) : null,
            });
            if (block.input) {
              const inputStr = JSON.stringify(block.input, null, 2);
              terminalOutput(inputStr.slice(0, 500) + '\n');
            }
          }
        }
      }
      break;

    case 'user':
      lastContent = '';
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : '';

            const needsPermission = content.includes('requested permission') ||
                                    content.includes("haven't granted") ||
                                    content.includes('User did not grant permission');

            // Use tool_use_id to prevent duplicate broadcasts for the same tool
            const toolId = block.tool_use_id || lastToolUse?.id;
            const isDuplicate = toolId && toolId === lastPermissionToolId;

            if (!skipPermissionBroadcast && needsPermission && !isDuplicate) {
              // Permission needed - store details for retry
              lastPermissionToolId = toolId;
              pendingPermission = {
                toolName: lastToolUse?.name || 'Unknown',
                toolInput: lastToolUse?.input || {},
                description: content,
              };
              broadcast('permission', {
                id: toolId,
                toolName: pendingPermission.toolName,
                description: content,
              });
              terminalOutput(`\n[Permission Required for ${pendingPermission.toolName}]\n`);
            } else if (!needsPermission) {
              const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
              broadcast('toolResult', { content: truncated });
            }
          }
        }
      }
      break;

    case 'result':
      lastContent = '';
      if (msg.session_id) sessionId = msg.session_id;
      break;
  }
}

function runClaude(prompt, options = {}) {
  const { skipPermissions = false } = options;

  return new Promise((resolve) => {
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];

    // In auto mode, always skip permissions
    // In confirm mode, only skip if explicitly requested (after user approval)
    if (permissionMode === 'auto' || skipPermissions) {
      args.push('--dangerously-skip-permissions');
      skipPermissionBroadcast = true;
    }

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    args.push(prompt);

    console.log('Running Claude:', args.join(' ').slice(0, 200) + (args.join(' ').length > 200 ? '...' : ''));

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: process.env.HOME,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          handleClaudeMessage(msg);
        } catch (e) {}
      }
    });

    proc.stderr.on('data', (data) => {
      // Log stderr for debugging
      const text = data.toString().trim();
      if (text) console.log('Claude stderr:', text);
    });

    proc.on('close', (code) => {
      console.log('Claude exited:', code);
      skipPermissionBroadcast = false;
      isProcessing = false;
      output('\n');
      broadcast('done', { code });
      resolve(code);
    });
  });
}

async function sendUserMessage(text, options = {}) {
  const { skipPermissions = false, isPermissionRetry = false } = options;

  if (isProcessing) {
    console.log('Already processing, ignoring message');
    return;
  }

  isProcessing = true;

  // Reset permission state for new messages (not retries)
  if (!isPermissionRetry) {
    pendingPermission = null;
    lastPermissionToolId = null;
    lastToolUse = null;
  }

  terminalOutput(`\n> ${text}\n\n`);

  if (!isPermissionRetry) {
    broadcast('userMessage', { content: text });
  }

  if (!sessionName || sessionName === 'New Chat') {
    sessionName = text.slice(0, 50) + (text.length > 50 ? '...' : '');
  }

  await runClaude(text, { skipPermissions });
}

async function handlePermissionResponse(action) {
  isProcessing = false;

  if (action === 'yes' || action === 'always') {
    if (pendingPermission) {
      console.log('Permission granted for:', pendingPermission.toolName);

      // Build an explicit follow-up that tells Claude exactly what to execute
      let followUpPrompt;
      const toolName = pendingPermission.toolName;
      const toolInput = pendingPermission.toolInput || {};

      if (toolName === 'Write') {
        const filePath = toolInput.file_path || 'the file';
        const content = toolInput.content || '';
        // Be very explicit about what to write
        followUpPrompt = `Permission granted. Please write the file now. Use the Write tool with file_path="${filePath}" and the same content you intended to write.`;
      } else if (toolName === 'Edit') {
        const filePath = toolInput.file_path || 'the file';
        followUpPrompt = `Permission granted. Please edit ${filePath} now using the Edit tool with the same changes you intended.`;
      } else if (toolName === 'Bash') {
        const command = toolInput.command || 'the command';
        followUpPrompt = `Permission granted. Please run the Bash command now: ${command}`;
      } else {
        followUpPrompt = `Permission granted. Please proceed with ${toolName} using the same parameters you intended.`;
      }

      pendingPermission = null;
      // Keep lastPermissionToolId set to prevent re-broadcast during retry

      // Resume session with explicit instruction
      await sendUserMessage(followUpPrompt, { skipPermissions: true, isPermissionRetry: true });
    } else {
      console.log('No pending permission to approve');
      broadcast('done', { code: 0 });
    }
  } else {
    output('[Permission denied]\n');
    pendingPermission = null;
    lastPermissionToolId = null;
    broadcast('done', { code: 0 });
  }
}

// HTTP server
const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessionId }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (token !== AUTH_TOKEN) {
    ws.close(4001, 'Invalid token');
    return;
  }

  console.log('Client connected');
  clients.add(ws);

  ws.send(JSON.stringify({
    type: 'connected',
    sessionId,
    sessionName,
    permissionMode,
    ts: Date.now()
  }));

  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({
      type: 'buffer',
      data: outputBuffer.slice(-100).join(''),
      ts: Date.now()
    }));
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'input':
          if (msg.text) {
            await sendUserMessage(msg.text);
          }
          break;

        case 'permission':
          console.log(`Permission response: ${msg.action}`);
          await handlePermissionResponse(msg.action);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;

        case 'reset':
          sessionId = null;
          sessionName = 'New Chat';
          outputBuffer = [];
          lastContent = '';
          pendingPermission = null;
          lastPermissionToolId = null;
          lastToolUse = null;
          broadcast('reset', {});
          terminalOutput('[Session reset]\n');
          break;

        case 'setPermissionMode':
          if (msg.mode === 'auto' || msg.mode === 'confirm') {
            permissionMode = msg.mode;
            broadcast('permissionMode', { mode: permissionMode });
            terminalOutput(`[Permission mode: ${permissionMode}]\n`);
          }
          break;

        case 'getPermissionMode':
          ws.send(JSON.stringify({ type: 'permissionMode', mode: permissionMode, ts: Date.now() }));
          break;

        case 'getSessions':
          console.log('Loading sessions...');
          const sessions = loadSessions();
          console.log(`Found ${sessions.length} sessions`);
          ws.send(JSON.stringify({ type: 'sessions', sessions, ts: Date.now() }));
          break;

        case 'resumeSession':
          if (msg.sessionId) {
            console.log(`Resuming session: ${msg.sessionId}`);
            sessionId = msg.sessionId;
            sessionName = msg.name || 'Resumed Chat';
            outputBuffer = [];
            lastContent = '';
            pendingPermission = null;
            lastPermissionToolId = null;
            lastToolUse = null;
            broadcast('session', { sessionId, name: sessionName });
            terminalOutput(`[Resumed session: ${sessionId.slice(0, 8)}...]\n`);
          }
          break;
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

// Tunnel
async function startTunnel() {
  return new Promise((resolve, reject) => {
    console.log('Starting tunnel...');
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let found = false;
    const handler = (data) => {
      const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !found) {
        found = true;
        resolve(match[0]);
      }
    };

    tunnel.stdout.on('data', handler);
    tunnel.stderr.on('data', handler);
    tunnel.on('error', (e) => reject(e));
    setTimeout(() => { if (!found) reject(new Error('Tunnel timeout')); }, 30000);
  });
}

function showQR(url) {
  const data = JSON.stringify({ url, token: AUTH_TOKEN });
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Claude Mobile - Ready');
  console.log('═'.repeat(60));
  console.log('');
  qrcode.generate(data, { small: true }, (code) => {
    console.log(code.split('\n').map(l => '  ' + l).join('\n'));
  });
  console.log('');
  console.log(`  URL:   ${url}`);
  console.log(`  Token: ${AUTH_TOKEN}`);
  console.log('');
  console.log('═'.repeat(60));
  console.log('');
}

async function main() {
  httpServer.listen(PORT, async () => {
    console.log(`Server on port ${PORT}`);
    try {
      const url = await startTunnel();
      showQR(url);
    } catch (e) {
      console.error('Tunnel failed:', e.message);
    }
  });
}

process.on('SIGINT', () => {
  console.log('\nBye!');
  wss.close();
  httpServer.close();
  process.exit(0);
});

main();
