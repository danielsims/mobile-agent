import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('readTranscript (codex)', () => {
  let tempHome;
  let prevHome;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'mobile-agent-transcripts-'));
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    vi.resetModules();
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function readTranscript(type, sessionId, cwd = null) {
    process.env.HOME = tempHome;
    vi.resetModules();
    const mod = await import('../transcripts.js');
    return mod.readTranscript(type, sessionId, cwd);
  }

  it('reads dated rollout transcripts and restores user/assistant messages', async () => {
    const sid = '019c4c40-e20a-7aa3-9cdb-d4584d0eee23';
    const dir = join(tempHome, '.codex', 'sessions', '2026', '02', '11');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-02-11T20-30-46-${sid}.jsonl`);

    const lines = [
      JSON.stringify({
        timestamp: '2026-02-11T10:30:46.553Z',
        type: 'session_meta',
        payload: { id: sid, cwd: '/tmp/project' },
      }),
      JSON.stringify({
        timestamp: '2026-02-11T10:30:47.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/project' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-11T10:30:48.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.3-codex' },
      }),
      JSON.stringify({
        timestamp: '2026-02-11T10:30:49.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Please fix the failing test.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-11T10:30:50.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I updated the test and it now passes.' }],
        },
      }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    const transcript = await readTranscript('codex', sid, '/tmp/project');
    expect(transcript).toBeTruthy();
    expect(transcript.model).toBe('gpt-5.3-codex');
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0].type).toBe('user');
    expect(transcript.messages[0].content).toBe('Please fix the failing test.');
    expect(transcript.messages[1].type).toBe('assistant');
    expect(transcript.messages[1].content[0].text).toBe('I updated the test and it now passes.');
  });

  it('prefers the newest rollout file when multiple matches exist', async () => {
    const sid = '019c4c40-e20a-7aa3-9cdb-d4584d0eee23';
    const oldDir = join(tempHome, '.codex', 'sessions', '2026', '02', '10');
    const newDir = join(tempHome, '.codex', 'sessions', '2026', '02', '11');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    const oldFile = join(oldDir, `rollout-2026-02-10T20-30-46-${sid}.jsonl`);
    const newFile = join(newDir, `rollout-2026-02-11T20-30-46-${sid}.jsonl`);

    writeFileSync(oldFile, [
      JSON.stringify({ timestamp: '2026-02-10T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
      JSON.stringify({ timestamp: '2026-02-10T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'older' }] } }),
    ].join('\n') + '\n');

    writeFileSync(newFile, [
      JSON.stringify({ timestamp: '2026-02-11T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
      JSON.stringify({ timestamp: '2026-02-11T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'newer' }] } }),
    ].join('\n') + '\n');

    utimesSync(oldFile, new Date('2026-02-10T10:00:00.000Z'), new Date('2026-02-10T10:00:00.000Z'));
    utimesSync(newFile, new Date('2026-02-11T10:00:00.000Z'), new Date('2026-02-11T10:00:00.000Z'));

    const transcript = await readTranscript('codex', sid);
    expect(transcript).toBeTruthy();
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0].content[0].text).toBe('newer');
  });

  it('still reads legacy app-server event logs', async () => {
    const sid = 'thread-legacy-123';
    const dir = join(tempHome, '.codex', 'sessions', sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'events.jsonl');

    const lines = [
      JSON.stringify({ type: 'thread/started', params: { model: 'gpt-5.2-codex' } }),
      JSON.stringify({ type: 'turn/start', params: { input: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg-1', text: 'Hi there' } } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    const transcript = await readTranscript('codex', sid);
    expect(transcript).toBeTruthy();
    expect(transcript.model).toBe('gpt-5.2-codex');
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0].type).toBe('user');
    expect(transcript.messages[0].content).toBe('Hello');
    expect(transcript.messages[1].type).toBe('assistant');
    expect(transcript.messages[1].content[0].text).toBe('Hi there');
  });
});
