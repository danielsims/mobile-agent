# Codex Provider Integration — Handoff Document

## Branch: `feat/codex-provider`

This document details everything implemented so far for integrating OpenAI Codex as a second agent provider in the mobile-agent orchestrator app. The goal is for a developer (or Codex itself) to pick this up and continue from here.

---

## What Was Built

A **provider/adapter (driver) pattern** that makes `AgentSession` transport-agnostic. Instead of having Claude-specific protocol logic baked into `AgentSession`, we now have:

```
AgentSession (transport-agnostic lifecycle manager)
  └── driver: BaseDriver
        ├── ClaudeDriver   (WebSocket - spawns `claude --sdk-url`, CLI connects back)
        └── CodexDriver    (stdio JSONL - spawns `codex app-server`, communicates via stdin/stdout JSON-RPC)
```

Every driver normalizes its native protocol into the same set of events (`init`, `stream`, `message`, `result`, `permission`, etc.), and `AgentSession` subscribes to those events without knowing which driver it's talking to.

---

## Files Created

### `service/src/drivers/BaseDriver.js`
Abstract base class (extends `EventEmitter`) that defines the contract all drivers must implement.

**Methods to implement:**
- `start(agentId, opts)` — Start the agent process/connection
- `stop()` — Gracefully shutdown
- `isReady()` — Whether the transport is connected
- `sendPrompt(text, sessionId)` — Send a user message
- `respondPermission(requestId, behavior, updatedInput)` — Respond to approval request
- `interrupt()` — Abort current task
- `setPermissionMode(mode)` — Optional, change approval policy at runtime

**Events emitted (normalized interface):**
| Event | Payload | Description |
|-------|---------|-------------|
| `init` | `{ sessionId, model, tools, cwd, projectName, gitBranch }` | Agent initialized |
| `stream` | `{ text }` | Token-by-token streaming delta |
| `message` | `{ content: ContentBlock[] }` | Complete message with content blocks |
| `result` | `{ cost, totalCost, usage, duration, isError, sessionId }` | Turn completed |
| `permission` | `{ requestId, toolName, toolInput }` | Approval needed |
| `toolProgress` | `{ toolName, elapsed }` | Tool execution heartbeat |
| `toolResults` | `{ content }` | Tool results (Claude-specific, for merging) |
| `status` | `{ status }` | Status change (running, idle, error, etc.) |
| `error` | `{ message }` | Error occurred |
| `exit` | `{ code, signal }` | Process exited |

**Normalized ContentBlock types:**
```js
TextBlock:       { type: 'text', text }
ToolUseBlock:    { type: 'tool_use', id, name, input }
ToolResultBlock: { type: 'tool_result', toolUseId, content }
ThinkingBlock:   { type: 'thinking', text }
```

### `service/src/drivers/ClaudeDriver.js`
Extracted all Claude-specific logic from the old monolithic `AgentSession`.

**Transport:** `websocket-server`
- Spawns `claude --sdk-url ws://127.0.0.1:PORT/ws/cli/AGENT_ID --output-format stream-json --input-format stream-json --verbose`
- The CLI connects *back* to our WebSocket server
- Bridge calls `driver.attachSocket(ws)` when CLI connects — this is Claude-specific

**Message parsing (NDJSON from CLI):**
| CLI Message Type | Emitted Event |
|------------------|---------------|
| `system` (subtype `init`) | `init` — session_id, model, tools, cwd |
| `stream_event` (content_block_delta) | `stream` — text delta |
| `assistant` | `message` — normalized content blocks |
| `result` | `result` — cost, usage, duration |
| `control_request` (can_use_tool) | `permission` — requestId, toolName, toolInput |
| `tool_progress` | `toolProgress` — toolName, elapsed |
| `user` (tool results) | `toolResults` — raw content for merging |

**Sending messages to CLI:**
- `sendPrompt()` → `{ type: "user", message: { role: "user", content: text }, session_id }`
- `respondPermission()` → `{ type: "control_response", response: { subtype: "success", request_id, response: { behavior, updatedInput } } }`
- `setPermissionMode()` → `{ type: "control_request", request: { subtype: "set_permission_mode", mode } }`

**Key detail:** Has a prompt queue — if the CLI hasn't connected yet when a prompt is sent, it's queued and flushed when `attachSocket()` is called.

### `service/src/drivers/CodexDriver.js`
New driver for OpenAI Codex via the `codex app-server` CLI tool.

