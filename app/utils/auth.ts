// Mobile-side Ed25519 authentication utility.
// Uses tweetnacl for Ed25519 signing and expo-secure-store for iOS Keychain storage.
//
// Protocol:
//   Pairing (one-time):  phone scans QR → sends { type: "pair", pairingToken, devicePublicKey, deviceId, deviceName }
//   Auth (every connect): phone sends { type: "authenticate", payload: JSON, signature: hex }
//     where payload = JSON.stringify({ timestamp, nonce, deviceId })
//     and signature = Ed25519 detached signature of payload bytes, as hex

// Polyfill crypto.getRandomValues for React Native (must be imported before tweetnacl)
import 'react-native-get-random-values';

import nacl from 'tweetnacl';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// --- Secure Store Keys ---
// All sensitive material stored in iOS Keychain / Android Keystore.

const STORE_KEY_SEED = 'ma_ed25519_seed'; // 32-byte Ed25519 seed (hex)
const STORE_KEY_PUBLIC = 'ma_ed25519_pub'; // 32-byte public key (hex)
const STORE_KEY_DEVICE_ID = 'ma_device_id'; // UUID-style device identifier
const STORE_KEY_SERVER_URL = 'ma_server_url'; // Tunnel URL (wss://...)
const STORE_KEY_SERVER_PUB = 'ma_server_pub'; // Server's Ed25519 public key (hex)
const STORE_KEY_PAIRED_AT = 'ma_paired_at'; // ISO timestamp of pairing

// --- Hex encoding helpers ---

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// --- Key Management ---

/**
 * Generate a new Ed25519 keypair from a random seed.
 * Stores the 32-byte seed (not the full 64-byte secretKey) in secure storage.
 * The seed is sufficient to deterministically regenerate the full keypair.
 */
async function generateAndStoreKeyPair(): Promise<{ publicKey: string; deviceId: string }> {
  const keyPair = nacl.sign.keyPair();

  // Extract the 32-byte seed from the 64-byte secretKey (first 32 bytes)
  const seed = keyPair.secretKey.slice(0, 32);
  const publicKeyHex = bytesToHex(keyPair.publicKey);

  // Generate a device ID from the public key hash (first 16 bytes as UUID-like string)
  const hash = nacl.hash(keyPair.publicKey);
  const deviceId = [
    bytesToHex(hash.slice(0, 4)),
    bytesToHex(hash.slice(4, 6)),
    bytesToHex(hash.slice(6, 8)),
    bytesToHex(hash.slice(8, 10)),
    bytesToHex(hash.slice(10, 16)),
  ].join('-');

  // Store in iOS Keychain / Android Keystore
  await SecureStore.setItemAsync(STORE_KEY_SEED, bytesToHex(seed));
  await SecureStore.setItemAsync(STORE_KEY_PUBLIC, publicKeyHex);
  await SecureStore.setItemAsync(STORE_KEY_DEVICE_ID, deviceId);

  return { publicKey: publicKeyHex, deviceId };
}

/**
 * Load the existing keypair from secure storage.
 * Returns null if no keypair exists (device not yet paired).
 */
async function loadKeyPair(): Promise<nacl.SignKeyPair | null> {
  const seedHex = await SecureStore.getItemAsync(STORE_KEY_SEED);
  if (!seedHex) return null;

  const seed = hexToBytes(seedHex);
  return nacl.sign.keyPair.fromSeed(seed);
}

/**
 * Get the device ID from secure storage.
 */
export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(STORE_KEY_DEVICE_ID);
}

/**
 * Check whether this device has been paired (has stored credentials).
 */
export async function isPaired(): Promise<boolean> {
  const [seed, url] = await Promise.all([
    SecureStore.getItemAsync(STORE_KEY_SEED),
    SecureStore.getItemAsync(STORE_KEY_SERVER_URL),
  ]);
  return seed !== null && url !== null;
}

/**
 * Get stored server connection info.
 * Returns null if not paired.
 */
export async function getStoredCredentials(): Promise<{
  serverUrl: string;
  serverPublicKey: string;
  deviceId: string;
  publicKey: string;
  pairedAt: string;
} | null> {
  const [serverUrl, serverPub, deviceId, publicKey, pairedAt] = await Promise.all([
    SecureStore.getItemAsync(STORE_KEY_SERVER_URL),
    SecureStore.getItemAsync(STORE_KEY_SERVER_PUB),
    SecureStore.getItemAsync(STORE_KEY_DEVICE_ID),
    SecureStore.getItemAsync(STORE_KEY_PUBLIC),
    SecureStore.getItemAsync(STORE_KEY_PAIRED_AT),
  ]);

  if (!serverUrl || !serverPub || !deviceId || !publicKey) return null;

  return { serverUrl, serverPublicKey: serverPub, deviceId, publicKey, pairedAt: pairedAt || '' };
}

// --- Pairing Flow ---

