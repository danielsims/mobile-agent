// Session persistence for agent sessions across server restarts.
// Stores lightweight session references in ~/.mobile-agent/sessions.json
// so agents can be restored with `claude --resume <sessionId>`.
//
// Conversation history is NOT stored here — it's read from the CLI's own
// session storage on restore (see transcripts.js).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logAudit } from './auth.js';

const DATA_DIR = join(process.env.HOME, '.mobile-agent');
const SESSIONS_PATH = join(DATA_DIR, 'sessions.json');

// In-memory state
let sessions = {}; // agentId -> { sessionId, type, sessionName, createdAt, cwd }

/**
 * Load saved sessions from disk. Called on bridge startup.
 */
export function loadSessions() {
  try {
    if (existsSync(SESSIONS_PATH)) {
      const data = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
      sessions = data.sessions || {};
      logAudit('sessions_loaded', { count: Object.keys(sessions).length });
    }
  } catch (e) {
    console.error('Failed to load sessions:', e.message);
    sessions = {};
  }
}

/**
 * Save/update a session reference. Called when an agent gets a sessionId.
 * @param {string} agentId
 * @param {Object} info
 */
export function saveSession(agentId, info) {
  sessions[agentId] = {
    sessionId: info.sessionId,
    type: info.type || 'claude',
    sessionName: info.sessionName || null,
    createdAt: info.createdAt || Date.now(),
    cwd: info.cwd || null,
  };
  writeSessions();
}

/**
 * Remove a session reference. Called when an agent is destroyed.
 * @param {string} agentId
 */
export function removeSession(agentId) {
  if (!sessions[agentId]) return;
  delete sessions[agentId];
  writeSessions();
}

/**
 * Get all saved sessions.
 * @returns {Object} agentId -> { sessionId, type, sessionName, createdAt, cwd }
 */
export function getSavedSessions() {
  return { ...sessions };
}

/**
 * Clear all saved sessions. Used for testing/reset.
 */
export function clearSessions() {
  sessions = {};
  writeSessions();
}

function writeSessions() {
  const data = JSON.stringify({ sessions, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(SESSIONS_PATH, data, { mode: 0o600 });
}
