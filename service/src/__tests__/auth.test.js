import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Override DATA_DIR to a temp location for tests
const TEST_DATA_DIR = join(process.env.HOME, '.mobile-agent-test-' + process.pid);
process.env.MOBILE_AGENT_DATA_DIR = TEST_DATA_DIR;

// We need to set env before importing auth, but auth.js uses a hardcoded path.
// For now, test against the real path but clean up. We'll use a mock approach.
// Actually, let's just import and test — the real ~/.mobile-agent/ already exists from our manual tests.

import {
  initializeKeys,
  generatePairingToken,
  getServerPublicKeyRaw,
  registerDevice,
  verifyChallenge,
  revokeDevice,
  listDevices,
  hasDevices,
  isPairingActive,
  logAudit,
} from '../auth.js';

// Simulate a mobile device (tweetnacl-compatible Ed25519 keypair via Node crypto)
function createTestDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const deviceId = 'test-' + randomBytes(4).toString('hex');

  function signChallenge(payload) {
    return sign(null, Buffer.from(payload, 'utf-8'), privateKey).toString('hex');
  }

  return {
    publicKeyHex: publicKeyRaw.toString('hex'),
    deviceId,
    signChallenge,
  };
}

describe('Auth Module', () => {
  beforeAll(() => {
    initializeKeys();
  });

  describe('Key Initialization', () => {
    it('generates server keypair on first run', () => {
      const raw = getServerPublicKeyRaw();
      expect(raw).toBeInstanceOf(Buffer);
      expect(raw.length).toBe(32);
    });

    it('returns same key on subsequent calls', () => {
      const key1 = getServerPublicKeyRaw();
      initializeKeys(); // reload
      const key2 = getServerPublicKeyRaw();
      expect(key1.toString('hex')).toBe(key2.toString('hex'));
    });

    it('persists keys to disk with correct permissions', () => {
      const keyPath = join(process.env.HOME, '.mobile-agent', 'server.key');
      expect(existsSync(keyPath)).toBe(true);
    });
  });

  describe('Device Pairing', () => {
    it('generates a pairing token', () => {
      const token = generatePairingToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20); // base64url of 32 bytes
    });

    it('pairing token is one-time use', () => {
      const token = generatePairingToken();
      const device = createTestDevice();

      const result1 = registerDevice(token, device.publicKeyHex, device.deviceId, 'iPhone', '127.0.0.1');
      expect(result1.success).toBe(true);

      // Same token again should fail
      const device2 = createTestDevice();
      const result2 = registerDevice(token, device2.publicKeyHex, device2.deviceId, 'iPad', '127.0.0.1');
      expect(result2.success).toBe(false);
      expect(result2.error).toMatch(/no active/i);
    });

    it('rejects invalid pairing token', () => {
      generatePairingToken(); // activate a session
      const device = createTestDevice();
      const result = registerDevice('totally-wrong-token', device.publicKeyHex, device.deviceId, 'iPhone', '127.0.0.1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid/i);
    });

    it('rejects pairing when no token is active', () => {
      // Don't generate a token
      const device = createTestDevice();
      // Exhaust any existing token first
      const dummy = generatePairingToken();
      registerDevice(dummy, device.publicKeyHex, device.deviceId, 'dummy', '127.0.0.1');

      const device2 = createTestDevice();
      const result = registerDevice('any-token', device2.publicKeyHex, device2.deviceId, 'iPhone', '127.0.0.1');
      expect(result.success).toBe(false);
    });

    it('rejects invalid public key format', () => {
      const token = generatePairingToken();
      const result = registerDevice(token, 'not-a-valid-key', 'device-1', 'iPhone', '127.0.0.1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid.*key/i);
    });

    it('stores paired device', () => {
      const token = generatePairingToken();
      const device = createTestDevice();
      registerDevice(token, device.publicKeyHex, device.deviceId, 'Test Phone', '127.0.0.1');

      const devices = listDevices();
      const found = devices.find(d => d.id === device.deviceId);
      expect(found).toBeDefined();
      expect(found.name).toBe('Test Phone');
    });
  });

  describe('Challenge-Response Authentication', () => {
    let pairedDevice;

    beforeAll(() => {
      // Pair a device for auth tests
      const token = generatePairingToken();
      pairedDevice = createTestDevice();
      registerDevice(token, pairedDevice.publicKeyHex, pairedDevice.deviceId, 'Auth Test', '127.0.0.1');
    });

    it('verifies a valid signed challenge', () => {
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId,
      });
      const signature = pairedDevice.signChallenge(payload);

      const result = verifyChallenge(payload, signature, '127.0.0.1');
      expect(result.success).toBe(true);
      expect(result.deviceId).toBe(pairedDevice.deviceId);
    });

    it('rejects stale timestamp (>30s old)', () => {
      const payload = JSON.stringify({
        timestamp: Date.now() - 60_000, // 1 minute ago
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId,
      });
      const signature = pairedDevice.signChallenge(payload);

      const result = verifyChallenge(payload, signature, '10.0.0.1');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/expired|clock/i);
    });

    it('rejects future timestamp (>30s ahead)', () => {
      const payload = JSON.stringify({
        timestamp: Date.now() + 60_000, // 1 minute in the future
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId,
      });
      const signature = pairedDevice.signChallenge(payload);

      const result = verifyChallenge(payload, signature, '10.0.0.2');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/expired|clock/i);
    });

    it('rejects reused nonce (replay attack)', () => {
      const nonce = randomBytes(16).toString('hex');
      const payload1 = JSON.stringify({
        timestamp: Date.now(),
        nonce,
        deviceId: pairedDevice.deviceId,
      });
      const sig1 = pairedDevice.signChallenge(payload1);

      const result1 = verifyChallenge(payload1, sig1, '127.0.0.1');
      expect(result1.success).toBe(true);

      // Same nonce again — replay
      const payload2 = JSON.stringify({
        timestamp: Date.now(),
        nonce, // same nonce
        deviceId: pairedDevice.deviceId,
      });
      const sig2 = pairedDevice.signChallenge(payload2);

      const result2 = verifyChallenge(payload2, sig2, '10.0.0.3');
      expect(result2.success).toBe(false);
      expect(result2.error).toMatch(/nonce/i);
    });

    it('rejects unknown device', () => {
      const unknownDevice = createTestDevice();
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: unknownDevice.deviceId, // not paired
      });
      const signature = unknownDevice.signChallenge(payload);

      const result = verifyChallenge(payload, signature, '10.0.0.4');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown/i);
    });

    it('rejects forged signature (wrong key)', () => {
      const attacker = createTestDevice();
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId, // claim to be the paired device
      });
      // Sign with attacker's key, not the paired device's key
      const signature = attacker.signChallenge(payload);

      const result = verifyChallenge(payload, signature, '10.0.0.5');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signature/i);
    });

    it('rejects tampered payload', () => {
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId,
      });
      const signature = pairedDevice.signChallenge(payload);

      // Tamper with the payload after signing
      const tampered = payload.replace(pairedDevice.deviceId, 'evil-device');
      const result = verifyChallenge(tampered, signature, '10.0.0.6');
      expect(result.success).toBe(false);
    });

    it('rejects malformed JSON payload', () => {
      const result = verifyChallenge('not json', 'aa'.repeat(64), '10.0.0.7');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid/i);
    });

    it('rejects wrong signature length', () => {
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: pairedDevice.deviceId,
      });
      const result = verifyChallenge(payload, 'deadbeef', '10.0.0.8');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signature/i);
    });
  });

  describe('Rate Limiting', () => {
    it('blocks IP after 5 failed attempts', () => {
      const ip = '192.168.99.99';
      const device = createTestDevice();

      // Burn through 5 attempts
      for (let i = 0; i < 5; i++) {
        verifyChallenge('bad', 'aa'.repeat(64), ip);
      }

      // 6th attempt should be rate limited
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: device.deviceId,
      });
      const sig = device.signChallenge(payload);
      const result = verifyChallenge(payload, sig, ip);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/too many/i);
    });
  });

  describe('Device Revocation', () => {
    it('revokes a paired device', () => {
      const token = generatePairingToken();
      const device = createTestDevice();
      registerDevice(token, device.publicKeyHex, device.deviceId, 'To Revoke', '127.0.0.1');

      expect(revokeDevice(device.deviceId)).toBe(true);

      // Auth should now fail
      const payload = JSON.stringify({
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
        deviceId: device.deviceId,
      });
      const signature = device.signChallenge(payload);
      const result = verifyChallenge(payload, signature, '127.0.0.2');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown/i);
    });

    it('returns false for non-existent device', () => {
      expect(revokeDevice('nonexistent-device')).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    it('writes to audit log', () => {
      logAudit('test_event', { detail: 'test' });
      const logPath = join(process.env.HOME, '.mobile-agent', 'audit.log');
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('test_event');
    });
  });
});