/**
 * QR code data format from server:
 * { url: string, pairingToken: string, serverPublicKey: string (hex) }
 */
export interface QRPairingData {
  url: string;
  pairingToken: string;
  serverPublicKey: string;
}

/**
 * Parse QR code data. Validates structure before returning.
 */
export function parseQRCode(data: string): QRPairingData | null {
  try {
    const parsed = JSON.parse(data);
    if (
      typeof parsed.url === 'string' &&
      typeof parsed.pairingToken === 'string' &&
      typeof parsed.serverPublicKey === 'string' &&
      parsed.url.length > 0 &&
      parsed.pairingToken.length > 0 &&
      parsed.serverPublicKey.length === 64 // 32 bytes as hex
    ) {
      return parsed as QRPairingData;
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

/**
 * Build the pairing message to send to the server after QR scan.
 * Reuses existing keypair if one exists — only generates new keys on first pair.
 * This ensures the device identity is stable across re-pairing attempts.
 */
export async function buildPairMessage(qrData: QRPairingData): Promise<{
  type: 'pair';
  pairingToken: string;
  devicePublicKey: string;
  deviceId: string;
  deviceName: string;
}> {
  // Reuse existing keypair if available, otherwise generate a new one
  let publicKey = await SecureStore.getItemAsync(STORE_KEY_PUBLIC);
  let deviceId = await SecureStore.getItemAsync(STORE_KEY_DEVICE_ID);

  if (!publicKey || !deviceId) {
    const generated = await generateAndStoreKeyPair();
    publicKey = generated.publicKey;
    deviceId = generated.deviceId;
  }

  // Store server info
  await SecureStore.setItemAsync(STORE_KEY_SERVER_URL, qrData.url);
  await SecureStore.setItemAsync(STORE_KEY_SERVER_PUB, qrData.serverPublicKey);
  await SecureStore.setItemAsync(STORE_KEY_PAIRED_AT, new Date().toISOString());

  // Device name for server-side identification
  const deviceName = `${Platform.OS} ${Platform.Version || ''}`.trim();

  return {
    type: 'pair',
    pairingToken: qrData.pairingToken,
    devicePublicKey: publicKey,
    deviceId,
    deviceName,
  };
}

// --- Authentication Flow ---

/**
 * Build a signed authentication challenge to send on every WebSocket connection.
 * The server verifies the signature against the stored device public key.
 *
 * Returns the message to send, or null if not paired.
 */
export async function buildAuthMessage(): Promise<{
  type: 'authenticate';
  payload: string;
  signature: string;
} | null> {
  const keyPair = await loadKeyPair();
  const deviceId = await getDeviceId();

  if (!keyPair || !deviceId) return null;

  // Generate a random nonce (32 bytes as hex)
  const nonceBytes = nacl.randomBytes(32);
  const nonce = bytesToHex(nonceBytes);

  // Build the challenge payload
  const payload = JSON.stringify({
    timestamp: Date.now(),
    nonce,
    deviceId,
  });

  // Sign the payload bytes with our Ed25519 private key (detached signature)
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = nacl.sign.detached(payloadBytes, keyPair.secretKey);

  return {
    type: 'authenticate',
    payload,
    signature: bytesToHex(signature),
  };
}

// --- Server URL Management ---

/**
 * Get the stored server public key (hex).
 * Used to detect if a scanned QR is from the same server we're already paired with.
 */
export async function getStoredServerPublicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(STORE_KEY_SERVER_PUB);
}

/**
 * Update the stored server URL without re-pairing.
 * Used when scanning a QR from a server we're already paired with
 * (e.g., tunnel URL changed after restart, but same server keys).
 */
export async function updateServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY_SERVER_URL, url);
}

// --- Credential Management ---

/**
 * Clear all stored credentials. Used when unpairing or resetting the app.
 */
export async function clearCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(STORE_KEY_SEED),
    SecureStore.deleteItemAsync(STORE_KEY_PUBLIC),
    SecureStore.deleteItemAsync(STORE_KEY_DEVICE_ID),
    SecureStore.deleteItemAsync(STORE_KEY_SERVER_URL),
    SecureStore.deleteItemAsync(STORE_KEY_SERVER_PUB),
    SecureStore.deleteItemAsync(STORE_KEY_PAIRED_AT),
  ]);
}

/**
 * Get the WebSocket URL for the mobile connection.
 * Converts the stored server URL to the mobile WebSocket endpoint.
 */
export async function getWebSocketUrl(): Promise<string | null> {
  const serverUrl = await SecureStore.getItemAsync(STORE_KEY_SERVER_URL);
  if (!serverUrl) return null;

  // Ensure we connect to the /ws/mobile path
  const base = serverUrl.replace(/\/+$/, '');
  const wsUrl = base.startsWith('https://') ? base.replace('https://', 'wss://') :
                base.startsWith('http://') ? base.replace('http://', 'ws://') :
                base;

  return `${wsUrl}/ws/mobile`;
}
