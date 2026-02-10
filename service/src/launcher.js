#!/usr/bin/env node

import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Bridge } from './bridge.js';
import { hasDevices, logAudit } from './auth.js';

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
  console.log(`  Token:  ${pairingInfo.pairingToken.slice(0, 8)}... (expires in 5 min)`);
  console.log('');
  console.log('  Scan this QR code with the Mobile Agent app to pair.');
  console.log('  The pairing token can only be used once.');
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('');
}

function showReady(tunnelUrl) {
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('  Mobile Agent - Ready');
  console.log('\u2550'.repeat(60));
  console.log('');
  console.log(`  Tunnel: ${tunnelUrl}`);
  console.log('  Paired devices will auto-connect via signed challenge.');
  console.log('  Run with --pair to pair a new device.');
  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('');
}

async function main() {
  const forcePairing = process.argv.includes('--pair');

  const bridge = new Bridge(PORT);
  await bridge.start();

  try {
    const tunnelUrl = await startTunnel();
    logAudit('server_started', { port: PORT, tunnel: tunnelUrl });

    // If no devices are paired or --pair flag is used, enter pairing mode
    if (!hasDevices() || forcePairing) {
      const pairingInfo = bridge.getPairingInfo(tunnelUrl);
      showPairingQR(pairingInfo);
    } else {
      showReady(tunnelUrl);
    }
  } catch (e) {
    console.error('Tunnel failed:', e.message);
    console.log('Server is running on localhost only (no remote access).');
    logAudit('tunnel_failed', { error: e.message });

    if (!hasDevices() || forcePairing) {
      const pairingInfo = bridge.getPairingInfo(`ws://127.0.0.1:${PORT}`);
      console.log('\nPairing info (local only):');
      console.log(JSON.stringify(pairingInfo, null, 2));
    }
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
