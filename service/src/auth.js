import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.env.HOME, '.mobile-agent');
const SERVER_KEY_PATH = join(DATA_DIR, 'server.key');
const SERVER_PUB_PATH = join(DATA_DIR, 'server.pub');
const DEVICES_PATH = join(DATA_DIR, 'devices.json');
const AUDIT_LOG_PATH = join(DATA_DIR, 'audit.log');

// SPKI DER prefix for Ed25519 public keys (RFC 8410)
// This is the fixed ASN.1 header: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }
// Raw 32-byte Ed25519 public key is appended after this prefix.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const CHALLENGE_WINDOW_MS = 30_000; // 30 seconds
const PAIRING_TOKEN_TTL_MS = 5 * 60_000; // 5 minutes
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_BLOCK_MS = 15 * 60_000; // 15 minutes

// In-memory state
let serverPrivateKey = null;
let serverPublicKey = null;
let serverPublicKeyRaw = null; // Raw 32-byte public key for QR code
let devices = {}; // deviceId -> { publicKey (hex), name, pairedAt, lastSeen }
let activePairingToken = null; // { token (base64url), createdAt, expiresAt }
const usedNonces = new Map(); // nonce -> timestamp
const failedAttempts = new Map(); // ip -> { count, firstAttempt, blockedUntil }

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

