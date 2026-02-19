// Direct-write registry for mobile terminal views.
// Mirrors the desktop's terminalWriters Map pattern, allowing the
// streamChunk handler to write directly to the WebView terminal
// without going through React state for zero-latency rendering.

const terminalWriters = new Map<string, (text: string) => void>();

export function registerTerminalWriter(agentId: string, writer: (text: string) => void): void {
  terminalWriters.set(agentId, writer);
}

export function unregisterTerminalWriter(agentId: string): void {
  terminalWriters.delete(agentId);
}

export function writeToMobileTerminal(agentId: string, text: string): boolean {
  const writer = terminalWriters.get(agentId);
  if (writer) {
    writer(text);
    return true;
  }
  return false;
}
