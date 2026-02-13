# OpenCode Driver Implementation Plan

## Overview

Add a new `OpenCodeDriver` adapter to support OpenCode as an agent type alongside the existing Claude and Codex adapters. OpenCode supports the Agent Client Protocol (ACP) via `opencode acp`, which provides a **stdio JSON-RPC 2.0** transport using nd-JSON — the same pattern as Codex's `codex app-server`. This makes the OpenCodeDriver structurally very close to CodexDriver.

---

## Transport Architecture

| | Claude | Codex | OpenCode |
|---|---|---|---|
| **Transport** | WebSocket (CLI → us) | stdio JSON-RPC | stdio JSON-RPC (ACP) |
| **Process mgmt** | `spawn('claude', ['--sdk-url', ...])` | `spawn('codex', ['app-server'])` | `spawn('opencode', ['acp'])` |
| **Streaming** | NDJSON over WS frames | JSONL over stdout | nd-JSON over stdout (ACP) |
| **Session model** | `--resume` flag | `thread/start` RPC | `session/new` RPC |
| **Session resume** | `--resume` flag | `thread/resume` RPC | `session/load` RPC |
| **Send prompt** | WS `user` message | `turn/start` RPC | `session/prompt` RPC |
| **Interrupt** | SIGINT to process | `turn/interrupt` RPC | `session/cancel` RPC |
| **Permissions** | `control_request` / `control_response` | `item/*/requestApproval` | `session/request_permission` (agent→client) |

---

## ACP Protocol Reference

### Lifecycle (maps to CodexDriver pattern)

```
1. spawn('opencode', ['acp'])          — subprocess over stdio
2. → initialize                         — capabilities negotiation
3. ← initialize response                — agent capabilities + info
4. → session/new { cwd }               — create session
5. ← session/new response { sessionId } — session ready
6. → session/prompt { sessionId, prompt: [...] }  — send user message
7. ← session/update notifications       — streaming content, tool calls, etc.
8. ← session/request_permission         — agent asks for tool approval (reverse RPC)
9. → session/request_permission response — client responds allow/deny
10. ← session/prompt response { stopReason } — turn complete
```

### ACP Notification Types (via `session/update`)

| ACP Update Type | Our Driver Event | Mapping |
|---|---|---|
| `agent_message_chunk` | `'stream'` | Extract text content blocks |
| `agent_thought_chunk` | `'message'` (thinking) | Map to `{ type: 'thinking', text }` |
| `tool_call` (pending/in_progress) | `'message'` (tool_use) | Map to `{ type: 'tool_use', id, name, input }` |
| `tool_call_update` (completed) | `'message'` (tool_result) | Map to `{ type: 'tool_result', toolUseId, content }` |
| `tool_call_update` (failed) | `'message'` (tool_result) | Map error to tool_result |
| `plan` | — | Log only (not surfaced in current UI) |

### ACP Permission Flow (reverse RPC — agent calls client)

```json
// Agent → Client (JSON-RPC request WITH id)
{
  "jsonrpc": "2.0",
  "id": "perm-1",
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess-1",
    "options": [
      { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
      { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
      { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
    ]
  }
}

// Client → Agent (JSON-RPC response)
{ "jsonrpc": "2.0", "id": "perm-1", "result": { "optionId": "allow-once" } }
```

### ACP Agent-to-Client Calls (reverse RPC)

The agent may also call the client for file/terminal operations. We respond to these:

| Method | Purpose | Our Response |
|---|---|---|
| `fs/read_text_file` | Agent wants to read a file | Read and return content |
| `fs/write_text_file` | Agent wants to write a file | Write and confirm |
| `terminal/create` | Agent wants to run a command | Execute and return |
| `terminal/output` | Agent wants command output | Return buffered output |
| `terminal/wait_for_exit` | Agent waits for command | Wait and return exit code |
| `terminal/kill` | Agent kills a command | Kill process |
| `terminal/release` | Agent releases terminal | Cleanup |

**Note:** These are the same pattern as CodexDriver's `isServerRequest` handling — agent sends a JSON-RPC request with an `id`, we respond with `_rpcRespond(id, result)`.

---

## Known Limitations (ACP vs HTTP+SSE)

| Feature | ACP | Impact |
|---|---|---|
| Token usage / cost | Not in ACP spec | Same as Codex — `cost: 0` in result events |
| Model enumeration | Not in ACP spec | Handled separately in `models.js` (spawn temp process) |
| `/undo`, `/redo` | Not supported via ACP | Minor — not used in mobile app |
| Session delete/fork/share | Not in ACP spec | Not needed for current mobile app |

These are the same trade-offs we already accept for Codex.

---

