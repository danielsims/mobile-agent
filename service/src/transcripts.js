// Read conversation transcripts from CLI session storage.
//
// Each agent type (Claude, Codex, OpenCode) stores sessions differently.
// This module abstracts reading transcripts into a common format so we
// never persist chat history ourselves — the CLI is the source of truth.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME;

/**
 * Read a conversation transcript for a given agent session.
 * @param {string} type    — agent type ('claude', 'codex', 'opencode')
 * @param {string} sessionId — CLI session ID
 * @param {string|null} cwd — working directory (used to locate project storage)
 * @returns {{ model: string|null, messages: Array, lastOutput: string }} or null
 */
export function readTranscript(type, sessionId, cwd) {
  switch (type) {
    case 'claude':
      return _readClaudeTranscript(sessionId, cwd);
    // Future agent types:
    // case 'codex':
    //   return _readCodexTranscript(sessionId, cwd);
    // case 'opencode':
    //   return _readOpencodeTranscript(sessionId, cwd);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/projects/<encoded-path>/<session-id>.jsonl
// ---------------------------------------------------------------------------

function _readClaudeTranscript(sessionId, cwd) {
  if (!sessionId) return null;

  const sessionFile = _findClaudeSessionFile(sessionId, cwd);
  if (!sessionFile) return null;

  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.trim().split('\n');

    let model = null;
    const messages = [];
    let lastOutput = '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }

      const ts = entry.timestamp
        ? new Date(entry.timestamp).getTime()
        : Date.now();

      // User messages — two cases:
      // 1. Actual human input: string content → add as user message
      // 2. Tool results: array content with tool_result blocks → merge into preceding assistant message
      if (entry.type === 'user') {
        if (typeof entry.message?.content === 'string') {
          messages.push({ id: entry.uuid || `t-${messages.length}`, type: 'user', content: entry.message.content, timestamp: ts });
        } else if (Array.isArray(entry.message?.content)) {
          // Extract tool_result blocks and append to the last assistant message
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.type === 'assistant' && Array.isArray(lastMsg.content)) {
            for (const b of entry.message.content) {
              if (b.type === 'tool_result' && b.tool_use_id) {
                // content can be string or array of {type:'text', text:'...'}
                let resultText = '';
                if (typeof b.content === 'string') {
                  resultText = b.content;
                } else if (Array.isArray(b.content)) {
                  resultText = b.content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text)
                    .join('\n');
                }
                lastMsg.content.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: resultText });
              }
            }
          }
        }
        continue;
      }

      // Assistant messages
      if (entry.type === 'assistant' && entry.message?.content) {
        if (entry.message.model) model = entry.message.model;

        const blocks = _normalizeBlocks(entry.message.content);
        if (blocks.length === 0) continue;

        messages.push({ id: entry.uuid || `t-${messages.length}`, type: 'assistant', content: blocks, timestamp: ts });

        // Track last text output for card preview
        for (const b of blocks) {
          if (b.type === 'text' && b.text) lastOutput = b.text;
        }
      }
    }

    // Trim lastOutput to a reasonable preview length
    if (lastOutput.length > 500) lastOutput = lastOutput.slice(-500);

    return { model, messages, lastOutput };
  } catch (e) {
    console.error(`[transcripts] Failed to read Claude session ${sessionId.slice(0, 8)}:`, e.message);
    return null;
  }
}

/**
 * Find the session JSONL file for a Claude session.
 * Tries cwd-based project path first, then falls back to scanning projects.
 */
function _findClaudeSessionFile(sessionId, cwd) {
  const projectsDir = join(HOME, '.claude', 'projects');

  // Try direct path from cwd (most common case)
  if (cwd) {
    const encodedPath = cwd.split('/').join('-');
    const direct = join(projectsDir, encodedPath, `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }

  // Fallback: scan project directories for the session file
  try {
    const { readdirSync } = require('node:fs');
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // projects dir might not exist
  }

  return null;
}

/**
 * Normalize content blocks from Claude's JSONL format to our internal format.
 * Filters to only text and tool_use blocks (skips thinking, images, etc.)
 */
function _normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map(b => {
      if (b.type === 'text' && b.text) return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return null;
    })
    .filter(Boolean);
}
