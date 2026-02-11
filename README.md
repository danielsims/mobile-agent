# Mobile Agent

Control coding agents (Claude Code, Codex, OpenCode) remotely from your phone. Spawn multiple agents across different repos, manage git worktrees, and approve tool permissions — all from a single dashboard.

## Quick Start

### One-Time Setup

1. Install dependencies:
   ```bash
   npm run install:all
   ```

2. Install Expo Go on your phone from the App Store / Play Store

### Start the Service

```bash
npm start
```

This starts the WebSocket bridge, creates a secure Cloudflare tunnel, and displays a QR code. Scan it with your phone camera to pair.

### Start the Expo App (first time only)

In a separate terminal:
```bash
npm run app
```

Scan the Expo QR code to load the app into Expo Go.

## Project Management

Register git repos so agents can spawn inside them. Only registered projects are accessible from the phone.

```bash
cd service

# Register a project
node src/launcher.js register /path/to/your/repo

# Register with a custom name
node src/launcher.js register /path/to/your/repo my-project

# List registered projects
node src/launcher.js projects

# Unregister a project
node src/launcher.js unregister <project-id>
```

Once registered, projects appear in the agent creation flow on the phone. You can pick a project and worktree (or create a new one) when spawning an agent.

## Usage

Once connected:
- Tap **+** to create a new agent — pick agent type, project, and worktree
- Watch output stream in real-time on the agent detail screen
- Approve or deny tool permission requests
- Long-press an agent card on the dashboard for quick actions
- Phone chimes and sends a notification when an agent completes

## Architecture

```
Phone (Expo/React Native)
  ↕ WebSocket (E2E encrypted, Ed25519 auth)
Service (Node.js bridge)
  ↕ stdio
Agent processes (Claude Code, Codex, OpenCode)
```

- `app/` — React Native app (Expo)
- `service/` — Node.js WebSocket bridge + agent process manager

## Security

- Ed25519 challenge-response authentication between phone and service
- All traffic encrypted via Cloudflare tunnel (WSS)
- Pairing via one-time QR code token
- No filesystem browsing — only registered projects accessible
- All git operations use `execFileSync` (no shell injection)
- Branch names validated with strict regex
