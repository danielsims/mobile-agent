# Mobile Agent: Multi-Agent Orchestrator

## Context

The Mobile Agent app currently supports a single Claude Code session streamed from Mac to phone via WebSocket. The goal is to transform it into a **multi-agent orchestrator** where you can see 5+ agent conversations running simultaneously in a grid layout, easily swap between them, and eventually support different agent types (Codex, OpenCode, etc.).

**Key discovery:** Claude Code has a hidden `--sdk-url` flag (used by [The Vibe Companion](https://github.com/The-Vibe-Company/companion)) that makes the CLI connect TO a WebSocket server with structured NDJSON messages instead of running in a terminal. This eliminates our fragile PTY output parsing and gives us:
- Structured JSON messages for all tool calls, permissions, and streaming
- Token-by-token streaming via `stream_event` messages
- Proper permission flow with `control_request`/`control_response`
- Session management, cost tracking, and token usage for free
- Clean multi-turn without re-spawning processes

We'll adopt this approach, which means largely rewriting `service/src/launcher.js` into a proper WebSocket bridge.

## Security Model (First Principle: Secure by Default)

This app gives a phone remote control over coding agents that can execute commands on your machine. Security is non-negotiable.

### Threat Model
- **Tunnel URL discovered** — someone finds/guesses the Cloudflare tunnel URL
- **Token intercepted** — token leaked via logs, shoulder surfing, or network inspection
- **Phone lost/stolen** — attacker has physical access to the phone
- **MITM attack** — attacker intercepts traffic between phone and server

### Transport Security
- **Cloudflare Tunnel (WSS)** — all traffic encrypted via TLS, no open ports on your machine
- **Named tunnel** — use `cloudflared tunnel create` for a persistent, stable URL instead of random one. Avoids needing new QR code on every restart. Configured once.
- Server listens on `localhost` only — never binds to `0.0.0.0`

### Authentication (Layered)

**Layer 1: Initial Pairing (one-time, in-person)**
- Server generates a 256-bit secret + Ed25519 keypair on first run, persisted to `~/.mobile-agent/`
- QR code contains: `{ tunnelUrl, pairingToken (one-time-use), serverPublicKey }`
- Phone scans QR → sends its own public key back → server stores it as an authorized device
- Pairing token is immediately invalidated after use — can never be reused
- To pair a new device: explicit server-side command (`npm run pair`)

**Layer 2: Session Auth (every connection)**
- Phone generates a signed challenge: `{ timestamp, nonce, deviceId }` signed with its private key
- Server verifies signature with stored device public key
- Rejects if timestamp is >30s old (prevents replay attacks)
- No static tokens in URLs — cryptographic proof of device identity

**Layer 3: Credential Storage**
- **Phone:** `expo-secure-store` (iOS Keychain / Android Keystore) instead of AsyncStorage
  - Private key, device ID, tunnel URL stored in hardware-backed secure storage
  - Encrypted at rest, protected by device biometrics
- **Server:** `~/.mobile-agent/authorized_devices.json` with device public keys
  - Private key stored with restricted file permissions (0600)

### Authorization & Access Control
- **Per-agent permission mode** — each agent can be set to `auto` or `confirm`
- **Audit log** — all actions logged to `~/.mobile-agent/audit.log` (who connected, what prompts sent, what permissions approved)
- **Connection notifications** — server logs and optionally shows desktop notification when a device connects
- **Device revocation** — `npm run revoke <deviceId>` removes a device's access instantly
- **Max concurrent devices** — configurable limit (default: 3)

### Defense in Depth
- **Rate limiting** — max 5 failed auth attempts per minute per IP, then block for 15 min
- **Idle timeout** — WebSocket disconnected after 30 min inactivity (configurable)
- **No sensitive data in URLs** — auth is via WebSocket message, not query params
- **Agent sandboxing** — agents respect their own permission modes (Claude's `--permission-mode`, Codex's `approvalPolicy`)

### Implementation Phases
- **Phase 1** includes: named tunnel, signed challenge auth, expo-secure-store, audit logging
- **Phase 5** adds: per-agent permission modes in the driver layer
- **Future:** device management UI on the phone (list paired devices, revoke access)

## Architecture Decisions

- **`--sdk-url` WebSocket bridge** — server accepts CLI connections on `/ws/cli/:agentId`, mobile connects on `/ws/mobile`; server routes between them
- **Single mobile WebSocket, multiplexed** — all messages tagged with `agentId` (one tunnel, one auth)
- **Transport-agnostic driver layer** — different agents use different transports:
  - Claude Code: `--sdk-url` WebSocket (CLI connects TO server, NDJSON)
  - OpenCode: `opencode serve` HTTP/REST server (our server connects TO it as a client)
  - Codex: `codex app-server` JSON-RPC over stdio/WebSocket (same pattern as Claude — CLI is the server, we're the client)
  - Each driver normalizes its transport into a common message interface
- **Provider/adapter pattern** — `AgentSession` doesn't care about transport; it calls `driver.sendPrompt()` / `driver.respondPermission()` and receives normalized callbacks
- **useReducer + Context** for app state (no new dependencies)
- **State-based navigation** (keep current pattern, no React Navigation)
- **FlatList numColumns={2}** for the dashboard grid

## Protocol Reference: Claude Code `--sdk-url`

Launch: `claude --sdk-url ws://localhost:PORT/ws/cli/AGENT_ID --print --output-format stream-json --input-format stream-json --verbose -p ""`

Key message types from CLI:
- `system` (subtype: `init`) — first message with session_id, tools, model, capabilities
- `assistant` — complete response with content blocks (text, tool_use, thinking)
- `stream_event` — token-by-token streaming chunks
- `result` — query completion with cost, usage, duration
- `control_request` (subtype: `can_use_tool`) — permission request with tool name + input
- `tool_progress` — tool execution heartbeat

Key messages TO CLI:
- `user` — send prompts: `{ type: "user", message: { role: "user", content: "..." }, session_id }`
- `control_response` — permission allow/deny: `{ type: "control_response", response: { behavior: "allow"|"deny", updatedInput, request_id } }`
- `keep_alive` — heartbeat

## Protocol Reference: Codex `app-server`

Launch: `codex app-server` (stdio JSONL) or `codex app-server --listen ws://IP:PORT` (WebSocket, experimental)

JSON-RPC 2.0 lite — requests have `method`, `id`, `params`; responses have `id`, `result`/`error`; notifications have `method`, `params` (no `id`).

Key lifecycle:
1. Send `initialize` with clientInfo → receive response
2. Send `initialized` notification
3. Send `thread/start { model, cwd, approvalPolicy }` → receive `{ thread: { id } }`
4. Send `turn/start { threadId, input: [{ type: "text", text }] }` → streaming begins

Streaming notifications from server:
- `turn/started` — turn begins
- `item/started { item: { type, id } }` — work unit begins (agentMessage, commandExecution, fileChange, etc.)
- `item/agentMessage/delta { itemId, delta }` — token-by-token text streaming
- `item/commandExecution/outputDelta { itemId, output, stream }` — command output
- `item/completed { item }` — work unit done
- `turn/completed { turn: { status } }` — turn ends (completed/interrupted/failed)
- `turn/diff/updated` — file change diffs
- `turn/plan/updated` — agent's plan

Approvals (server → client request, client must respond):
- `item/commandExecution/requestApproval { itemId, parsedCmd, reason }` → respond `{ decision: "accept"|"decline" }`
- `item/fileChange/requestApproval { itemId, reason }` → respond `{ decision: "accept"|"decline" }`

Other control:
- `turn/interrupt { threadId, turnId }` — abort
- `turn/steer { threadId, input }` — append to active turn
- `thread/resume { threadId }` — resume existing thread
- `thread/list` — list all threads

Can generate TypeScript types: `codex app-server generate-ts`

## Protocol Reference: OpenCode `serve`

Launch: `opencode serve --port PORT [--hostname HOST] [--cors ORIGIN]`

HTTP/REST server with OpenAPI spec. Auth via HTTP basic (OPENCODE_SERVER_PASSWORD env var).

---

## Planned Project Structure

```
mobile-agent/
├── package.json                          # Root workspace (npm start, npm run app)
├── PLAN.md                               # This file
│
├── service/
│   ├── package.json
│   └── src/
│       ├── launcher.js                   # Entry point: tunnel, QR, starts bridge (Phase 1 - slimmed down)
│       ├── bridge.js                     # WebSocket bridge: CLI ↔ mobile routing (Phase 1 - new)
│       ├── auth.js                       # Ed25519 auth, device pairing, audit log (Phase 1 - new)
│       ├── AgentSession.js               # Per-agent lifecycle, state, process mgmt (Phase 1 - new)
│       └── drivers/                      # Transport adapters per agent type (Phase 5)
│           ├── BaseDriver.js             #   Abstract EventEmitter interface
│           ├── ClaudeDriver.js           #   --sdk-url WebSocket (NDJSON)
│           ├── CodexDriver.js            #   codex app-server stdio (JSON-RPC)
│           └── OpenCodeDriver.js         #   opencode serve HTTP (REST)
│
└── app/
    ├── package.json
    ├── app.json                          # Expo config
    ├── App.tsx                           # Root component, navigation, WebSocket handler (Phase 2-4 - refactored)
    ├── index.ts                          # Expo entry point
    │
    ├── state/                            # Multi-agent state management (Phase 2 - new)
    │   ├── types.ts                      #   AgentState, AppState, AgentAction types
    │   ├── agentReducer.ts               #   Pure reducer for agent Map
    │   └── AgentContext.tsx               #   Provider, useAgentState(), useAgent() hooks
    │
    ├── types/
    │   └── index.ts                      # Shared types: Message, PermissionRequest, ContentBlock, etc.
    │
    ├── hooks/
    │   ├── useWebSocket.ts               # WebSocket connection lifecycle (minor updates)
    │   ├── useNotifications.ts           # Push notifications
    │   └── useCompletionChime.ts         # Audio feedback
    │
    ├── components/
    │   ├── index.ts                      # Barrel exports
    │   ├── Dashboard.tsx                 # Agent grid with FlatList numColumns={2} (Phase 3 - new)
    │   ├── AgentCard.tsx                 # Half-width card with live preview (Phase 3 - new)
    │   ├── AgentDetailScreen.tsx         # Full chat view for one agent (Phase 4 - new)
    │   ├── MessageBubble.tsx             # Chat message rendering (Phase 4 - updated for ContentBlocks)
    │   ├── InputBar.tsx                  # Text input + send button (existing)
    │   ├── PermissionPrompt.tsx          # Permission approve/deny (existing, updated for structured data)
    │   ├── Settings.tsx                  # QR scan + connection settings (existing)
    │   ├── SessionList.tsx               # Historical session list (existing)
    │   ├── KeyboardScrollView.tsx        # Auto-scroll chat container (existing)
    │   └── CodeBlock.tsx                 # Syntax-highlighted code (existing)
    │
    ├── assets/
    │   └── chime.wav
    │
    └── ios/
        ├── MobileAgent.xcworkspace
        ├── MobileAgent.xcodeproj
        ├── Podfile
        └── Pods/
```

**New files:** 11 (4 service, 7 app)
**Modified files:** ~7 (launcher.js, package.json, App.tsx, types/index.ts, MessageBubble.tsx, PermissionPrompt.tsx, components/index.ts)
**Deleted files:** 0 (existing components kept and reused)

**Server-side data directory:** `~/.mobile-agent/`
```
~/.mobile-agent/
├── server.key                # Ed25519 private key (0600 permissions)
├── server.pub                # Ed25519 public key
├── devices.json              # Authorized device public keys + metadata
└── audit.log                 # Connection/action audit trail
```

---

## Phase 1: Rewrite Service as WebSocket Bridge

Replace the PTY-based `launcher.js` with a WebSocket bridge that spawns Claude Code processes using `--sdk-url` and routes messages between CLI and mobile clients.

**Create:** `service/src/AgentSession.js`
- Class managing one agent's lifecycle, transport-agnostic from day one:
  - `id` (agentId, UUID)
  - `type` ('claude' — initially, extensible to 'opencode', 'codex', etc.)
  - `status` ('starting' | 'connected' | 'idle' | 'running' | 'awaiting_permission' | 'error' | 'exited')
  - `sessionId` (agent's session ID, received on init)
  - `sessionName` (derived from first prompt or set by user)
  - `messageHistory` (array of normalized messages for replay to mobile on reconnect)
  - `pendingPermissions` (Map of requestId → permission request)
  - `model`, `tools`, `totalCost`, `contextUsedPercent`, `outputTokens`
  - `onBroadcast` callback — `(agentId, type, data) => void` (provided by bridge)
- Methods:
  - `spawn()` — spawns Claude with `--sdk-url ws://localhost:PORT/ws/cli/AGENT_ID` flags
  - `attachCliSocket(ws)` — called by bridge when CLI connects back; sets up NDJSON message handling
  - `sendPrompt(text)` — sends `user` message to CLI socket (or queues if not yet connected)
  - `respondToPermission(requestId, behavior, updatedInput?)` — sends `control_response`
  - `handleCLIMessage(msg)` — parses incoming NDJSON, updates state, calls `onBroadcast` with normalized messages
  - `getSnapshot()` — returns agent summary for dashboard cards
  - `destroy()` — kills process, closes socket, cleans up
- **Designed for Phase 5 extraction:** The CLI-specific logic (NDJSON parsing, `--sdk-url` spawn args, `control_response` formatting) is grouped into clearly-marked methods that will later be extracted into `ClaudeDriver`. The event flow (`handleCLIMessage` → normalize → `onBroadcast`) establishes the pattern that all future drivers will follow.

**Create:** `service/src/bridge.js` — main server module
- HTTP server + WebSocket server (using `ws` library)
- **Two WebSocket upgrade paths:**
  - `/ws/cli/:agentId` — accepts CLI connections (NDJSON protocol). On connection, looks up the AgentSession by agentId, stores the socket as `session.cliSocket`, marks status as `connected`
  - `/ws/mobile?token=AUTH_TOKEN` — accepts mobile app connections (JSON protocol). Auth via token query param (same as current). Broadcasts agent updates to all mobile clients.
- `agents` Map: `agentId → AgentSession`
- Mobile message handlers:
  - `createAgent { type? }` → spawns new AgentSession, broadcasts `agentCreated`
  - `destroyAgent { agentId }` → kills process, broadcasts `agentDestroyed`
  - `listAgents` → sends `agentList` with snapshots
  - `sendMessage { agentId, text }` → calls `session.sendPrompt(text)`, broadcasts `userMessage`
  - `respondPermission { agentId, requestId, behavior }` → calls `session.respondToPermission()`
  - `ping` → `pong`
- CLI→Mobile routing (inside `AgentSession.handleCLIMessage`):
  - `system/init` → updates session metadata, broadcasts `agentUpdated` to mobile
  - `stream_event` → broadcasts `streamChunk { agentId, text }` to mobile (extracted from content_block_delta)
  - `assistant` → broadcasts `assistantMessage { agentId, content }` with full content blocks
  - `result` → broadcasts `agentResult { agentId, cost, usage, duration }`, updates status to 'idle'
  - `control_request (can_use_tool)` → stores in pendingPermissions, broadcasts `permissionRequest { agentId, requestId, toolName, toolInput }` to mobile
  - `tool_progress` → broadcasts `toolProgress { agentId, toolName, elapsed }` to mobile

**Modify:** `service/src/launcher.js` — replace the bulk of the file
- Keep: Cloudflare tunnel setup, QR code generation, AUTH_TOKEN generation, port config
- Replace: all PTY logic, global state, message handlers → import and use `bridge.js`
- The launcher becomes a thin entry point: start the bridge server, create tunnel, show QR

**Modify:** `service/package.json`
- Remove `@lydell/node-pty` dependency (no longer needed!)
- Keep `ws`, `uuid`, `qrcode-terminal`
- Add `tweetnacl` (Ed25519 signing/verification — small, zero-dependency, audited)

**Create:** `service/src/auth.js` — authentication module
- `initializeKeys()` — generates Ed25519 keypair on first run, persists to `~/.mobile-agent/server.key`
- `generatePairingToken()` — one-time-use token for initial device pairing
- `registerDevice(devicePublicKey, deviceId)` — stores authorized device in `~/.mobile-agent/devices.json`
- `verifyChallenge(signedChallenge)` — verifies device signature, checks timestamp freshness (<30s), returns deviceId
- `revokeDevice(deviceId)` — removes from authorized devices
- `logAudit(event)` — appends to `~/.mobile-agent/audit.log`

**Update mobile auth flow in bridge.js:**
- `/ws/mobile` upgrade: first message must be `authenticate { signedChallenge }` — verified before any other messages accepted
- If pairing mode active: accept `pair { devicePublicKey, deviceId, pairingToken }` message instead
- Rate limit: track failed attempts per IP, block after 5 failures for 15 min

**Update app auth flow:**
- Replace `AsyncStorage` for credentials with `expo-secure-store` (iOS Keychain)
- QR scan during pairing stores: tunnel URL, server public key, generates device keypair
- Every WebSocket connect: generate `{ timestamp, nonce, deviceId }`, sign with device private key, send as first message

**Verify:**
1. `npm start` — server starts, creates `~/.mobile-agent/` with keypair, shows pairing QR code
2. Phone scans QR → sends device public key → server stores it → connection established
3. Subsequent connections use signed challenge (no QR needed, works from anywhere)
4. Wrong/expired signature → connection rejected, logged to audit.log
5. Server logs show it's listening for CLI connections on `/ws/cli/:id`
6. Send `createAgent` from authenticated mobile → server spawns `claude --sdk-url ...`
7. Claude CLI connects back to `/ws/cli/:agentId` → logs show `system/init` received
8. Send `sendMessage { agentId, text: "hello" }` → receive structured `streamChunk` and `assistantMessage` events
9. Permission requests arrive as structured `permissionRequest` with tool name and input

---

## Phase 2: App State Refactor

Replace the ~15 useState calls in App.tsx with a reducer that holds a `Map<agentId, AgentState>`. Update the WebSocket message handling to work with the new bridge protocol.

**Create:** `app/state/types.ts`
```
AgentState {
  id: string
  type: 'claude' | 'codex' | 'opencode' | string   // extensible for future agents
  status: 'starting' | 'connected' | 'idle' | 'running' | 'awaiting_permission' | 'error' | 'exited'
  sessionId: string | null
  sessionName: string
  messages: Message[]
  pendingPermissions: Map<string, PermissionRequest>  // requestId → request (multiple simultaneous)
  model: string | null
  tools: string[]
  totalCost: number
  contextUsedPercent: number
  outputTokens: number
  lastOutput: string          // rolling ~500 char preview for dashboard cards
  draftText: string
  createdAt: number
}

AppState {
  agents: Map<string, AgentState>
  activeAgentId: string | null
}

AgentAction =
  | ADD_AGENT | REMOVE_AGENT | UPDATE_AGENT_STATUS
  | ADD_MESSAGE | APPEND_STREAM_CONTENT | SET_MESSAGES
  | ADD_PERMISSION | REMOVE_PERMISSION
  | SET_SESSION_INFO (model, tools, sessionId, etc.)
  | UPDATE_COST
  | SET_DRAFT | SET_LAST_OUTPUT
  | SET_ACTIVE_AGENT
```

**Create:** `app/state/agentReducer.ts`
- Pure reducer: look up agent in Map, shallow-clone, return updated state
- `APPEND_STREAM_CONTENT` updates both messages (last assistant message) and lastOutput

**Create:** `app/state/AgentContext.tsx`
- `AgentProvider` wraps app with `useReducer` + context
- Per-agent streaming throttle refs (same 50ms batch pattern, keyed by agentId)
- Exports `useAgentState()` and `useAgent(agentId)`

**Modify:** `app/App.tsx`
- Wrap in `<AgentProvider>`
- WebSocket `onMessage` maps new protocol messages to dispatch calls:
  - `agentCreated` → `dispatch(ADD_AGENT)`
  - `agentDestroyed` → `dispatch(REMOVE_AGENT)`
  - `streamChunk` → batch into pendingContentRef, flush every 50ms → `dispatch(APPEND_STREAM_CONTENT)`
  - `assistantMessage` → `dispatch(ADD_MESSAGE)` with full content
  - `permissionRequest` → `dispatch(ADD_PERMISSION)`
  - `agentResult` → `dispatch(UPDATE_COST)` + `dispatch(UPDATE_AGENT_STATUS, 'idle')`
  - `agentUpdated` → `dispatch(SET_SESSION_INFO)`
  - `userMessage` → `dispatch(ADD_MESSAGE)`
- Remove per-agent useState calls; keep connection-level state local (serverUrl, authToken, screen)

**Modify:** `app/types/index.ts`
- Add `agentId` to `ServerMessage`
- Add `AgentType` union type (extensible string union)
- Update `PermissionRequest` to include `requestId`, `toolName`, `toolInput` (structured, not just a description string)
- Add `ContentBlock` type for structured assistant responses (text, tool_use, thinking)

**Verify:** App connects, the `connected` message includes agent list. Creating an agent and sending messages works through the reducer. State is structured and observable.

---

## Phase 3: Dashboard UI

New default screen showing a grid of agent cards with live output previews.

**Create:** `app/components/AgentCard.tsx`
- Half-width card (~180pt min height), dark theme
- Header: status dot (animated pulse when running) + session name + agent type badge
- Body: last ~3-4 lines of monospace output preview (from `lastOutput`)
- Footer: model name, cost (`$0.XX`), context usage bar
- If `awaiting_permission`: yellow banner "Permission needed"
- `onPress` → navigate to detail, `onLongPress` → confirm & destroy

**Create:** `app/components/Dashboard.tsx`
- Header: "Agents" title, connection status pill, settings gear
- `FlatList` with `numColumns={2}`, renders `AgentCard` for each agent
- Last item: "+ New Agent" card (same size as agent cards)
- `onSelectAgent`, `onCreateAgent`, `onDestroyAgent` callbacks

**Modify:** `app/App.tsx`
- Add `'dashboard'` to Screen type
- After connecting, navigate to `dashboard` (not `chat`)
- Wire dashboard callbacks to WebSocket `send`
- Tapping card → `dispatch(SET_ACTIVE_AGENT)` + `setScreen('chat')`

**Modify:** `app/components/index.ts` — export new components

**Verify:** Connect → see dashboard with one default agent card. Tap "+ New Agent" to create more. Cards update with live streaming output. Cards show cost/model/status. Tap card → full chat. Long-press → destroy with confirmation.

---

## Phase 4: Agent Detail Screen

Extract the current chat UI into a dedicated component that reads from the agent reducer.

**Create:** `app/components/AgentDetailScreen.tsx`
- Props: `agentId`, `onBack`, WebSocket `send`/`status`/`resetPingTimer`
- Reads agent state from `useAgent(agentId)`
- Header: back button (← Dashboard), session name, status dot, model name
- Stats bar: cost, output tokens, context % (from structured `result` data)
- Body: `KeyboardScrollView` with `MessageBubble`s
- Permission prompts: render from `agent.pendingPermissions` Map (supports multiple simultaneous!)
  - Show tool name + structured input (not just a description string)
  - Allow / Deny buttons → `send('respondPermission', { agentId, requestId, behavior })`
- `InputBar` with agent-scoped draft persistence
- Notifications include agent name: `"[session name] Task completed ($0.XX)"`

**Modify:** `app/App.tsx`
- Replace inline chat rendering with `<AgentDetailScreen>`
- Pass WebSocket functions as props

**Modify:** `app/components/MessageBubble.tsx`
- Support new `ContentBlock` structure from `--sdk-url` protocol:
  - `text` blocks → render as before
  - `tool_use` blocks → render tool name + input (collapsible)
  - `tool_result` blocks → render result content
  - `thinking` blocks → render in a distinct style (collapsible)

**Verify:** Dashboard → tap card → full chat with back button and stats. Send messages, see streaming output. Permission prompts show structured tool info. Multiple permissions can be pending simultaneously. Back to dashboard shows updated preview. Multiple agents process simultaneously.

---

## Phase 5: Agent Type Abstraction (Provider/Adapter Pattern)

Support non-Claude agents with a transport-agnostic driver/provider pattern. Each agent type wraps its own transport (WebSocket, HTTP, PTY) and exposes a unified interface to `AgentSession`.

**Create:** `service/src/drivers/BaseDriver.js` — abstract base class defining the contract:
```
class BaseDriver extends EventEmitter {
  // Identity
  name: string                    // e.g. "Claude Code", "OpenCode", "Codex"
  transportType: string           // 'websocket-server' | 'http-client' | 'pty'

  // Lifecycle
  async start(agentId, opts)      // Start the agent process/connection
  async stop()                    // Gracefully shutdown
  isReady(): boolean              // Is the transport connected and ready?

  // Sending (AgentSession calls these — driver handles transport details)
  async sendPrompt(text)          // Send a user message
  async respondPermission(requestId, behavior, updatedInput?)
  async interrupt()               // Abort current task

  // Events emitted (AgentSession listens):
  //   'init'           → { sessionId, model, tools }
  //   'stream'         → { text }
  //   'message'        → { content: ContentBlock[] }
  //   'result'         → { cost, usage, duration, isError }
  //   'permission'     → { requestId, toolName, toolInput }
  //   'toolProgress'   → { toolName, elapsed }
  //   'status'         → { status }  (running, idle, error, etc.)
  //   'error'          → { message }
  //   'exit'           → { code }
}
```

**Create:** `service/src/drivers/ClaudeDriver.js`
- Transport: `websocket-server` — spawns CLI with `--sdk-url`, CLI connects back to our server
- `start()`: spawns `claude --sdk-url ws://localhost:PORT/ws/cli/AGENT_ID --print --output-format stream-json --input-format stream-json --verbose -p ""`
- Incoming NDJSON parsed and emitted as normalized events:
  - `system/init` → emits `'init'`
  - `stream_event` with `content_block_delta` → emits `'stream'` with extracted text
  - `assistant` → emits `'message'` with content blocks
  - `result` → emits `'result'` with cost/usage
  - `control_request (can_use_tool)` → emits `'permission'`
  - `tool_progress` → emits `'toolProgress'`
- `sendPrompt()`: sends NDJSON `{ type: "user", message: { role: "user", content }, session_id }\n`
- `respondPermission()`: sends NDJSON `{ type: "control_response", response: { subtype: "success", request_id, response: { behavior, updatedInput } } }\n`

**Create:** `service/src/drivers/OpenCodeDriver.js`
- Transport: `http-client` — spawns `opencode serve --port PORT`, our server polls/connects as HTTP client
- `start()`: spawns `opencode serve --port <assigned-port>`, waits for readiness
- Uses OpenCode's OpenAPI endpoints to send messages and receive responses
- Polls or uses SSE for streaming updates, normalizes into same event interface
- `sendPrompt()`: POST to OpenCode's HTTP API
- `respondPermission()`: POST permission response to OpenCode's API
- Auth via `OPENCODE_SERVER_PASSWORD` env var if configured

**Create:** `service/src/drivers/CodexDriver.js`
- Transport: `stdio-jsonrpc` — spawns `codex app-server` as child process, communicates via stdin/stdout JSONL (JSON-RPC 2.0 lite)
- `start()`: spawns `codex app-server`, sends `initialize` + `initialized`, then `thread/start { model, cwd, approvalPolicy }`
- Incoming JSON-RPC notifications parsed and emitted as normalized events:
  - `item/agentMessage/delta` → emits `'stream'` with delta text
  - `item/completed` (type: agentMessage) → emits `'message'` with full content
  - `turn/completed` → emits `'result'` with status
  - `item/commandExecution/requestApproval` → emits `'permission'` with parsedCmd as toolInput
  - `item/fileChange/requestApproval` → emits `'permission'`
  - `item/commandExecution/outputDelta` → emits `'toolProgress'`
- `sendPrompt()`: sends `turn/start { threadId, input: [{ type: "text", text }] }`
- `respondPermission()`: sends JSON-RPC response `{ id, result: { decision: "accept"|"decline" } }`
- `interrupt()`: sends `turn/interrupt { threadId, turnId }`
- Thread management: stores `threadId` from `thread/start` response, supports `thread/resume` for session continuity

**Modify:** `service/src/AgentSession.js`
- Constructor: `new AgentSession(id, type)` → instantiates appropriate driver
- `spawn()` → calls `driver.start(this.id, opts)`
- Listens to driver events and broadcasts to mobile:
  - `driver.on('stream', ...)` → broadcasts `streamChunk` to mobile
  - `driver.on('permission', ...)` → stores in pendingPermissions, broadcasts `permissionRequest`
  - etc.
- `sendPrompt(text)` → `driver.sendPrompt(text)` (no transport knowledge needed)
- `respondToPermission(...)` → `driver.respondPermission(...)` (no transport knowledge needed)

**Modify:** `service/src/bridge.js`
- The `/ws/cli/:agentId` endpoint is only used by `ClaudeDriver` — when a CLI connects, bridge finds the agent session and calls `session.driver.attachSocket(ws)` (Claude-specific method)
- Other drivers don't use this endpoint at all

**Modify:** `app/components/Dashboard.tsx`
- Agent type picker on "+ New Agent" (ActionSheet: Claude Code, OpenCode, Codex)

**Verify:** Create Claude agent (WebSocket bridge, works as before). Create OpenCode agent (HTTP transport, same UI). The mobile app doesn't know or care which transport the agent uses — it all looks the same.

---

## Phase 6: App Blocker (Future — Not Building Yet)

Placeholder for future implementation. When no agents are actively working, show a motivational overlay with snarky messages and a "Launch Agent" CTA. True cross-app blocking would require Screen Time API / native module outside Expo. We'll revisit this after getting an Apple Developer account set up and testing on-device.

---

## Key Files Reference

| File | Phases | Role |
|------|--------|------|
| `service/src/launcher.js` | 1 | Entry point — tunnel, QR, starts bridge |
| `service/src/bridge.js` | 1, 5 | WebSocket bridge (CLI ↔ mobile routing) |
| `service/src/auth.js` | 1 | Ed25519 auth, device pairing, audit log |
| `service/src/AgentSession.js` | 1, 5 | Per-agent lifecycle, state, process mgmt |
| `service/src/drivers/BaseDriver.js` | 5 | Abstract driver interface (EventEmitter) |
| `service/src/drivers/ClaudeDriver.js` | 5 | Claude `--sdk-url` WebSocket protocol |
| `service/src/drivers/OpenCodeDriver.js` | 5 | OpenCode `serve` HTTP/REST protocol |
| `service/src/drivers/CodexDriver.js` | 5 | Codex `app-server` stdio JSON-RPC protocol |
| `app/App.tsx` | 2, 3, 4 | Main app — decomposed incrementally |
| `app/state/AgentContext.tsx` | 2 | Provider with reducer + streaming refs |
| `app/state/agentReducer.ts` | 2 | Pure state management |
| `app/state/types.ts` | 2 | All type definitions for multi-agent state |
| `app/components/Dashboard.tsx` | 3, 5 | Grid of agent cards |
| `app/components/AgentCard.tsx` | 3 | Individual card with live preview |
| `app/components/AgentDetailScreen.tsx` | 4 | Full chat view for one agent |
| `app/components/MessageBubble.tsx` | 4 | Updated for structured content blocks |
| `app/types/index.ts` | 2 | Shared type definitions |

## Mobile ↔ Server Protocol (New)

**Server → Mobile:**
- `connected { agents: [snapshots] }` — on mobile connect
- `agentCreated { agent: snapshot }` — new agent spawned
- `agentDestroyed { agentId }` — agent killed
- `agentUpdated { agentId, ...partialState }` — metadata change (model, tools, status)
- `agentList { agents: [snapshots] }` — response to listAgents
- `userMessage { agentId, content }` — echo of sent prompt
- `streamChunk { agentId, text }` — token-by-token streaming
- `assistantMessage { agentId, content: ContentBlock[] }` — complete response
- `permissionRequest { agentId, requestId, toolName, toolInput }` — structured permission
- `toolProgress { agentId, toolName, elapsed }` — tool heartbeat
- `agentResult { agentId, cost, usage, duration, isError }` — query complete
- `pong` — keepalive response

**Mobile → Server:**
- `createAgent { type? }` — spawn new agent
- `destroyAgent { agentId }` — kill agent
- `listAgents` — request all snapshots
- `sendMessage { agentId, text }` — send prompt to agent
- `respondPermission { agentId, requestId, behavior: 'allow'|'deny' }` — answer permission
- `ping` — keepalive