// Convert a raw 32-byte Ed25519 public key (from tweetnacl) into a Node.js KeyObject
// by wrapping it in the SPKI DER format.
function rawPublicKeyToKeyObject(rawKeyHex) {
  const rawKeyBuf = Buffer.from(rawKeyHex, 'hex');
  if (rawKeyBuf.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: expected 32, got ${rawKeyBuf.length}`);
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawKeyBuf]);
  return createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
}

/**
 * Initialize or load the server Ed25519 keypair.
 * Private key file is chmod 0600 (owner read/write only).
 */
export function initializeKeys() {
  ensureDataDir();

  if (existsSync(SERVER_KEY_PATH) && existsSync(SERVER_PUB_PATH)) {
    serverPrivateKey = createPrivateKey({ key: readFileSync(SERVER_KEY_PATH, 'utf-8'), format: 'pem', type: 'pkcs8' });
    serverPublicKey = createPublicKey({ key: readFileSync(SERVER_PUB_PATH, 'utf-8'), format: 'pem', type: 'spki' });
    serverPublicKeyRaw = serverPublicKey.export({ type: 'spki', format: 'der' }).subarray(12);
    logAudit('server_keys_loaded', { publicKey: serverPublicKeyRaw.toString('hex').slice(0, 16) + '...' });
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    serverPrivateKey = privateKey;
    serverPublicKey = publicKey;
    serverPublicKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

    writeFileSync(SERVER_KEY_PATH, privatePem, { mode: 0o600 });
    chmodSync(SERVER_KEY_PATH, 0o600); // Ensure permissions even if umask is permissive
    writeFileSync(SERVER_PUB_PATH, publicPem, { mode: 0o644 });

    logAudit('server_keys_generated', { publicKey: serverPublicKeyRaw.toString('hex').slice(0, 16) + '...' });
  }

  loadDevices();
  return { publicKeyRaw: serverPublicKeyRaw };
}

/**
 * Get the raw 32-byte server public key (for QR code / pairing).
 */
export function getServerPublicKeyRaw() {
  if (!serverPublicKeyRaw) {
    throw new Error('Server keys not initialized. Call initializeKeys() first.');
  }
  return serverPublicKeyRaw;
}

/**
 * Generate a one-time pairing token. Only one can be active at a time.
 * Returns the token string (base64url encoded).
 */
export function generatePairingToken() {
  const tokenBytes = randomBytes(32);
  const token = tokenBytes.toString('base64url');

  activePairingToken = {
    tokenHash: hashToken(tokenBytes), // Store hash, not plaintext
    createdAt: Date.now(),
    expiresAt: Date.now() + PAIRING_TOKEN_TTL_MS,
  };

  logAudit('pairing_token_generated', { expiresIn: `${PAIRING_TOKEN_TTL_MS / 1000}s` });
  return token;
}

/**
 * Hash a token for storage (we never store plaintext pairing tokens).
 * Uses SHA-256 for one-way hashing.
 */
function hashToken(tokenBytes) {
  return createHash('sha256').update(tokenBytes).digest();
}

/**
 * Register a new device after successful pairing.
 * @param {string} pairingToken - The one-time token from QR code (base64url)
 * @param {string} devicePublicKeyHex - 32-byte Ed25519 public key as hex
 * @param {string} deviceId - Unique device identifier
 * @param {string} deviceName - Human-readable device name (optional)
 * @param {string} ip - IP address of the pairing request
 * @returns {{ success: boolean, error?: string }}
 */
export function registerDevice(pairingToken, devicePublicKeyHex, deviceId, deviceName, ip) {
  // Check rate limit first
  if (isRateLimited(ip)) {
    logAudit('pairing_rate_limited', { ip, deviceId });
    return { success: false, error: 'Too many failed attempts. Try again later.' };
  }

  // Validate pairing token exists and is active
  if (!activePairingToken) {
    recordFailedAttempt(ip);
    logAudit('pairing_no_active_token', { ip, deviceId });
    return { success: false, error: 'No active pairing session.' };
  }

  // Check expiry
  if (Date.now() > activePairingToken.expiresAt) {
    activePairingToken = null;
    recordFailedAttempt(ip);
    logAudit('pairing_token_expired', { ip, deviceId });
    return { success: false, error: 'Pairing token expired.' };
  }

  // Verify token (constant-time comparison of hashes)
  const providedHash = hashToken(Buffer.from(pairingToken, 'base64url'));
  if (providedHash.length !== activePairingToken.tokenHash.length ||
      !timingSafeEqual(providedHash, activePairingToken.tokenHash)) {
    recordFailedAttempt(ip);
    logAudit('pairing_invalid_token', { ip, deviceId });
    return { success: false, error: 'Invalid pairing token.' };
  }

  // Validate the public key format
  if (!devicePublicKeyHex || Buffer.from(devicePublicKeyHex, 'hex').length !== 32) {
    logAudit('pairing_invalid_key', { ip, deviceId });
    return { success: false, error: 'Invalid device public key.' };
  }

  // Invalidate pairing token immediately (one-time use)
  activePairingToken = null;

  // Clear rate limit on successful pairing
  failedAttempts.delete(ip);

  // Store the device
  devices[deviceId] = {
    publicKey: devicePublicKeyHex,
    name: deviceName || `Device ${Object.keys(devices).length + 1}`,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  saveDevices();
  logAudit('device_paired', { deviceId, name: devices[deviceId].name, ip });

  return { success: true };
}

/**
 * Verify a signed authentication challenge from a paired device.
 * Challenge payload: JSON string of { timestamp, nonce, deviceId }
 * @param {string} payloadJson - The JSON string that was signed
 * @param {string} signatureHex - Ed25519 signature as hex (128 hex chars = 64 bytes)
 * @param {string} ip - IP address of the request
 * @returns {{ success: boolean, deviceId?: string, error?: string }}
 */
export function verifyChallenge(payloadJson, signatureHex, ip) {
  // Check rate limit
  if (isRateLimited(ip)) {
    logAudit('auth_rate_limited', { ip });
    return { success: false, error: 'Too many failed attempts. Try again later.' };
  }

  // Parse the payload
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    recordFailedAttempt(ip);
    logAudit('auth_invalid_payload', { ip });
    return { success: false, error: 'Invalid challenge payload.' };
  }

  const { timestamp, nonce, deviceId } = payload;

  // Validate required fields
  if (!timestamp || !nonce || !deviceId) {
    recordFailedAttempt(ip);
    logAudit('auth_missing_fields', { ip, deviceId });
    return { success: false, error: 'Missing required challenge fields.' };
  }

  // Check timestamp freshness (reject if outside +-30s window)
  const now = Date.now();
  if (typeof timestamp !== 'number' || Math.abs(now - timestamp) > CHALLENGE_WINDOW_MS) {
    recordFailedAttempt(ip);
    logAudit('auth_stale_timestamp', { ip, deviceId, drift: now - timestamp });
    return { success: false, error: 'Challenge expired or clock skew too large.' };
  }

  // Check nonce hasn't been used (replay protection)
  if (usedNonces.has(nonce)) {
    recordFailedAttempt(ip);
    logAudit('auth_nonce_replay', { ip, deviceId, nonce: nonce.slice(0, 8) + '...' });
    return { success: false, error: 'Nonce already used.' };
  }

  // Look up the device
  const device = devices[deviceId];
  if (!device) {
    recordFailedAttempt(ip);
    logAudit('auth_unknown_device', { ip, deviceId });
    return { success: false, error: 'Unknown device.' };
  }

  // Verify the Ed25519 signature
  const signatureBytes = Buffer.from(signatureHex, 'hex');
  if (signatureBytes.length !== 64) {
    recordFailedAttempt(ip);
    logAudit('auth_invalid_signature_length', { ip, deviceId });
    return { success: false, error: 'Invalid signature format.' };
  }

  const payloadBytes = Buffer.from(payloadJson, 'utf-8');
  let deviceKeyObject;
  try {
    deviceKeyObject = rawPublicKeyToKeyObject(device.publicKey);
  } catch {
    recordFailedAttempt(ip);
    logAudit('auth_corrupt_device_key', { ip, deviceId });
    return { success: false, error: 'Device key is corrupt.' };
  }

  // Ed25519 requires null as algorithm parameter
  const valid = verify(null, payloadBytes, deviceKeyObject, signatureBytes);
  if (!valid) {
    recordFailedAttempt(ip);
    logAudit('auth_signature_invalid', { ip, deviceId });
    return { success: false, error: 'Invalid signature.' };
  }

  // Signature valid — record nonce and update device
  usedNonces.set(nonce, timestamp);
  pruneNonces();

  device.lastSeen = new Date().toISOString();
  saveDevices();

  // Clear any failed attempts for this IP on success
  failedAttempts.delete(ip);

  logAudit('auth_success', { ip, deviceId });
  return { success: true, deviceId };
}

/**
 * Revoke a device's access. The device will no longer be able to authenticate.
 * @param {string} deviceId
 * @returns {boolean} True if device was found and revoked.
 */
export function revokeDevice(deviceId) {
  if (!devices[deviceId]) {
    return false;
  }
  const name = devices[deviceId].name;
  delete devices[deviceId];
  saveDevices();
  logAudit('device_revoked', { deviceId, name });
  return true;
}

/**
 * List all authorized devices (public info only, no keys).
 */
export function listDevices() {
  return Object.entries(devices).map(([id, d]) => ({
    id,
    name: d.name,
    pairedAt: d.pairedAt,
    lastSeen: d.lastSeen,
  }));
}

/**
 * Check if any devices are paired.
 */
export function hasDevices() {
  return Object.keys(devices).length > 0;
}

/**
 * Check if a pairing session is currently active (for UI state).
 */
export function isPairingActive() {
  if (!activePairingToken) return false;
  if (Date.now() > activePairingToken.expiresAt) {
    activePairingToken = null;
    return false;
  }
  return true;
}

// --- Rate limiting ---

function isRateLimited(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;

  // Check if currently blocked
  if (record.blockedUntil && Date.now() < record.blockedUntil) {
    return true;
  }

  // If block has expired, reset
  if (record.blockedUntil && Date.now() >= record.blockedUntil) {
    failedAttempts.delete(ip);
    return false;
  }

  // If the window has passed, reset
  if (Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }

  return false;
}

function recordFailedAttempt(ip) {
  const record = failedAttempts.get(ip);

  if (!record || Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAttempt: Date.now(), blockedUntil: null });
    return;
  }

  record.count++;
  if (record.count >= RATE_LIMIT_MAX_FAILURES) {
    record.blockedUntil = Date.now() + RATE_LIMIT_BLOCK_MS;
    logAudit('ip_blocked', { ip, duration: `${RATE_LIMIT_BLOCK_MS / 1000}s`, attempts: record.count });
  }
}

// --- Nonce management ---

function pruneNonces() {
  const cutoff = Date.now() - (CHALLENGE_WINDOW_MS * 2);
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) {
      usedNonces.delete(nonce);
    }
  }
}

// --- Device persistence ---

function loadDevices() {
  try {
    if (existsSync(DEVICES_PATH)) {
      const data = JSON.parse(readFileSync(DEVICES_PATH, 'utf-8'));
      devices = data.devices || {};
      logAudit('devices_loaded', { count: Object.keys(devices).length });
    }
  } catch (e) {
    console.error('Failed to load devices:', e.message);
    devices = {};
  }
}

function saveDevices() {
  ensureDataDir();
  const data = JSON.stringify({ devices, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(DEVICES_PATH, data, { mode: 0o600 });
}

// --- Audit logging ---

/**
 * Append a structured entry to the audit log.
 * Format: ISO timestamp | event | JSON details
 */
export function logAudit(event, details = {}) {
  ensureDataDir();
  const entry = `${new Date().toISOString()} | ${event} | ${JSON.stringify(details)}\n`;
  try {
    appendFileSync(AUDIT_LOG_PATH, entry, { mode: 0o600 });
  } catch {
    // Audit log write failure should not crash the server
    console.error(`[audit] Failed to write: ${event}`);
  }
}

// --- Crypto helpers (re-export for use by bridge) ---

/**
 * Sign a message with the server's private key.
 * Used to sign the QR code data so the mobile app can verify it came from this server.
 */
export function serverSign(message) {
  if (!serverPrivateKey) {
    throw new Error('Server keys not initialized.');
  }
  return sign(null, Buffer.from(message, 'utf-8'), serverPrivateKey);
}
