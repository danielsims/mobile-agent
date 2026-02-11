import type { AppState, AgentState, AgentAction, AgentSnapshot, PermissionRequest } from './types';

let messageIdCounter = 0;

function nextMessageId(): string {
  return String(messageIdCounter++);
}

function permissionsArrayToMap(perms: AgentSnapshot['pendingPermissions']): Map<string, PermissionRequest> {
  const map = new Map<string, PermissionRequest>();
  if (Array.isArray(perms)) {
    for (const p of perms) {
      if (p.requestId) map.set(p.requestId, p);
    }
  }
  return map;
}

function snapshotToAgentState(snapshot: AgentSnapshot): AgentState {
  return {
    id: snapshot.id,
    type: snapshot.type,
    status: snapshot.status,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName || 'New Agent',
    messages: [],
    pendingPermissions: permissionsArrayToMap(snapshot.pendingPermissions),
    model: snapshot.model,
    tools: [],
    cwd: snapshot.cwd || null,
    gitBranch: snapshot.gitBranch || null,
    projectName: snapshot.projectName || null,
    totalCost: snapshot.totalCost,
    contextUsedPercent: snapshot.contextUsedPercent,
    outputTokens: snapshot.outputTokens,
    lastOutput: snapshot.lastOutput || '',
    draftText: '',
    createdAt: snapshot.createdAt,
    autoApprove: snapshot.autoApprove || false,
  };
}

function updateAgent(
  state: AppState,
  agentId: string,
  updater: (agent: AgentState) => AgentState,
): AppState {
  const agent = state.agents.get(agentId);
  if (!agent) return state;

  const updated = updater(agent);
  const newAgents = new Map(state.agents);
  newAgents.set(agentId, updated);
  return { ...state, agents: newAgents };
}

export const initialState: AppState = {
  agents: new Map(),
  activeAgentId: null,
};

export function agentReducer(state: AppState, action: AgentAction): AppState {
  switch (action.type) {
    case 'ADD_AGENT': {
      const newAgents = new Map(state.agents);
      newAgents.set(action.agent.id, snapshotToAgentState(action.agent));
      return { ...state, agents: newAgents };
    }

    case 'REMOVE_AGENT': {
      const newAgents = new Map(state.agents);
      newAgents.delete(action.agentId);
      return {
        ...state,
        agents: newAgents,
        activeAgentId: state.activeAgentId === action.agentId ? null : state.activeAgentId,
      };
    }

    case 'SET_AGENTS': {
      const newAgents = new Map<string, AgentState>();
      for (const snapshot of action.agents) {
        // Preserve existing state if agent already exists (reconnect scenario)
        const existing = state.agents.get(snapshot.id);
        if (existing) {
          // Merge permissions: server data is authoritative, but keep any
          // existing permissions the server also has (preserves local state)
          const serverPerms = permissionsArrayToMap(snapshot.pendingPermissions);
          // Use server permissions if available, otherwise keep existing
          const mergedPerms = serverPerms.size > 0 ? serverPerms : existing.pendingPermissions;
          newAgents.set(snapshot.id, {
            ...existing,
            status: snapshot.status,
            model: snapshot.model || existing.model,
            cwd: snapshot.cwd || existing.cwd,
            gitBranch: snapshot.gitBranch || existing.gitBranch,
            projectName: snapshot.projectName || existing.projectName,
            totalCost: snapshot.totalCost,
            contextUsedPercent: snapshot.contextUsedPercent,
            outputTokens: snapshot.outputTokens,
            lastOutput: snapshot.lastOutput || existing.lastOutput,
            pendingPermissions: mergedPerms,
            autoApprove: snapshot.autoApprove || false,
          });
        } else {
          newAgents.set(snapshot.id, snapshotToAgentState(snapshot));
        }
      }
      return { ...state, agents: newAgents };
    }

    case 'UPDATE_AGENT_STATUS': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        status: action.status,
      }));
    }

    case 'ADD_MESSAGE': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        messages: [...agent.messages, action.message],
      }));
    }

    case 'APPEND_STREAM_CONTENT': {
      return updateAgent(state, action.agentId, (agent) => {
        const msgs = [...agent.messages];
        const last = msgs[msgs.length - 1];

        if (last && last.type === 'assistant' && typeof last.content === 'string') {
          // Append to existing streaming message
          msgs[msgs.length - 1] = {
            ...last,
            content: last.content + action.text,
          };
        } else {
          // Create new streaming message
          msgs.push({
            id: nextMessageId(),
            type: 'assistant',
            content: action.text,
            timestamp: Date.now(),
          });
        }

        // Update lastOutput rolling preview
        let lastOutput = agent.lastOutput + action.text;
        if (lastOutput.length > 500) {
          lastOutput = lastOutput.slice(-500);
        }

        return { ...agent, messages: msgs, lastOutput };
      });
    }

    case 'SET_MESSAGES': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        messages: action.messages,
      }));
    }

    case 'ADD_PERMISSION': {
      return updateAgent(state, action.agentId, (agent) => {
        const perms = new Map(agent.pendingPermissions);
        perms.set(action.permission.requestId, action.permission);
        return { ...agent, pendingPermissions: perms, status: 'awaiting_permission' };
      });
    }

    case 'REMOVE_PERMISSION': {
      return updateAgent(state, action.agentId, (agent) => {
        const perms = new Map(agent.pendingPermissions);
        perms.delete(action.requestId);
        return {
          ...agent,
          pendingPermissions: perms,
          status: perms.size === 0 ? 'running' : 'awaiting_permission',
        };
      });
    }

    case 'SET_SESSION_INFO': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        ...(action.sessionId !== undefined && { sessionId: action.sessionId }),
        ...(action.model !== undefined && { model: action.model }),
        ...(action.tools !== undefined && { tools: action.tools }),
        ...(action.sessionName !== undefined && { sessionName: action.sessionName }),
        ...(action.status !== undefined && { status: action.status }),
        ...(action.cwd !== undefined && { cwd: action.cwd }),
        ...(action.gitBranch !== undefined && { gitBranch: action.gitBranch }),
        ...(action.projectName !== undefined && { projectName: action.projectName }),
        ...(action.autoApprove !== undefined && { autoApprove: action.autoApprove }),
      }));
    }

    case 'UPDATE_COST': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        totalCost: action.totalCost,
        outputTokens: action.outputTokens,
        contextUsedPercent: action.contextUsedPercent,
      }));
    }

    case 'SET_PERMISSIONS': {
      return updateAgent(state, action.agentId, (agent) => {
        const perms = new Map<string, PermissionRequest>();
        for (const p of action.permissions) {
          if (p.requestId) perms.set(p.requestId, p);
        }
        return {
          ...agent,
          pendingPermissions: perms,
          status: perms.size > 0 ? 'awaiting_permission' : agent.status,
        };
      });
    }

    case 'SET_DRAFT': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        draftText: action.text,
      }));
    }

    case 'SET_LAST_OUTPUT': {
      return updateAgent(state, action.agentId, (agent) => ({
        ...agent,
        lastOutput: action.text,
      }));
    }

    case 'SET_ACTIVE_AGENT': {
      return { ...state, activeAgentId: action.agentId };
    }

    default:
      return state;
  }
}
