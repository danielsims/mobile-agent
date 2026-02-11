import type { AgentMessage } from './types';

/**
 * In-memory message cache. Nothing is written to disk —
 * messages live only for the current app session and are
 * cleared automatically when the app is closed or the agent is destroyed.
 */
const cache = new Map<string, AgentMessage[]>();

export function saveMessages(agentId: string, messages: AgentMessage[]): void {
  cache.set(agentId, messages);
}

export async function loadMessages(agentId: string): Promise<AgentMessage[]> {
  return cache.get(agentId) || [];
}

export function clearMessages(agentId: string): void {
  cache.delete(agentId);
}
