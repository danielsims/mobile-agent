import type { AgentType } from '../state/types';

export type ToolRendererKind = 'default' | 'todo' | 'question';

const TOOL_NAME_ALIASES: Record<string, string> = {
  askuserquestion: 'question',
  question: 'question',
  todowrite: 'todowrite',
  todoread: 'todoread',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getCanonicalToolKey(name: string): string {
  const normalized = normalizeToolName(name);
  return TOOL_NAME_ALIASES[normalized] || normalized;
}

const RENDERERS_BY_AGENT: Record<string, Record<string, ToolRendererKind>> = {
  claude: {
    question: 'question',
    todowrite: 'todo',
    todoread: 'todo',
  },
  codex: {
    question: 'question',
    todowrite: 'todo',
    todoread: 'todo',
  },
  opencode: {
    question: 'question',
    todowrite: 'todo',
    todoread: 'todo',
  },
};

const GLOBAL_RENDERERS: Record<string, ToolRendererKind> = {
  question: 'question',
  todowrite: 'todo',
  todoread: 'todo',
};

export function getToolRendererKind(agentType: AgentType | undefined, toolName: string): ToolRendererKind {
  const key = getCanonicalToolKey(toolName);
  if (agentType && RENDERERS_BY_AGENT[agentType]?.[key]) {
    return RENDERERS_BY_AGENT[agentType][key];
  }
  return GLOBAL_RENDERERS[key] || 'default';
}

export function isQuestionTool(agentType: AgentType | undefined, toolName: string): boolean {
  return getToolRendererKind(agentType, toolName) === 'question';
}
