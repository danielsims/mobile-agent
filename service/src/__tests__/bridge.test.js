import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { Bridge } from '../bridge.js';
import { generatePairingToken } from '../auth.js';

const TEST_PORT = 3090;
let bridge;

function createTestDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const deviceId = 'test-' + randomBytes(4).toString('hex');

  function signPayload(obj) {
    const json = JSON.stringify(obj);
    const sig = sign(null, Buffer.from(json, 'utf-8'), privateKey).toString('hex');
    return { payload: json, signature: sig };
  }

  return { publicKeyHex: publicKeyRaw.toString('hex'), deviceId, signPayload };
}

function connectWs(path = '/ws/mobile') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.on('message', function handler(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    });
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

async function pairAndAuthenticate(ws, device, token) {
  send(ws, {
    type: 'pair',
    pairingToken: token,
    devicePublicKey: device.publicKeyHex,
    deviceId: device.deviceId,
    deviceName: 'Test Device',
  });
  return waitForMessage(ws, m => m.type === 'connected');
}

describe('Bridge', () => {
  beforeAll(async () => {
    bridge = new Bridge(TEST_PORT);
    await bridge.start();
  });

  afterAll(() => {
    bridge.shutdown();
  });

  describe('Authentication Enforcement', () => {
    it('rejects unauthenticated messages', async () => {
      const ws = await connectWs();

      // Try sending a regular message without authenticating
      send(ws, { type: 'listAgents' });

      // Should get an auth error, not a response
      const msg = await waitForMessage(ws, m => m.type === 'authError');
      expect(msg.error).toBeTruthy();

      ws.close();
    });

    it('closes connection after auth timeout', async () => {
      const ws = await connectWs();

      const closed = new Promise(resolve => {
        ws.on('close', (code) => resolve(code));
      });

      // Wait for timeout (10s) — we'll use a shorter assertion
      const code = await closed;
      expect(code).toBe(4008);
    }, 15000);

    it('accepts valid device pairing', async () => {
      const ws = await connectWs();
      const device = createTestDevice();
      const token = generatePairingToken();

      const connected = await pairAndAuthenticate(ws, device, token);
      expect(connected.type).toBe('connected');
      expect(connected.deviceId).toBe(device.deviceId);
      expect(Array.isArray(connected.agents)).toBe(true);

      ws.close();
    });

    it('accepts signed challenge from paired device', async () => {
      // First, pair a device
      const ws1 = await connectWs();
      const device = createTestDevice();
      const token = generatePairingToken();
      await pairAndAuthenticate(ws1, device, token);
      ws1.close();

      // Now authenticate with a signed challenge
      const ws2 = await connectWs();
      const challenge = {
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: device.deviceId,
      };
      const { payload, signature } = device.signPayload(challenge);

      send(ws2, { type: 'authenticate', payload, signature });
      const connected = await waitForMessage(ws2, m => m.type === 'connected');
      expect(connected.type).toBe('connected');

      ws2.close();
    });

    it('rejects invalid signature', async () => {
      const ws = await connectWs();
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: 'some-device',
      });

      send(ws, {
        type: 'authenticate',
        payload,
        signature: 'aa'.repeat(64), // garbage signature
      });

      const msg = await waitForMessage(ws, m => m.type === 'authError');
      expect(msg.error).toBeTruthy();

      ws.close();
    });
  });

  describe('Agent Management (Authenticated)', () => {
    let ws;
    let device;

    beforeEach(async () => {
      ws = await connectWs();
      device = createTestDevice();
      const token = generatePairingToken();
      await pairAndAuthenticate(ws, device, token);
    });

    afterAll(() => {
      // Cleanup any agents
      for (const [id, session] of bridge.agents) {
        session.destroy();
      }
      bridge.agents.clear();
    });

    it('lists agents (initially empty)', async () => {
      send(ws, { type: 'listAgents' });
      const msg = await waitForMessage(ws, m => m.type === 'agentList');
      expect(Array.isArray(msg.agents)).toBe(true);

      ws.close();
    });

    it('rejects unknown message types gracefully', async () => {
      send(ws, { type: 'nonExistentCommand' });
      // Should not crash — just ignored

      // Verify the connection is still alive
      send(ws, { type: 'ping' });
      const pong = await waitForMessage(ws, m => m.type === 'pong');
      expect(pong.type).toBe('pong');

      ws.close();
    });

    it('responds to ping with pong', async () => {
      send(ws, { type: 'ping' });
      const msg = await waitForMessage(ws, m => m.type === 'pong');
      expect(msg.type).toBe('pong');
      expect(typeof msg.ts).toBe('number');

      ws.close();
    });

    it('rejects sendMessage for nonexistent agent', async () => {
      send(ws, { type: 'sendMessage', agentId: 'nonexistent', text: 'hello' });
      const msg = await waitForMessage(ws, m => m.type === 'error');
      expect(msg.error).toMatch(/not found/i);

      ws.close();
    });

    it('rejects destroyAgent for nonexistent agent', async () => {
      send(ws, { type: 'destroyAgent', agentId: 'nonexistent' });
      const msg = await waitForMessage(ws, m => m.type === 'error');
      expect(msg.error).toMatch(/not found/i);

      ws.close();
    });

    it('rejects interruptAgent for nonexistent agent', async () => {
      send(ws, { type: 'interruptAgent', agentId: 'nonexistent' });
      const msg = await waitForMessage(ws, m => m.type === 'error');
      expect(msg.error).toMatch(/not found/i);

      ws.close();
    });

    it('routes interruptAgent to session.interrupt', async () => {
      const agentId = '00000000-0000-0000-0000-000000000042';
      const interrupt = vi.fn().mockResolvedValue(true);

      bridge.agents.set(agentId, { interrupt });
      send(ws, { type: 'interruptAgent', agentId });

      await new Promise(resolve => setTimeout(resolve, 25));
      expect(interrupt).toHaveBeenCalledOnce();

      bridge.agents.delete(agentId);
      ws.close();
    });
  });

  describe('CLI Endpoint', () => {
    it('rejects CLI connection for unknown agent', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws/cli/00000000-0000-0000-0000-000000000000`);

      const code = await new Promise(resolve => {
        ws.on('close', resolve);
        ws.on('error', () => {}); // suppress error
      });

      expect(code).toBe(4004);
    });

    it('rejects unknown WebSocket paths', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws/unknown`);

      await new Promise((resolve) => {
        ws.on('error', (e) => {
          expect(e.message).toContain('404');
          resolve();
        });
      });
    });
  });
});
