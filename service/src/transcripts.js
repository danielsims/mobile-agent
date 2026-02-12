// Read conversation transcripts from CLI session storage.
//
// Each agent type (Claude, Codex, OpenCode) stores sessions differently.
// This module abstracts reading transcripts into a common format so we
// never persist chat history ourselves — the CLI is the source of truth.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    case 'codex':
      return _readCodexTranscript(sessionId, cwd);
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

// ---------------------------------------------------------------------------
// Codex — ~/.codex/sessions/<thread-id>/
// Codex stores sessions as JSONL event logs in its sessions directory.
// ---------------------------------------------------------------------------

function _readCodexTranscript(sessionId, cwd) {
  if (!sessionId) return null;

  const transcriptFile = _findCodexSessionFile(sessionId);
  if (!transcriptFile) return null;
  return _parseCodexEvents(transcriptFile, sessionId);
}

function _findCodexSessionFile(sessionId) {
  const sessionsDir = join(HOME, '.codex', 'sessions');
  const directDirFile = join(sessionsDir, sessionId, 'events.jsonl');
  if (existsSync(directDirFile)) return directDirFile;

  const directFlatFile = join(sessionsDir, `${sessionId}.jsonl`);
  if (existsSync(directFlatFile)) return directFlatFile;

  // New Codex versions write dated rollout files:
  // ~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl
  const matches = [];
  _walkCodexSessions(sessionsDir, 0, (filePath) => {
    if (!filePath.endsWith('.jsonl')) return;
    if (!filePath.includes(sessionId)) return;
    if (!filePath.includes('rollout-')) return;
    try {
      matches.push({ filePath, mtimeMs: statSync(filePath).mtimeMs });
    } catch {
      // ignore unreadable files
    }
  });

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0].filePath;
}

function _walkCodexSessions(dir, depth, onFile) {
  // Keep traversal bounded; Codex session layout is shallow.
  if (depth > 6) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      _walkCodexSessions(p, depth + 1, onFile);
    } else if (entry.isFile()) {
      onFile(p);
    }
  }
}

function _parseCodexEvents(filePath, sessionId) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length === 0) return null;

    // Codex uses two distinct transcript formats across versions:
    // 1) app-server event logs (turn/start, item/completed, ...)
    // 2) rollout logs (session_meta, response_item, turn_context, ...)
    let first = null;
    try {
      first = JSON.parse(lines[0]);
    } catch {
      first = null;
    }
    const looksLikeRollout =
      first?.type === 'session_meta' ||
      first?.type === 'response_item' ||
      first?.type === 'turn_context' ||
      first?.type === 'event_msg';
    if (looksLikeRollout) {
      return _parseCodexRollout(lines, sessionId);
    }

    let model = null;
    const messages = [];
    let lastOutput = '';
    let msgIndex = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const type = event.type || event.method;
      const params = event.params || event;

      // Extract model from thread/started or initialize
      if (type === 'thread.started' || type === 'thread/started') {
        model = params.model || model;
        continue;
      }

      // User input turns
      if (type === 'turn/start' || type === 'turn.start') {
        const input = params.input;
        if (Array.isArray(input)) {
          for (const item of input) {
            if (item.type === 'text' && item.text) {
              messages.push({
                id: `codex-${msgIndex++}`,
                type: 'user',
                content: item.text,
                timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
              });
            }
          }
        }
        continue;
      }

      // Completed agent message items
      if (type === 'item.completed' || type === 'item/completed') {
        const item = params.item || params;

        if (item.type === 'agentMessage' || item.type === 'agent_message') {
          const text = item.text || item.content || '';
          if (text) {
            messages.push({
              id: item.id || `codex-${msgIndex++}`,
              type: 'assistant',
              content: [{ type: 'text', text }],
              timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
            });
            lastOutput = text;
          }
        }

        if (item.type === 'commandExecution' || item.type === 'command_execution') {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.type === 'assistant' && Array.isArray(lastMsg.content)) {
            lastMsg.content.push(
              { type: 'tool_use', id: item.id || `cmd-${msgIndex}`, name: 'command_execution', input: { command: item.command || '' } },
              { type: 'tool_result', toolUseId: item.id || `cmd-${msgIndex}`, content: item.output || item.result || '' },
            );
          } else {
            messages.push({
              id: `codex-${msgIndex++}`,
              type: 'assistant',
              content: [
                { type: 'tool_use', id: item.id || `cmd-${msgIndex}`, name: 'command_execution', input: { command: item.command || '' } },
                { type: 'tool_result', toolUseId: item.id || `cmd-${msgIndex}`, content: item.output || item.result || '' },
              ],
              timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
            });
          }
        }

        if (item.type === 'fileChange' || item.type === 'file_change') {
          const lastMsg = messages[messages.length - 1];
          const block = {
            type: 'tool_use',
            id: item.id || `file-${msgIndex}`,
            name: 'file_change',
            input: { file: item.filePath || item.file || '', action: item.action || 'modify' },
          };
          if (lastMsg && lastMsg.type === 'assistant' && Array.isArray(lastMsg.content)) {
            lastMsg.content.push(block);
          } else {
            messages.push({
              id: `codex-${msgIndex++}`,
              type: 'assistant',
              content: [block],
              timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
            });
          }
        }
      }
    }

    if (lastOutput.length > 500) lastOutput = lastOutput.slice(-500);

    return { model, messages, lastOutput };
  } catch (e) {
    console.error(`[transcripts] Failed to read Codex session ${sessionId.slice(0, 8)}:`, e.message);
    return null;
  }
}

function _parseCodexRollout(lines, sessionId) {
  let model = null;
  const messages = [];
  let lastOutput = '';
  let msgIndex = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = event.timestamp
      ? new Date(event.timestamp).getTime()
      : Date.now();

    if (event.type === 'turn_context') {
      const maybeModel = event.payload?.model;
      if (typeof maybeModel === 'string' && maybeModel.length > 0) {
        model = maybeModel;
      }
      continue;
    }

    if (event.type !== 'response_item') continue;
    const payload = event.payload || {};
    if (payload.type !== 'message') continue;

    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = _extractCodexMessageText(payload.content);
    if (!text) continue;
    if (_isCodexBootstrapMessage(text)) continue;

    if (role === 'user') {
      messages.push({
        id: `codex-${msgIndex++}`,
        type: 'user',
        content: text,
        timestamp: ts,
      });
    } else {
      messages.push({
        id: `codex-${msgIndex++}`,
        type: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: ts,
      });
      lastOutput = text;
    }
  }

  if (lastOutput.length > 500) lastOutput = lastOutput.slice(-500);
  return { model, messages, lastOutput };
}

function _extractCodexMessageText(content) {
  if (typeof content === 'string') {
    const t = content.trim();
    return t.length > 0 ? t : '';
  }
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
    else if (typeof block.input_text === 'string' && block.input_text.trim()) parts.push(block.input_text.trim());
    else if (typeof block.output_text === 'string' && block.output_text.trim()) parts.push(block.output_text.trim());
  }
  return parts.join('\n\n').trim();
}

function _isCodexBootstrapMessage(text) {
  // Ignore session bootstrap payloads that are not part of the user chat.
  return (
    text.startsWith('# AGENTS.md instructions for ') ||
    text.includes('<environment_context>') ||
    text.includes('<permissions instructions>')
  );
}
