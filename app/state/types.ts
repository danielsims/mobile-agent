// --- Agent Types (extensible) ---

export type AgentType = 'claude' | 'codex' | 'opencode' | (string & {});

export type AgentStatus =
  | 'starting'
  | 'connected'
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'error'
  | 'exited';

// --- Content Blocks (from structured assistant responses) ---

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string | unknown;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

// --- Messages ---

export interface AgentMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  timestamp: number;
}

// --- Permissions ---

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
}

// --- Per-Agent State ---

export interface AgentState {
  id: string;
  type: AgentType;
  status: AgentStatus;
  sessionId: string | null;
  sessionName: string;
  messages: AgentMessage[];
  pendingPermissions: Map<string, PermissionRequest>;
  model: string | null;
  tools: string[];
  cwd: string | null;
  gitBranch: string | null;
  projectName: string | null;
  totalCost: number;
  contextUsedPercent: number;
  outputTokens: number;
  lastOutput: string;
  draftText: string;
  createdAt: number;
  autoApprove: boolean;
}

// --- App State ---

export interface AppState {
  agents: Map<string, AgentState>;
  activeAgentId: string | null;
}

// --- Actions ---

export type AgentAction =
  | { type: 'ADD_AGENT'; agent: AgentSnapshot }
  | { type: 'REMOVE_AGENT'; agentId: string }
  | { type: 'SET_AGENTS'; agents: AgentSnapshot[] }
  | { type: 'UPDATE_AGENT_STATUS'; agentId: string; status: AgentStatus }
  | { type: 'ADD_MESSAGE'; agentId: string; message: AgentMessage }
  | { type: 'APPEND_STREAM_CONTENT'; agentId: string; text: string }
  | { type: 'SET_MESSAGES'; agentId: string; messages: AgentMessage[] }
  | { type: 'BATCH_SET_MESSAGES'; batch: Array<{ agentId: string; messages: AgentMessage[] }> }
  | { type: 'ADD_PERMISSION'; agentId: string; permission: PermissionRequest }
  | { type: 'REMOVE_PERMISSION'; agentId: string; requestId: string }
  | { type: 'SET_SESSION_INFO'; agentId: string; sessionId?: string; model?: string; tools?: string[]; sessionName?: string; status?: AgentStatus; cwd?: string; gitBranch?: string; projectName?: string; autoApprove?: boolean }
  | { type: 'UPDATE_COST'; agentId: string; totalCost: number; outputTokens: number; contextUsedPercent: number }
  | { type: 'SET_PERMISSIONS'; agentId: string; permissions: PermissionRequest[] }
  | { type: 'SET_DRAFT'; agentId: string; text: string }
  | { type: 'SET_LAST_OUTPUT'; agentId: string; text: string }
  | { type: 'SET_ACTIVE_AGENT'; agentId: string | null };

// --- Agent Snapshot (from server) ---

export interface AgentSnapshot {
  id: string;
  type: AgentType;
  status: AgentStatus;
  sessionId: string | null;
  sessionName: string;
  model: string | null;
  cwd: string | null;
  gitBranch: string | null;
  projectName: string | null;
  totalCost: number;
  contextUsedPercent: number;
  outputTokens: number;
  lastOutput: string;
  pendingPermissions: PermissionRequest[];
  createdAt: number;
  autoApprove?: boolean;
}

// --- Project/Worktree Types ---

export interface Worktree {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  worktrees: Worktree[];
}

export interface GitLogCommit {
  hash: string;
  abbrevHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeTime: string;
  refs: string[];
}

export interface ProviderModelOption {
  value: string;
  label: string;
  note?: string;
}

// --- Server Messages (new protocol) ---

export interface ServerMessage {
  type: string;
  agentId?: string;
  ts: number;

  // connected
  deviceId?: string;
  agents?: AgentSnapshot[];

  // agentCreated
  agent?: AgentSnapshot;

  // streamChunk
  text?: string;

  // assistantMessage
  content?: ContentBlock[];

  // permissionRequest
  requestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;

  // agentResult
  cost?: number;
  totalCost?: number;
  usage?: Record<string, unknown>;
  duration?: number;
  isError?: boolean;
  outputTokens?: number;
  contextUsedPercent?: number;

  // agentUpdated
  status?: AgentStatus;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  gitBranch?: string;
  projectName?: string;
  autoApprove?: boolean;

  // agentHistory
  messages?: AgentMessage[];
  pendingPermissions?: PermissionRequest[];

  // projectList
  projects?: Project[];

  // modelList
  agentType?: AgentType;
  models?: ProviderModelOption[];

  // worktreeCreated / worktreeRemoved
  projectId?: string;
  worktree?: Worktree;
  worktrees?: Worktree[];

  // gitStatus
  files?: Array<{ file: string; status: string }>;
  ahead?: number;
  behind?: number;

  // gitDiff
  filePath?: string;
  diff?: string;

  // gitLog
  projectPath?: string;
  commits?: GitLogCommit[];

  // error
  error?: string;
}
