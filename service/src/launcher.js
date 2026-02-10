#!/usr/bin/env node

import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Bridge } from './bridge.js';
import { hasDevices, logAudit, PAIRING_TOKEN_TTL_MS } from './auth.js';

const PORT = parseInt(process.env.PORT, 10) || 3001;

// Auto-refresh buffer: regenerate QR 10 seconds before token expires
const AUTO_REFRESH_MS = PAIRING_TOKEN_TTL_MS - 10_000;

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
  console.log('  QR auto-refreshes when the token expires.');
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('');
}

async function main() {
  const bridge = new Bridge(PORT);
  await bridge.start();

  let tunnelUrl = null;
  let autoRefreshTimer = null;

  try {
    tunnelUrl = await startTunnel();
    logAudit('server_started', { port: PORT, tunnel: tunnelUrl });
  } catch (e) {
    console.error('Tunnel failed:', e.message);
    console.log('Server is running on localhost only (no remote access).');
    logAudit('tunnel_failed', { error: e.message });
    tunnelUrl = `ws://127.0.0.1:${PORT}`;
  }

  // Show QR and start auto-refresh cycle
  function refreshQR() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    const pairingInfo = bridge.getPairingInfo(tunnelUrl);
    showPairingQR(pairingInfo);

    // Auto-refresh before the token expires
    autoRefreshTimer = setTimeout(() => {
      console.log('  Pairing token expired — generating fresh QR code...');
      refreshQR();
    }, AUTO_REFRESH_MS);
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
      // 'q' or 'Q' — regenerate QR (also resets auto-refresh timer)
      if (key[0] === 113 || key[0] === 81) {
        refreshQR();
      }
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
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
