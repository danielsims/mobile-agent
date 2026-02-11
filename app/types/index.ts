export type {
  AgentType,
  AgentStatus,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  AgentMessage,
  PermissionRequest,
  AgentState,
  AppState,
  AgentAction,
  AgentSnapshot,
  ServerMessage,
} from '../state/types';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
