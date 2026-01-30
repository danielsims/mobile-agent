import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from 'http';

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || uuidv4(); // Generate random token if not set

// Store active sessions
const sessions = new Map();
const clients = new Set();

// Output buffer for replay
let outputBuffer = [];
const MAX_BUFFER = 2000;

// Current PTY session
let currentPty = null;
let currentSessionId = null;

function broadcast(message) {
  const payload = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  });
}

function bufferOutput(data) {
  outputBuffer.push({
    data,
    timestamp: Date.now()
  });
  if (outputBuffer.length > MAX_BUFFER) {
    outputBuffer = outputBuffer.slice(-MAX_BUFFER);
  }
}

function spawnClaude(cwd = process.cwd()) {
  if (currentPty) {
    console.log('Claude session already running');
    return currentSessionId;
  }

  currentSessionId = uuidv4();
  outputBuffer = [];

  currentPty = spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: process.env
  });

  sessions.set(currentSessionId, {
    id: currentSessionId,
    startedAt: Date.now(),
    cwd
  });

  currentPty.onData((data) => {
    bufferOutput(data);
    broadcast({
      type: 'output',
      sessionId: currentSessionId,
      data,
      timestamp: Date.now()
    });
  });

  currentPty.onExit(({ exitCode }) => {
    console.log(`Claude exited with code ${exitCode}`);
    broadcast({
      type: 'session_ended',
      sessionId: currentSessionId,
      exitCode,
      timestamp: Date.now()
    });
    currentPty = null;
    sessions.delete(currentSessionId);
    currentSessionId = null;
  });

  console.log(`Started Claude session: ${currentSessionId}`);
  broadcast({
    type: 'session_started',
    sessionId: currentSessionId,
    timestamp: Date.now()
  });

  return currentSessionId;
}

function sendInput(data) {
  if (currentPty) {
    currentPty.write(data);
    return true;
  }
  return false;
}

// HTTP server for health checks
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasActiveSession: !!currentPty }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Check auth token from query string
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (token !== AUTH_TOKEN) {
    console.log('Client rejected: invalid token');
    ws.close(4001, 'Invalid authentication token');
    return;
  }

  console.log('Client connected');
  clients.add(ws);

  // Send current state
  ws.send(JSON.stringify({
    type: 'connected',
    hasActiveSession: !!currentPty,
    sessionId: currentSessionId,
    timestamp: Date.now()
  }));

  // Send buffered output if there's an active session
  if (currentPty && outputBuffer.length > 0) {
    ws.send(JSON.stringify({
      type: 'buffer_replay',
      sessionId: currentSessionId,
      buffer: outputBuffer,
      timestamp: Date.now()
    }));
  }

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());

      switch (parsed.type) {
        case 'input':
          if (sendInput(parsed.data)) {
            // Echo back that input was sent
            broadcast({
              type: 'input_sent',
              data: parsed.data,
              timestamp: Date.now()
            });
          }
          break;

        case 'spawn':
          const sessionId = spawnClaude(parsed.cwd || process.cwd());
          ws.send(JSON.stringify({
            type: 'spawn_result',
            sessionId,
            success: !!sessionId,
            timestamp: Date.now()
          }));
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          console.log('Unknown message type:', parsed.type);
      }
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});

httpServer.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Mobile Agent Service');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Server running on port ${PORT}`);
  console.log('');
  console.log('  Auth Token (keep this secret!):');
  console.log(`  ${AUTH_TOKEN}`);
  console.log('');
  console.log('  WebSocket URL:');
  console.log(`  ws://localhost:${PORT}?token=${AUTH_TOKEN}`);
  console.log('');
  console.log('  For remote access, use Cloudflare Tunnel:');
  console.log(`  cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (currentPty) {
    currentPty.kill();
  }
  wss.close();
  httpServer.close();
  process.exit(0);
});
