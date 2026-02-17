import React, { createContext, useContext, useReducer, useCallback, useRef, useMemo, useEffect } from 'react';
import type { AppState, AgentState, AgentAction, ServerMessage, AgentMessage, PermissionRequest, ImageAttachment, ContentBlock } from '@shared/types';
import { agentReducer, initialState } from './agentReducer';

let msgSeq = 0;
function nextMsgId(suffix: string): string {
  return `${++msgSeq}-${suffix}`;
}

function normalizeImageAttachment(raw: unknown): ImageAttachment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const image = raw as Record<string, unknown>;
  const uri = typeof image.uri === 'string' && image.uri ? image.uri : undefined;
  const mimeType = typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : undefined;
  const base64 = !uri && typeof image.base64 === 'string' && image.base64 ? image.base64 : undefined;

  if (!uri && !base64) return undefined;
  return { uri, mimeType, base64 };
}

interface AgentContextValue {
  state: AppState;
  dispatch: React.Dispatch<AgentAction>;
  handleServerMessage: (msg: ServerMessage) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

const STREAM_FLUSH_INTERVAL = 50;

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(agentReducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Batch incoming history responses
  const pendingHistoryRef = useRef<Map<string, { messages: AgentMessage[]; permissions?: PermissionRequest[] }>>(new Map());
  const expectedHistoryCountRef = useRef<number>(0);
  const historyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyLoadedRef = useRef<Set<string>>(new Set());

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
      historyLoadedRef.current.add(agentId);
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

  // Per-agent streaming throttle
  const pendingStreamsRef = useRef<Map<string, string>>(new Map());
  const streamSeenRef = useRef<Set<string>>(new Set());
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

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected': {
        if (msg.agents) {
          dispatch({ type: 'SET_AGENTS', agents: msg.agents });
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
          historyLoadedRef.current.delete(msg.agentId);
          streamSeenRef.current.delete(msg.agentId);
          pendingStreamsRef.current.delete(msg.agentId);
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
        if (msg.agentId && msg.content !== undefined) {
          const message: AgentMessage = {
            id: nextMsgId('user'),
            type: 'user',
            content: Array.isArray(msg.content) ? msg.content : String(msg.content),
            imageData: normalizeImageAttachment(msg.imageData),
            timestamp: msg.ts || Date.now(),
          };
          dispatch({ type: 'ADD_MESSAGE', agentId: msg.agentId, message });
        }
        break;
      }

      case 'streamChunk': {
        if (msg.agentId && msg.text) {
          const pending = pendingStreamsRef.current;
          const current = pending.get(msg.agentId) || '';
          pending.set(msg.agentId, current + msg.text);
          streamSeenRef.current.add(msg.agentId);
          scheduleFlush();
        }
        break;
      }

      case 'assistantMessage': {
        if (msg.agentId && msg.content) {
          const content: ContentBlock[] = Array.isArray(msg.content)
            ? msg.content
            : [{ type: 'text', text: String(msg.content) }];
          const timestamp = msg.ts || Date.now();
          const hadStream = streamSeenRef.current.has(msg.agentId);

          const pending = pendingStreamsRef.current;
          if (pending.has(msg.agentId)) {
            dispatch({
              type: 'APPEND_STREAM_CONTENT',
              agentId: msg.agentId,
              text: pending.get(msg.agentId) || '',
            });
            pending.delete(msg.agentId);
          }
          streamSeenRef.current.delete(msg.agentId);

          if (hadStream) {
            dispatch({
              type: 'FINALIZE_ASSISTANT_MESSAGE',
              agentId: msg.agentId,
              content,
              timestamp,
            });
          } else {
            const message: AgentMessage = {
              id: nextMsgId('assistant'),
              type: 'assistant',
              content,
              timestamp,
            };
            dispatch({ type: 'ADD_MESSAGE', agentId: msg.agentId, message });
          }
        }
        break;
      }

      case 'toolResults': {
        if (msg.agentId && Array.isArray(msg.results) && msg.results.length > 0) {
          dispatch({
            type: 'MERGE_TOOL_RESULTS',
            agentId: msg.agentId,
            results: msg.results,
          });
        }
        break;
      }

      case 'toolUseUpdated': {
        if (msg.agentId && msg.toolCallId && msg.input) {
          dispatch({
            type: 'UPDATE_TOOL_INPUT',
            agentId: msg.agentId,
            toolCallId: msg.toolCallId,
            input: msg.input,
          });
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
          streamSeenRef.current.delete(msg.agentId);
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
          const existing = stateRef.current.agents.get(msg.agentId);
          if ((existing && existing.messages.length > 0) || historyLoadedRef.current.has(msg.agentId)) {
            if (msg.pendingPermissions && Array.isArray(msg.pendingPermissions)) {
              dispatch({
                type: 'SET_PERMISSIONS',
                agentId: msg.agentId,
                permissions: msg.pendingPermissions,
              });
            }
            break;
          }

          const messages = (msg.messages as AgentMessage[])
            .filter(m => !(m.type === 'user' && typeof m.content !== 'string'))
            .map((m, i) => ({
              ...m,
              id: m.id || nextMsgId(`history-${i}`),
            }));

          const permissions = msg.pendingPermissions && Array.isArray(msg.pendingPermissions)
            ? msg.pendingPermissions : undefined;

          if (expectedHistoryCountRef.current > 0) {
            pendingHistoryRef.current.set(msg.agentId, { messages, permissions });

            if (pendingHistoryRef.current.size >= expectedHistoryCountRef.current) {
              flushHistory();
            } else {
              if (!historyFlushTimerRef.current) {
                historyFlushTimerRef.current = setTimeout(flushHistory, 500);
              }
            }
          } else {
            dispatch({ type: 'SET_MESSAGES', agentId: msg.agentId, messages });
            historyLoadedRef.current.add(msg.agentId);
            if (permissions) {
              dispatch({ type: 'SET_PERMISSIONS', agentId: msg.agentId, permissions });
            }
          }
        }
        break;
      }
    }
  }, [scheduleFlush, flushHistory]);

  const value = useMemo(() => ({
    state,
    dispatch,
    handleServerMessage,
  }), [state, handleServerMessage]);

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

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
