export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type PermissionMode = 'auto' | 'confirm';

export interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'tool' | 'permission';
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  permissionId?: string;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  description: string;
  timestamp: number;
}

export interface Session {
  id: string;
  name: string;
  projectPath?: string;
  messageCount?: number;
  modified?: string;
  created?: string;
}

export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool';
  content?: string;
  toolName?: string;
  toolInput?: string;
}

export interface ServerMessage {
  type: string;
  data?: string;
  content?: string;
  sessionId?: string;
  sessionName?: string;
  permissionMode?: PermissionMode;
  mode?: PermissionMode;
  name?: string;
  input?: string;
  sessions?: Session[];
  messages?: HistoryMessage[];
  permission?: PermissionRequest;
  id?: string;
  description?: string;
  toolName?: string;
  ts: number;
}
