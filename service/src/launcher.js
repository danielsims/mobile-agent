#!/usr/bin/env node

import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Bridge } from './bridge.js';
import { hasDevices, logAudit, PAIRING_TOKEN_TTL_MS } from './auth.js';
import { loadProjects, registerProject, unregisterProject, getProjects } from './projects.js';

// --- CLI Subcommands (handled before starting the server) ---

const subcommand = process.argv[2];

if (subcommand === 'register') {
  const targetPath = process.argv[3];
  if (!targetPath) {
    console.error('Usage: mobile-agent register <path-to-repo> [name]');
    process.exit(1);
  }
  loadProjects();
  try {
    const result = registerProject(targetPath, process.argv[4]);
    console.log(`Registered project: ${result.name} (${result.path}) [${result.id}]`);
  } catch (e) {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (subcommand === 'unregister') {
  const projectId = process.argv[3];
  if (!projectId) {
    console.error('Usage: mobile-agent unregister <project-id>');
    process.exit(1);
  }
  loadProjects();
  const removed = unregisterProject(projectId);
  console.log(removed ? 'Project unregistered.' : 'Project not found.');
  process.exit(0);
}

if (subcommand === 'projects') {
  loadProjects();
  const all = getProjects();
  const entries = Object.entries(all);
  if (entries.length === 0) {
    console.log('No registered projects.');
  } else {
    console.log('Registered projects:');
    for (const [id, p] of entries) {
      console.log(`  ${id}  ${p.name}  ${p.path}`);
    }
  }
  process.exit(0);
}

// --- Server ---

const PORT = parseInt(process.env.PORT, 10) || 3001;

async function startTunnel() {
  return new Promise((resolve, reject) => {
    console.log('Starting Cloudflare tunnel...');
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
    setTimeout(() => { if (!found) reject(new Error('Tunnel timeout (30s)')); }, 30000);
  });
}

function showPairingQR(pairingInfo) {
  const data = JSON.stringify(pairingInfo);
  const ttlMin = Math.round(PAIRING_TOKEN_TTL_MS / 60_000);
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('  Mobile Agent - Pairing Mode');
  console.log('\u2550'.repeat(60));
  console.log('');
  qrcode.generate(data, { small: true }, (code) => {
    console.log(code.split('\n').map(l => '  ' + l).join('\n'));
  });
  console.log('');
  console.log(`  Tunnel: ${pairingInfo.url}`);
  console.log(`  Token:  ${pairingInfo.pairingToken.slice(0, 8)}... (expires in ${ttlMin} min)`);
  console.log('');
  console.log('  Scan this QR code with the Mobile Agent app to pair.');
  console.log('  Press [q] to refresh the QR code.');
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('');
}

async function main() {
  const bridge = new Bridge(PORT);
  await bridge.start();

  let tunnelUrl = null;
  try {
    tunnelUrl = await startTunnel();
    logAudit('server_started', { port: PORT, tunnel: tunnelUrl });
  } catch (e) {
    console.error('Tunnel failed:', e.message);
    console.log('Server is running on localhost only (no remote access).');
    logAudit('tunnel_failed', { error: e.message });
    tunnelUrl = `ws://127.0.0.1:${PORT}`;
  }

  function refreshQR() {
    const pairingInfo = bridge.getPairingInfo(tunnelUrl);
    showPairingQR(pairingInfo);
  }

  refreshQR();

  if (hasDevices()) {
    console.log('  Previously paired devices detected.');
    console.log('  They will need to re-pair if the tunnel URL changed.');
    console.log('');
  }

  // Press 'q' to show a fresh QR code (new pairing token)
  console.log('  Press [q] to generate a fresh QR code.');
  console.log('');

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      // Ctrl-C
      if (key[0] === 3) {
        shutdown();
        return;
      }
      // 'q' or 'Q' — regenerate QR with fresh pairing token
      if (key[0] === 113 || key[0] === 81) {
        refreshQR();
      }
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    logAudit('server_shutdown', {});
    bridge.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