## Files to Create / Modify

### 1. `service/src/drivers/OpenCodeDriver.js` (NEW)

The core driver implementation. Extends `BaseDriver` with `transportType: 'stdio-jsonrpc'`.

Structurally mirrors CodexDriver with ACP-specific method names.

```
findOpenCode()        — locate binary (check common paths, fallback to 'opencode')
```

**Constructor state:**
```javascript
this._process = null;
this._agentId = null;
this._sessionId = null;
this._cwd = null;
this._rpcId = 0;
this._pendingRpc = new Map();      // id → { resolve, reject, timer }
this._buffer = '';                  // incomplete line buffer for stdout
this._initialized = false;
this._currentStreamContent = '';
this._approvalRequests = new Map(); // requestId → { rpcRequestId }
```

**`start(agentId, opts)`**
- Detect git branch from `cwd`
- Spawn `opencode acp` with `stdio: ['pipe', 'pipe', 'pipe']`
- Wire up stdout JSONL parsing (same buffer logic as CodexDriver)
- Wire up stderr logging, exit/error handlers
- Call `_initialize(cwd, gitBranch, resumeSessionId)`

**`_initialize(cwd, gitBranch, resumeSessionId)`**
- Send `initialize` request with `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true }, clientInfo: { name: 'mobile-agent', version: '1.0.0' } }`
- If `resumeSessionId`: send `session/load` with `{ sessionId: resumeSessionId }`
- Else: send `session/new` with `{ cwd }`
- Store `_sessionId` from response
- Set `_ready = true`
- Emit `'init'` with `{ sessionId, model, tools: [], cwd, projectName, gitBranch }`

**`_handleMessage(msg)`**
Big switch on `msg.method`:
- Detect `isServerRequest` (has `id` + `method`, no `result`/`error`) — same pattern as CodexDriver
- Handle RPC responses (match pending `_rpcId`)
- Handle `session/update` notifications → parse update type → emit events
- Handle `session/request_permission` (reverse RPC) → emit `'permission'`, store `rpcRequestId`
- Handle `fs/read_text_file`, `terminal/create`, etc. (reverse RPC) → respond appropriately

**`sendPrompt(text, sessionId)`**
- Send `session/prompt` RPC with `{ sessionId: this._sessionId, prompt: [{ type: 'text', text }] }`
- The prompt call returns when the turn completes (with `stopReason`)
- Streaming happens via `session/update` notifications during the turn

**`respondPermission(requestId, behavior, updatedInput)`**
- Look up `rpcRequestId` from `_approvalRequests`
- Send `_rpcRespond(rpcRequestId, { optionId: behavior === 'allow' ? 'allow-once' : 'reject-once' })`

**`interrupt()`**
- Send `session/cancel` RPC with `{ sessionId: this._sessionId }`

**`setPermissionMode(mode)`**
- Map `'bypassPermissions'` → auto-approve all `session/request_permission` calls
- Map `'default'` → forward to user

**`stop()`**
- Same as CodexDriver: `_ready = false`, `_rejectAllPending`, kill process

### 2. `service/src/drivers/index.js` (MODIFY)

```javascript
import { OpenCodeDriver } from './OpenCodeDriver.js';

const DRIVER_MAP = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  opencode: OpenCodeDriver,
};
```

### 3. `service/src/models.js` (MODIFY)