**Transport:** `stdio-jsonrpc`
- Spawns `codex app-server` as a child process
- Communicates via stdin/stdout using JSONL (one JSON object per line)
- Uses JSON-RPC 2.0 lite protocol (requests have `method`/`id`/`params`, responses have `id`/`result`/`error`, notifications have `method`/`params` but no `id`)

**CRITICAL: No API key needed.** This uses the user's existing Codex desktop subscription. The `codex` CLI binary handles its own auth through `codex auth login`. We just spawn the binary and talk to it over stdio. Same pattern as Claude — we don't set any API keys, the CLI handles that.

**Initialization handshake:**
```
1. → { method: "initialize", id: 1, params: { clientInfo: { name: "mobile-agent", version: "1.0.0" } } }
2. ← { id: 1, result: { capabilities... } }
3. → { method: "initialized", params: {} }                    // notification, no id
4. → { method: "thread/start", id: 2, params: { model, cwd, approvalPolicy } }
5. ← { id: 2, result: { thread: { id: "thread-xxx" } } }     // now ready for prompts
```

**Sending a user prompt:**
```
→ { method: "turn/start", id: N, params: { threadId, input: [{ type: "text", text: "..." }] } }
```

**Streaming notifications from Codex (no `id`, just `method`):**
| Codex Notification | Emitted Event | Notes |
|-------------------|---------------|-------|
| `turn/started` | `status` → running | Turn begins |
| `item/agentMessage/delta` | `stream` | Token-by-token text streaming |
| `item/commandExecution/outputDelta` | `toolProgress` | Command output streaming |
| `item/started` | (logged) | Work unit begins |
| `item/completed` (agentMessage) | `message` | Full text → TextBlock |
| `item/completed` (commandExecution) | `message` | → ToolUseBlock + ToolResultBlock pair |
| `item/completed` (fileChange) | `message` | → ToolUseBlock + ToolResultBlock pair |
| `item/completed` (reasoning) | `message` | → ThinkingBlock |
| `item/commandExecution/requestApproval` | `permission` | Command needs user approval |
| `item/fileChange/requestApproval` | `permission` | File change needs user approval |
| `turn/completed` | `result` + `status` → idle | Turn ends |
| `turn/failed` | `result` (isError) + `error` | Turn failed |
| `turn/diff/updated` | (no-op currently) | File diffs |
| `turn/plan/updated` | (no-op currently) | Agent's plan |

**Permission/Approval flow:**
1. Codex sends `item/commandExecution/requestApproval` with `{ itemId, parsedCmd, reason }`
2. We generate a UUID `requestId`, map `itemId → requestId` in `_approvalRequests` Map
3. Emit `permission` event with our `requestId`
4. When user responds, we look up `itemId` from `requestId`, send:
   ```
   → { method: "item/approve", id: N, params: { itemId, decision: "accept" | "decline" } }
   ```

**Permission mode mapping:**
| Our Generic Mode | Codex `approvalPolicy` |
|-----------------|----------------------|
| `bypassPermissions` | `never` (never ask) |
| `default` | `on-request` (ask each time) |

**RPC implementation details:**
- Each request gets an auto-incrementing `id` and a 30-second timeout timer
- Pending RPCs tracked in `_pendingRpc` Map: `id → { resolve, reject, timer }`
- When response arrives, timer is cleared and promise resolved/rejected
- On `stop()`, all pending RPCs are rejected and timers cleared via `_rejectAllPending()`
- On process exit, same cleanup happens

**Codex binary lookup:**
Checks in order: `CODEX_PATH` env var → `~/.local/bin/codex` → `/usr/local/bin/codex` → falls back to `codex` (PATH lookup)

**Model:** Defaults to `process.env.CODEX_MODEL || 'codex-mini-latest'`

### `service/src/drivers/index.js`
Driver registry with factory function.

```js
const DRIVER_MAP = { claude: ClaudeDriver, codex: CodexDriver };

export function createDriver(type) { /* returns new driver instance */ }
export function getSupportedTypes() { /* returns ['claude', 'codex'] */ }
```

To add a new driver (e.g., OpenCode), just:
1. Create `OpenCodeDriver.js` extending `BaseDriver`
2. Add `opencode: OpenCodeDriver` to `DRIVER_MAP`

---

## Files Modified

### `service/src/AgentSession.js` (rewritten)
Was a monolithic class with Claude-specific NDJSON parsing baked in. Now transport-agnostic.

