import React, { createContext, useContext, useReducer, useCallback, useRef, useMemo, useEffect } from 'react';
import type { AppState, AgentState, AgentAction, ServerMessage, AgentMessage, PermissionRequest } from './types';
import { agentReducer, initialState } from './agentReducer';
import { saveMessages, loadMessages, clearMessages } from './messageCache';

// Unique message ID generator — avoids Date.now() collisions within same ms
let msgSeq = 0;
function nextMsgId(suffix: string): string {
  return `${++msgSeq}-${suffix}`;
}

// --- Context ---

interface AgentContextValue {
  state: AppState;
  dispatch: React.Dispatch<AgentAction>;
  handleServerMessage: (msg: ServerMessage) => void;
  loadCachedMessages: (agentId: string) => Promise<boolean>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

// --- Provider ---

const STREAM_FLUSH_INTERVAL = 50; // ms

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(agentReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Track which agents have had cache loaded (synchronous guard)
  const cacheLoadedRef = useRef<Set<string>>(new Set());

  // Batch incoming history responses so all agents appear at once on initial load.
  // Collects history until all expected agents have responded (or timeout fires).
  const pendingHistoryRef = useRef<Map<string, { messages: AgentMessage[]; permissions?: PermissionRequest[] }>>(new Map());
  const expectedHistoryCountRef = useRef<number>(0);
  const historyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushHistory = useCallback(() => {
    if (historyFlushTimerRef.current) {
      clearTimeout(historyFlushTimerRef.current);
      historyFlushTimerRef.current = null;
    }
    const pending = pendingHistoryRef.current;
    if (pending.size === 0) return;

    const batch: Array<{ agentId: string; messages: AgentMessage[] }> = [];
    const permsBatch: Array<{ agentId: string; permissions: PermissionRequest[] }> = [];
    for (const [agentId, data] of pending) {
      batch.push({ agentId, messages: data.messages });
      cacheLoadedRef.current.add(agentId);
      if (data.permissions) {
        permsBatch.push({ agentId, permissions: data.permissions });
      }
    }
    pending.clear();
    expectedHistoryCountRef.current = 0;

    dispatch({ type: 'BATCH_SET_MESSAGES', batch });
    for (const { agentId, permissions } of permsBatch) {
      dispatch({ type: 'SET_PERMISSIONS', agentId, permissions });
    }
  }, []);

  // Per-agent streaming throttle: accumulate stream chunks and flush every 50ms
  const pendingStreamsRef = useRef<Map<string, string>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreams = useCallback(() => {
    const pending = pendingStreamsRef.current;
    if (pending.size === 0) return;

    for (const [agentId, text] of pending) {
      dispatch({ type: 'APPEND_STREAM_CONTENT', agentId, text });
    }
    pending.clear();
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flushStreams();
      }, STREAM_FLUSH_INTERVAL);
    }
  }, [flushStreams]);

  // Map server messages to dispatch calls
  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected': {
        // Initial connection — set agents from server snapshot
        if (msg.agents) {
          dispatch({ type: 'SET_AGENTS', agents: msg.agents });
          // Track how many history responses to expect for batching
          expectedHistoryCountRef.current = msg.agents.length;
        }
        break;
      }

      case 'agentCreated': {
        if (msg.agent) {
          dispatch({ type: 'ADD_AGENT', agent: msg.agent });
        }
        break;
      }

      case 'agentDestroyed': {
        if (msg.agentId) {
          cacheLoadedRef.current.delete(msg.agentId);
          clearMessages(msg.agentId);
          dispatch({ type: 'REMOVE_AGENT', agentId: msg.agentId });
        }
        break;
      }

      case 'agentUpdated': {
        if (msg.agentId) {
          if (msg.status) {
            dispatch({ type: 'UPDATE_AGENT_STATUS', agentId: msg.agentId, status: msg.status });
          }
          if (msg.model || msg.tools || msg.sessionId || msg.sessionName || msg.cwd || msg.gitBranch || msg.projectName || msg.autoApprove !== undefined) {
            dispatch({
              type: 'SET_SESSION_INFO',
              agentId: msg.agentId,
              ...(msg.sessionId !== undefined && { sessionId: msg.sessionId }),
              ...(msg.model !== undefined && { model: msg.model }),
              ...(msg.tools !== undefined && { tools: msg.tools }),
              ...(msg.sessionName !== undefined && { sessionName: msg.sessionName }),
              ...(msg.cwd !== undefined && { cwd: msg.cwd }),
              ...(msg.gitBranch !== undefined && { gitBranch: msg.gitBranch }),
              ...(msg.projectName !== undefined && { projectName: msg.projectName }),
              ...(msg.autoApprove !== undefined && { autoApprove: msg.autoApprove }),
            });
          }
        }
        break;
      }

      case 'agentList': {
        if (msg.agents) {
          dispatch({ type: 'SET_AGENTS', agents: msg.agents });
        }
        break;
      }

      case 'userMessage': {
        if (msg.agentId && msg.content) {
          const message: AgentMessage = {
            id: nextMsgId('user'),
            type: 'user',
            content: Array.isArray(msg.content) ? msg.content : String(msg.content),
            timestamp: msg.ts || Date.now(),
          };
          dispatch({ type: 'ADD_MESSAGE', agentId: msg.agentId, message });
        }
        break;
      }

      case 'streamChunk': {
        if (msg.agentId && msg.text) {
          // Batch stream chunks and flush every 50ms
          const pending = pendingStreamsRef.current;
          const current = pending.get(msg.agentId) || '';
          pending.set(msg.agentId, current + msg.text);
          scheduleFlush();
        }
        break;
      }

      case 'assistantMessage': {
        if (msg.agentId && msg.content) {
          // Flush any pending stream content first
          const pending = pendingStreamsRef.current;
          if (pending.has(msg.agentId)) {
            dispatch({
              type: 'APPEND_STREAM_CONTENT',
              agentId: msg.agentId,
              text: pending.get(msg.agentId) || '',
            });
            pending.delete(msg.agentId);
          }

          const message: AgentMessage = {
            id: nextMsgId('assistant'),
            type: 'assistant',
            content: msg.content,
            timestamp: msg.ts || Date.now(),
          };
          dispatch({ type: 'ADD_MESSAGE', agentId: msg.agentId, message });
        }
        break;
      }

      case 'permissionRequest': {
        if (msg.agentId && msg.requestId) {
          dispatch({
            type: 'ADD_PERMISSION',
            agentId: msg.agentId,
            permission: {
              requestId: msg.requestId,
              toolName: msg.toolName || 'unknown',
              toolInput: msg.toolInput || {},
              timestamp: msg.ts || Date.now(),
            },
          });
        }
        break;
      }

      case 'agentResult': {
        if (msg.agentId) {
          dispatch({
            type: 'UPDATE_COST',
            agentId: msg.agentId,
            totalCost: msg.totalCost || msg.cost || 0,
            outputTokens: msg.outputTokens || 0,
            contextUsedPercent: msg.contextUsedPercent || 0,
          });
          dispatch({
            type: 'UPDATE_AGENT_STATUS',
            agentId: msg.agentId,
            status: 'idle',
          });
        }
        break;
      }

      case 'agentHistory': {
        if (msg.agentId && msg.messages) {
          // Skip if agent already has messages (from cache or live stream)
          const existing = stateRef.current.agents.get(msg.agentId);
          if ((existing && existing.messages.length > 0) || cacheLoadedRef.current.has(msg.agentId)) {
            // Still restore permissions (authoritative source)
            if (msg.pendingPermissions && Array.isArray(msg.pendingPermissions)) {
              dispatch({
                type: 'SET_PERMISSIONS',
                agentId: msg.agentId,
                permissions: msg.pendingPermissions,
              });
            }
            break;
          }

          // Filter out tool-result "user" messages (internal protocol, not human input)
          // and ensure every history message has a unique ID
          const messages = (msg.messages as AgentMessage[])
            .filter(m => !(m.type === 'user' && typeof m.content !== 'string'))
            .map((m, i) => ({
              ...m,
              id: m.id || nextMsgId(`history-${i}`),
            }));

          const permissions = msg.pendingPermissions && Array.isArray(msg.pendingPermissions)
            ? msg.pendingPermissions : undefined;

          // If we're expecting a batch of histories (initial load), collect and flush together
          if (expectedHistoryCountRef.current > 0) {
            pendingHistoryRef.current.set(msg.agentId, { messages, permissions });

            // All expected histories arrived — flush immediately
            if (pendingHistoryRef.current.size >= expectedHistoryCountRef.current) {
              flushHistory();
            } else {
              // Safety timeout — flush after 500ms even if not all arrived
              if (!historyFlushTimerRef.current) {
                historyFlushTimerRef.current = setTimeout(flushHistory, 500);
              }
            }
          } else {
            // Single history request (e.g. selecting an agent) — dispatch immediately
            dispatch({ type: 'SET_MESSAGES', agentId: msg.agentId, messages });
            cacheLoadedRef.current.add(msg.agentId);
            if (permissions) {
              dispatch({ type: 'SET_PERMISSIONS', agentId: msg.agentId, permissions });
            }
          }
        }
        break;
      }
    }
  }, [scheduleFlush, flushHistory]);

  // Load cached messages for an agent from AsyncStorage.
  // Marks the agent as cache-loaded synchronously so getHistory can be skipped.
  // Returns true if cache was found (or agent already has messages).
  const loadCachedMessages = useCallback(async (agentId: string): Promise<boolean> => {
    // Already loaded — don't reload
    if (cacheLoadedRef.current.has(agentId)) return true;

    const cached = await loadMessages(agentId);
    if (cached.length > 0) {
      cacheLoadedRef.current.add(agentId);
      // Only set if agent still has no messages (avoid overwriting live data)
      const agent = stateRef.current.agents.get(agentId);
      if (agent && agent.messages.length === 0) {
        dispatch({ type: 'SET_MESSAGES', agentId, messages: cached });
      }
      return true;
    }
    return false;
  }, []);

  // Auto-save messages to cache whenever they change (runs after reducer updates)
  const prevMessageCountsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const [agentId, agent] of state.agents) {
      const prevCount = prevMessageCountsRef.current.get(agentId) || 0;
      if (agent.messages.length > 0 && agent.messages.length !== prevCount) {
        prevMessageCountsRef.current.set(agentId, agent.messages.length);
        saveMessages(agentId, agent.messages);
      }
    }
  }, [state.agents]);

  const value = useMemo(() => ({
    state,
    dispatch,
    handleServerMessage,
    loadCachedMessages,
  }), [state, handleServerMessage, loadCachedMessages]);

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

// --- Hooks ---

export function useAgentState(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgentState must be used within AgentProvider');
  return ctx;
}

export function useAgent(agentId: string | null): AgentState | null {
  const { state } = useAgentState();
  if (!agentId) return null;
  return state.agents.get(agentId) || null;
}

export function useActiveAgent(): AgentState | null {
  const { state } = useAgentState();
  if (!state.activeAgentId) return null;
  return state.agents.get(state.activeAgentId) || null;
}