Add `listOpenCodeModels()`:
- Spawn `opencode acp`, run `initialize` handshake
- ACP doesn't have a `model/list` method, so we try a config-option approach:
  - After init, check if agent capabilities expose model options
  - If not available, return empty list (user picks model via OpenCode's own config)
- Add `opencode` branch to `listModelsForAgentType()`
- Same timeout/cleanup pattern as `listCodexModels()`

### 4. `service/src/__tests__/drivers.test.js` (MODIFY)

Add comprehensive tests following the exact patterns of existing Claude/Codex tests.

**Driver Registry Tests:**
- `creates OpenCode driver` — verify `name === 'OpenCode'`, `transportType === 'stdio-jsonrpc'`
- `getSupportedTypes()` includes `'opencode'`

**OpenCodeDriver Tests:**

1. **Message handling (session lifecycle)**
   - `emits running status on session/update with tool_call`
   - `emits result and idle when session/prompt returns`
   - `emits error for failed prompt returns`

2. **Message handling (streaming)**
   - `emits stream events for agent_message_chunk updates`
   - `accumulates stream content for final message`

3. **Message handling (item completed)**
   - `emits message for completed agent text`
   - `emits tool_use + tool_result for tool_call + tool_call_update`
   - `emits thinking block for agent_thought_chunk`

4. **Message handling (permissions)**
   - `emits permission for session/request_permission (reverse RPC)`
   - `responds with allow-once for allowed permissions`
   - `responds with reject-once for denied permissions`

5. **Message handling (agent→client reverse RPC)**
   - `responds to fs/read_text_file requests`
   - `responds to terminal/create requests`

6. **JSON-RPC communication**
   - `sends JSON-RPC requests with incrementing IDs`
   - `resolves RPC requests on response`
   - `rejects RPC requests on error response`
   - `sends notifications without ID`

7. **Prompt sending**
   - `sends session/prompt via RPC when ready`
   - `emits error when not ready`

8. **Interrupt**
   - `sends session/cancel on interrupt`
   - `handles interrupt when no active session`

9. **Cleanup**
   - `kills process and clears state on stop`
   - `rejects pending RPC requests on stop`

10. **stdout JSONL parsing**
    - `handles partial lines across data chunks via buffer logic`

**Cross-Driver Consistency (extend existing section):**
- Update all existing cross-driver tests to include OpenCode as third driver
- `all three drivers normalize agent messages to { content: [{type: "text", text}] }`
- `all three drivers emit stream events with {text} shape`
- `all three drivers emit permission events with {requestId, toolName, toolInput}`
- `all three drivers emit result events with {cost, usage, isError, sessionId}`

**AgentSession Integration:**
- `createDriver('opencode')` returns OpenCodeDriver instance
- All drivers extend BaseDriver (existing loop already covers new entries)

### 5. `package.json` (MODIFY)

No new npm dependency needed. ACP is raw JSON-RPC over stdio — same as Codex. We handle the protocol ourselves with the same `_rpcRequest`/`_rpcNotify`/`_rpcRespond` helpers.

---

## Implementation Order

1. **Create `OpenCodeDriver.js`** — implement the class (model after CodexDriver)
2. **Register in `drivers/index.js`** — add to `DRIVER_MAP`
3. **Add model discovery in `models.js`** — `listOpenCodeModels()`
4. **Write tests in `drivers.test.js`** — full test suite
5. **Run tests** — ensure all pass (existing + new)

---

## Key Design Decisions

### stdio JSON-RPC via ACP (not HTTP+SSE)

OpenCode supports two programmatic interfaces:
1. `opencode serve` + `@opencode-ai/sdk` — HTTP + SSE
2. `opencode acp` — stdio JSON-RPC (Agent Client Protocol)

We use ACP because:
- **Consistency**: Same `stdio-jsonrpc` transport as Codex. Same buffer logic, same RPC helpers, same process management.
- **No dependencies**: No `@opencode-ai/sdk` needed. Raw JSON-RPC, same as CodexDriver.
- **No server management**: No HTTP port, no SSE reconnection, no auth tokens. The subprocess IS the transport.
- **Simpler lifecycle**: Process start/stop mirrors CodexDriver exactly.

Trade-offs accepted (same as Codex):
- No token usage/cost data in ACP (emit `cost: 0`, same as Codex)
- No model enumeration via protocol (handle in `models.js` separately)
- `/undo` and `/redo` not supported via ACP (not used in mobile app)

### Binary Discovery

Same pattern as Claude/Codex — check common paths, fallback to bare command:
```javascript
function findOpenCode() {
  const paths = [
    process.env.OPENCODE_PATH,          // explicit override
    `${process.env.HOME}/.local/bin/opencode`,
    '/usr/local/bin/opencode',
  ].filter(Boolean);
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return 'opencode';                    // rely on PATH
}
```

No environment variables are required — `opencode acp` works out of the box.

### Reverse RPC Handling

ACP is bidirectional — the agent can call the client for file/terminal operations. This is the same pattern CodexDriver already handles for `isServerRequest` messages. We detect server requests (has `id` + `method`, no `result`/`error`) and respond with `_rpcRespond(id, result)`.

For file operations (`fs/read_text_file`, `fs/write_text_file`), the driver reads/writes using Node.js `fs` and responds. For terminal operations, we can either execute commands directly or respond with an unsupported error (same pattern as CodexDriver's `item/tool/call` handler).

### Permission Mapping

| Our Mode | ACP Behavior |
|---|---|
| `'default'` | Forward `session/request_permission` to user |
| `'bypassPermissions'` | Auto-respond with `allow_once` to all permission requests |

---

## Testing Strategy

Tests mock the child process (same as CodexDriver tests) — create a mock process with `stdin.write`, `stdout` EventEmitter, `kill` spy. Feed nd-JSON lines into stdout to simulate ACP messages. Verify correct event emission and RPC responses.

```javascript
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}
```

No SDK mocking needed — same raw process mocking as CodexDriver tests.