**Key changes:**
- Constructor: `new AgentSession(id, type)` → calls `createDriver(type)` to get the right driver
- `_bindDriverEvents()` — subscribes to all normalized driver events and:
  - Updates session state (messageHistory, pendingPermissions, cost, etc.)
  - Broadcasts to mobile clients via `_onBroadcast` callback
- `spawn()` → `driver.start(this.id, opts)`
- `sendPrompt(text)` → `driver.sendPrompt(text, this.sessionId)`
- `respondToPermission(requestId, behavior, updatedInput)` → `driver.respondPermission(...)`
- `attachCliSocket(ws)` → checks if driver has `attachSocket` method (only Claude does); others close with 4005
- `destroy()` → `driver.stop()`

**What AgentSession still manages (not delegated to drivers):**
- Message history (append, trim to MAX_HISTORY=200)
- Pending permissions Map
- Cost tracking (totalCost, contextUsedPercent, outputTokens)
- Session naming (from first prompt)
- Last output tracking (rolling buffer for card previews)
- Git branch change detection (after each turn completes)
- Broadcasting to mobile clients

### `service/src/transcripts.js` (modified)
Added Codex transcript reading support.

**Changes:**
- `readTranscript()` switch statement now includes `case 'codex':`
- Added `_readCodexTranscript(sessionId, cwd)` — looks for session events at:
  - `~/.codex/sessions/<sessionId>/events.jsonl`
  - `~/.codex/sessions/<sessionId>.jsonl` (fallback)
- Added `_parseCodexEvents(filePath, sessionId)` — parses JSONL event log:
  - `thread.started` / `thread/started` → extracts model
  - `turn/start` / `turn.start` → extracts user input messages
  - `item.completed` / `item/completed` → extracts assistant messages, command executions, file changes
  - Handles both `camelCase` and `snake_case` variants (Codex may use either)

---

## Files NOT Modified (already compatible)

### `service/src/bridge.js`
Already works with the new driver pattern:
- `_handleCreateAgent(msg, ws)` already passes `msg.agentType` to `AgentSession`
- `/ws/cli/:agentId` endpoint calls `session.attachCliSocket(ws)` which now delegates to driver
- The CLI endpoint is only used by `ClaudeDriver` — `CodexDriver` doesn't need it (stdio-based)

### `app/state/types.ts`
Already has `AgentType = 'claude' | 'codex' | 'opencode' | (string & {})` — no changes needed on the app side for type support.

---

## Test Files Created

### `service/src/__tests__/drivers.test.js` (~65 tests)
Comprehensive unit tests for the driver layer:

- **BaseDriver contract tests** — verifies abstract methods throw, isReady works, normalizeContentBlocks works
- **Driver registry tests** — createDriver returns correct types, throws for unknown, getSupportedTypes works
- **ClaudeDriver tests:**
  - Socket attachment and readiness
  - All message types: init, streaming, assistant (with content block normalization), result, permissions, tool_progress, user/tool results, NDJSON multi-line parsing
  - Sending messages (sendPrompt, respondPermission)
  - Permission mode sending
  - Cleanup (stop closes socket and kills process)
- **CodexDriver tests:**
  - Turn lifecycle (started → completed)
  - Streaming (agentMessage/delta)
  - Item completed (agentMessage, commandExecution, fileChange, reasoning)
  - Permission requests and responses
  - JSON-RPC communication (request/response with IDs)
  - Prompt sending (turn/start)
  - Permission response (item/approve with decision mapping)
  - Cleanup (stop rejects pending RPCs and kills process)
  - Permission mode mapping (bypassPermissions → never, default → on-request)
  - stdout JSONL buffering/parsing algorithm
- **Cross-driver behavioral consistency tests:**
  - Both drivers emit normalized message format
  - Both emit tool_use + tool_result for tool execution
  - Both emit stream events for streaming
  - Both emit permission events for approvals
  - Both emit result events for turn completion

### `service/src/__tests__/agentSession.test.js` (~48 tests)
Tests `AgentSession` with real driver instances, emitting events directly on `session.driver`:

