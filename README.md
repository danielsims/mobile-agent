# Mobile Agent

Stream your Claude Code sessions to your mobile device.

## Quick Start

### One-Time Setup

1. Install dependencies:
   ```bash
   cd ~/Documents/claude/mobile-agent
   npm run install:all
   ```

2. Install Expo Go on your phone from the App Store / Play Store

### Start the Server

```bash
cd ~/Documents/claude/mobile-agent
npm start
```

This will:
1. Start the WebSocket server
2. Create a secure Cloudflare tunnel
3. Display a QR code

**Scan the QR code with your phone camera** - it will open directly in the app with everything configured.

### Start the Expo App (first time only)

In a separate terminal:
```bash
cd ~/Documents/claude/mobile-agent
npm run app
```

Then scan the Expo QR code to load the app into Expo Go.

## Usage

Once connected:
- Tap **"New Session"** to spawn Claude Code
- Watch terminal output stream in real-time
- Use **Yes/No/Enter** buttons for quick approvals
- Type full messages in the input field
- Phone vibrates when Claude needs approval

## How It Works

```
┌─────────────────┐      ┌───────────────────┐      ┌──────────────┐
│   Your Mac      │      │ Cloudflare Tunnel │      │   Phone      │
│                 │      │                   │      │              │
│  Claude Code ◀──┼──────┼── (encrypted) ────┼──────┼─▶ Expo App   │
│  in PTY         │      │                   │      │              │
│  + WS Server    │      │                   │      │              │
└─────────────────┘      └───────────────────┘      └──────────────┘
```

All Claude interaction happens on your Mac. The app just relays terminal I/O.

## Security

- Random auth token generated each server start
- All traffic encrypted via Cloudflare tunnel (WSS)
- Token embedded in QR code deep link
- No API keys exposed - just terminal forwarding