- Constructor creates correct driver type
- Init events update session state and trigger broadcasts
- Stream events accumulate content and trigger broadcasts
- Message events append to history and trigger broadcasts
- Result events track cost/usage and trigger broadcasts
- Permission events store in pendingPermissions Map
- Tool results merge into preceding assistant message
- Status normalization (connected → idle when initialized)
- Error and exit handling
- Tool progress forwarding
- sendPrompt() delegates to driver and tracks session name
- respondToPermission() delegates to driver and cleans up pending
- loadTranscript() populates from stored sessions
- getSnapshot() returns complete state
- getHistory() returns messages and pending permissions
- destroy() calls driver.stop() and cleans up

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Mobile App (React Native)                │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ WebSocket Client → sends: createAgent { agentType }     ││
│  │                  → sends: sendMessage { agentId, text } ││
│  │                  → sends: respondPermission { ... }     ││
│  │                  ← receives: streamChunk, message, etc. ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket (wss:// via Cloudflare Tunnel)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     Bridge (bridge.js)                        │
│  /ws/mobile ← mobile clients                                │
│  /ws/cli/:agentId ← Claude CLI connects back (Claude only)  │
│                                                              │
│  agents Map: agentId → AgentSession                          │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                  AgentSession                                │
│  • Message history, pending permissions, cost tracking       │
│  • Broadcasts to mobile clients                              │
│  • Delegates protocol to this.driver                         │
│                                                              │
│  this.driver = createDriver(type)                            │
│       │                                                      │
│       ├─ ClaudeDriver (type='claude')                        │
│       │   Transport: websocket-server                        │
│       │   Spawns: claude --sdk-url ws://...                  │
│       │   Protocol: NDJSON over WebSocket                    │
│       │   CLI connects TO our server                         │
│       │                                                      │
│       └─ CodexDriver (type='codex')                          │
│           Transport: stdio-jsonrpc                           │
│           Spawns: codex app-server                           │
│           Protocol: JSON-RPC 2.0 over stdin/stdout JSONL     │
│           We communicate directly via pipes                  │
└──────────────────────────────────────────────────────────────┘
```

---

## How Claude vs Codex Transports Differ

| Aspect | Claude | Codex |
|--------|--------|-------|
| Binary | `claude` CLI | `codex` CLI |
| Launch command | `claude --sdk-url ws://... --output-format stream-json` | `codex app-server` |
| Transport | WebSocket (CLI connects to our server) | stdio (stdin/stdout pipes) |
| Protocol | NDJSON (one JSON per WebSocket frame) | JSON-RPC 2.0 lite (one JSON per line) |
| Connection setup | Async — CLI spawns, then connects back; bridge calls `attachSocket()` | Sync — process spawns, we immediately start writing to stdin |
| Request/response | Fire-and-forget (no request IDs for prompts) | JSON-RPC with IDs, timeouts, promise tracking |
| Prompt sending | `{ type: "user", message: { role: "user", content } }` | `{ method: "turn/start", id: N, params: { threadId, input: [...] } }` |
| Permission flow | `control_request` → `control_response` with `request_id` | `item/*/requestApproval` → `item/approve` with `itemId` |
| Session resume | `--resume SESSION_ID` flag on spawn | `thread/resume { threadId }` RPC call |
| Cost tracking | `result` message has `total_cost_usd` | Not reported by app-server (set to 0) |
| Auth | Handled by CLI (existing Claude login) | Handled by CLI (existing Codex login via `codex auth`) |

---

## What Still Needs To Be Done

### 1. Live Smoke Testing (HIGH PRIORITY)
The Codex driver was implemented based on documentation and the `codex app-server` protocol spec. The actual JSON-RPC message shapes need validation against a real running `codex app-server` instance.

**To test:**
1. Ensure `codex` is installed globally and you're logged in (`codex auth login`)
2. Start the service: `cd service && npm start`
3. Connect the mobile app
4. Create a Codex agent from the mobile app (the app should send `createAgent { agentType: 'codex' }`)
5. Send it a prompt and observe:
   - Does the `initialize` → `initialized` → `thread/start` handshake complete?
   - Do streaming deltas arrive as `item/agentMessage/delta`?
   - Do completed items arrive as `item/completed`?
   - Do approval requests arrive as `item/commandExecution/requestApproval`?

**Things that might need adjustment after live testing:**
- Exact field names in JSON-RPC params (e.g., `parsedCmd.cmd` vs `parsedCmd.command`)
- Thread start response shape (e.g., `result.thread.id` vs `result.threadId`)
- Whether `turn/start` expects the `threadId` in params or not
- Whether `item/approve` is the correct method name for approval responses
- How Codex handles the `approvalPolicy` in `thread/start`
- Whether Codex sends `turn/completed` or `turn/finished`

### 2. Mobile App UI — Agent Type Picker
The mobile app needs UI to let the user choose which agent type to create:
- The "+ New Agent" button should present options (Claude, Codex)
- The `createAgent` WebSocket message already supports `agentType` field
- Agent cards should show the agent type (small badge/icon)

### 3. Codex Session Storage Path Verification
`transcripts.js` assumes Codex stores sessions at `~/.codex/sessions/<threadId>/events.jsonl`. This path needs verification — the actual location may differ depending on Codex version.

### 4. OpenCode Driver (Future)
The third driver for OpenCode (`opencode serve` HTTP/REST). Structure is already planned in `PLAN.md`. Would follow the same pattern:
1. Create `service/src/drivers/OpenCodeDriver.js` extending `BaseDriver`
2. Transport: `http-client` — spawns `opencode serve --port PORT`, connects as HTTP client
3. Add to `DRIVER_MAP` in `drivers/index.js`

### 5. Codex-Specific Features (Optional Enhancements)
- `turn/diff/updated` — could surface file diffs in the mobile UI
- `turn/plan/updated` — could show agent's plan in a dedicated UI section
- `turn/steer` — could allow the user to steer an active turn without waiting
- `thread/list` — could show all Codex threads for session browsing

---

## Key Design Decisions & Rationale

### Why `codex app-server` (stdio) and not the OpenAI API?
**The user explicitly wants to use their existing Codex desktop subscription**, not pay OpenAI API pricing. The `codex` CLI binary handles auth through `codex auth login` — same pattern as Claude. We never set or need an `OPENAI_API_KEY`. The `codex app-server` subcommand was specifically designed for programmatic integration.

### Why stdio instead of WebSocket for Codex?
`codex app-server` defaults to stdio JSONL. It has an experimental `--listen ws://` flag for WebSocket mode, but stdio is the stable, documented path. If the WebSocket mode matures, switching would be minimal — just change the spawn args and swap stdin/stdout handlers for WebSocket message handlers.

### Why `attachSocket()` is Claude-specific
Claude's transport is asymmetric — we spawn the CLI, but *it* connects *to us* via WebSocket. So the bridge needs to hand that incoming connection to the driver. Codex (and future drivers) don't have this pattern — they communicate directly via stdio/HTTP. The `attachCliSocket()` method in AgentSession checks `typeof driver.attachSocket === 'function'` to handle this cleanly.

### Why events instead of callbacks
Drivers extend `EventEmitter` and emit normalized events. This allows:
- Multiple listeners (AgentSession + potential logging/debugging)
- Loose coupling (driver doesn't know about AgentSession)
- Clean async flow (events fire as data arrives, no callback hell)
- Easy testing (emit events directly on the driver in tests)

---

## Running the Tests

```bash
cd service
npm test         # vitest run (single run)
npm run test:watch  # vitest (watch mode)
```

Test files:
- `service/src/__tests__/bridge.test.js` — existing bridge/auth tests
- `service/src/__tests__/drivers.test.js` — driver unit tests
- `service/src/__tests__/agentSession.test.js` — AgentSession integration tests

---

## Quick Reference: Adding a New Driver

1. Create `service/src/drivers/NewDriver.js`:
```js
import { BaseDriver } from './BaseDriver.js';

export class NewDriver extends BaseDriver {
  constructor() {
    super('New Agent', 'transport-type');
  }

  async start(agentId, opts) {
    // Spawn process, set up listeners
    // When ready: this._ready = true;
    // Emit: this.emit('init', { sessionId, model, tools, cwd });
  }

  async sendPrompt(text, sessionId) {
    // Send user message via your transport
    // Streaming: this.emit('stream', { text: delta });
    // Complete: this.emit('message', { content: [{ type: 'text', text }] });
    // Done: this.emit('result', { cost, usage, duration, isError, sessionId });
  }

  async respondPermission(requestId, behavior, updatedInput) {
    // Send approval/denial via your transport
  }

  async stop() {
    // Kill process, clean up
    this._ready = false;
  }
}
```

2. Register in `service/src/drivers/index.js`:
```js
import { NewDriver } from './NewDriver.js';
const DRIVER_MAP = { claude: ClaudeDriver, codex: CodexDriver, newtype: NewDriver };
```

3. That's it. `AgentSession` will automatically use it when `type='newtype'` is passed.
