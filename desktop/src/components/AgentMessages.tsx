import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentMessage, ContentBlock, PermissionRequest } from '@shared/types';

// ── Utilities ──────────────────────────────────

export function shortPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '\u2026' : str;
}

export function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  return '';
}

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function formatToolName(name: string): string {
  if (name.includes('__')) {
    const parts = name.split('__');
    return parts[parts.length - 1];
  }
  return name;
}

export function getToolDisplay(name: string, input: Record<string, unknown>): { label: string; title: string } {
  const key = normalizeToolName(name);

  switch (key) {
    case 'read':
      return { label: 'Read', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'write':
      return { label: 'Write', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'edit':
      return { label: 'Edit', title: shortPath(pickString(input, 'file_path', 'path', 'file')) };
    case 'bash':
      return { label: 'Run', title: pickString(input, 'description') || truncate(pickString(input, 'command'), 60) };
    case 'grep':
      return { label: 'Search', title: truncate(pickString(input, 'pattern', 'query'), 50) };
    case 'glob':
      return { label: 'Find files', title: truncate(pickString(input, 'pattern', 'path'), 50) };
    case 'websearch':
      return { label: 'Web', title: truncate(pickString(input, 'query'), 60) };
    case 'codesearch':
      return { label: 'Code', title: truncate(pickString(input, 'query'), 60) };
    case 'webfetch':
      return { label: 'Fetch', title: truncate(pickString(input, 'url'), 50) };
    case 'task':
      return { label: 'Agent', title: pickString(input, 'description') || truncate(pickString(input, 'prompt') || 'Subagent', 50) };
    case 'skill':
      return { label: 'Skill', title: truncate(pickString(input, 'name', 'description'), 60) || 'Skill' };
    case 'askuserquestion':
    case 'question': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = questions.find((q: unknown) => q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string') as { question: string } | undefined;
      return { label: 'Question', title: first?.question ? truncate(first.question, 60) : 'Awaiting input' };
    }
    case 'todowrite':
    case 'todoread': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return { label: 'Tasks', title: todos.length > 0 ? `${todos.length} items` : 'Task list' };
    }
    default: {
      const formatted = formatToolName(name);
      const candidates = ['description', 'file_path', 'command', 'pattern', 'query', 'url', 'prompt'];
      for (const c of candidates) {
        const value = pickString(input, c);
        if (value) return { label: formatted, title: truncate(value, 60) };
      }
      return { label: formatted, title: formatted };
    }
  }
}

export function isEditWithDiff(name: string, input: Record<string, unknown>): boolean {
  return normalizeToolName(name) === 'edit'
    && typeof input.old_string === 'string'
    && typeof input.new_string === 'string';
}

export function isTodoTool(name: string): boolean {
  const key = normalizeToolName(name);
  return key === 'todowrite' || key === 'todoread';
}

export function isQuestionTool(name: string): boolean {
  const key = normalizeToolName(name);
  return key === 'askuserquestion' || key === 'question' || key === 'requestuserinput';
}

export function buildToolResultMap(messages: AgentMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        map.set(b.toolUseId, content);
      }
    }
  }
  return map;
}

// ── Diff View ──────────────────────────────────

export function DiffView({ filePath, oldStr, newStr }: { filePath?: string; oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  return (
    <div className="diff-view">
      {filePath && <div className="diff-filepath">{filePath}</div>}
      {oldLines.map((line, i) => (
        <div key={`r${i}`} className="diff-line diff-removed">
          <span className="diff-prefix">-</span>
          <span>{line}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`a${i}`} className="diff-line diff-added">
          <span className="diff-prefix">+</span>
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}

// ── Todo Card ──────────────────────────────────

export function TodoWriteCard({ block }: { block: ContentBlock & { type: 'tool_use' } }) {
  const input = block.input as Record<string, unknown>;
  const rawTodos = Array.isArray(input?.todos)
    ? input.todos
    : Array.isArray(input?.items) ? input.items : [];

  const todos = rawTodos
    .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === 'object')
    .map((todo) => ({
      content: pickString(todo, 'content', 'text', 'title', 'label') || 'Task',
      status: pickString(todo, 'status', 'state') || 'pending',
      activeForm: pickString(todo, 'activeForm', 'active_form'),
    }));

  if (todos.length === 0) return null;

  return (
    <div className="todo-card">
      <div className="todo-title">Tasks</div>
      {todos.map((todo, i) => {
        const s = todo.status.toLowerCase();
        const isComplete = s === 'completed' || s === 'done';
        const isActive = s === 'in_progress' || s === 'active';
        return (
          <div key={i} className="todo-row">
            <div className={`todo-circle ${isComplete ? 'todo-circle-complete' : ''}`}>
              {isComplete && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
            <span className={`todo-text ${isComplete ? 'todo-complete' : ''} ${!isComplete && !isActive ? 'todo-pending' : ''}`}>
              {isActive ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Question Card ──────────────────────────────────

export function QuestionCard({ block, result }: { block: ContentBlock & { type: 'tool_use' }; result?: string | null }) {
  const input = block.input as Record<string, unknown>;
  const questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }> = Array.isArray(input?.questions) ? (input.questions as never[]) : [];

  if (questions.length === 0) return null;

  const answerText = result ?? '';

  return (
    <div className="question-card">
      {questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? 'question-group' : undefined}>
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {q.options.map((opt, oi) => {
              const isSelected = answerText.includes(opt.label);
              return (
                <div key={oi} className={`question-option ${isSelected ? 'question-option-selected' : ''}`}>
                  <span className="question-option-label">{opt.label}</span>
                  {opt.description && <span className="question-option-desc">{opt.description}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tool Use Card ──────────────────────────────────

export function ToolUseCard({ name, input, result, isRunning }: {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isRunning?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = getToolDisplay(name, input);
  const isCompleted = result !== undefined;
  const hasDiff = isEditWithDiff(name, input);

  return (
    <div className="tool-block">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-header-left">
          <span className="tool-label">{display.label}</span>
          <span className={`tool-title ${!isCompleted && isRunning ? 'shimmer' : ''}`}>
            {display.title}
          </span>
        </div>
        <div className="tool-header-right">
          <div className={`tool-status-dot ${isCompleted ? 'tool-status-complete' : 'tool-status-running'}`} />
          <span className="tool-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>
            &#9654;
          </span>
        </div>
      </div>
      {expanded && (
        <div className="tool-body">
          {hasDiff ? (
            <DiffView
              filePath={pickString(input, 'file_path', 'path', 'file') || undefined}
              oldStr={input.old_string as string}
              newStr={input.new_string as string}
            />
          ) : (
            <pre className="tool-input">{JSON.stringify(input, null, 2)}</pre>
          )}
          {result !== undefined && (
            <>
              <div className="tool-divider" />
              <pre className="tool-result">
                {typeof result === 'string' ? result.slice(0, 3000) : JSON.stringify(result, null, 2).slice(0, 3000)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking Block ──────────────────────────────────

export function ThinkingBlock({ text, animate }: { text: string; animate?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-chevron" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>
          &#9654;
        </span>
        <span className={animate ? 'shimmer' : ''}>Thinking...</span>
      </div>
      {expanded && (
        <div className="thinking-body">{text}</div>
      )}
    </div>
  );
}

// ── Markdown Content ──────────────────────────────────

export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !className;
            if (isInline) {
              return <code className="inline-code" {...props}>{children}</code>;
            }
            return (
              <div className="code-block-wrapper">
                {match && <div className="code-lang">{match[1]}</div>}
                <pre className="code-block">
                  <code className={className} {...props}>{children}</code>
                </pre>
              </div>
            );
          },
          a({ children, href, ...props }) {
            return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── Content Blocks Rendering ──────────────────────────────────

export function renderContentBlocks(
  blocks: ContentBlock[],
  toolResultMap: Map<string, string>,
  isLastMessage: boolean,
  agentRunning: boolean,
) {
  const groups: Array<{ type: 'markdown'; text: string } | { type: 'block'; block: ContentBlock; index: number }> = [];
  let pendingText = '';

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'text') {
      pendingText += (pendingText ? '\n\n' : '') + block.text;
    } else {
      if (pendingText) {
        groups.push({ type: 'markdown', text: pendingText });
        pendingText = '';
      }
      if (block.type !== 'tool_result') {
        groups.push({ type: 'block', block, index: i });
      }
    }
  }
  if (pendingText) {
    groups.push({ type: 'markdown', text: pendingText });
  }

  return groups.map((group, gi) => {
    if (group.type === 'markdown') {
      return <MarkdownContent key={`md-${gi}`} text={group.text} />;
    }

    const { block } = group;

    if (block.type === 'tool_use') {
      const result = toolResultMap.get(block.id);
      const toolRunning = agentRunning && isLastMessage && result === undefined;

      if (isTodoTool(block.name)) {
        return <TodoWriteCard key={`b-${gi}`} block={block as ContentBlock & { type: 'tool_use' }} />;
      }
      if (isQuestionTool(block.name)) {
        return <QuestionCard key={`b-${gi}`} block={block as ContentBlock & { type: 'tool_use' }} result={result} />;
      }

      return (
        <ToolUseCard
          key={`b-${gi}`}
          name={block.name}
          input={block.input}
          result={result}
          isRunning={toolRunning}
        />
      );
    }

    if (block.type === 'thinking') {
      const animateThinking = agentRunning && isLastMessage;
      return <ThinkingBlock key={`b-${gi}`} text={block.text} animate={animateThinking} />;
    }

    return null;
  });
}

// ── Message Row ──────────────────────────────────

export function MessageRow({ message, toolResultMap, isLastMessage, agentRunning, isStreaming }: {
  message: AgentMessage;
  toolResultMap: Map<string, string>;
  isLastMessage: boolean;
  agentRunning: boolean;
  isStreaming?: boolean;
}) {
  if (message.type === 'system') {
    return (
      <div className="system-message">
        {typeof message.content === 'string' ? message.content : 'System message'}
      </div>
    );
  }

  if (message.type === 'user') {
    return (
      <div className="user-message-row">
        <div className="user-message">
          {typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content.filter(b => b.type === 'text').map((b, i) => <span key={i}>{(b as { text: string }).text}</span>)
              : String(message.content)}
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="assistant-message-row">
      <div className="assistant-message">
        {typeof message.content === 'string' ? (
          <>
            <MarkdownContent text={message.content} />
            {isStreaming && <span className="streaming-cursor" />}
          </>
        ) : (
          renderContentBlocks(message.content, toolResultMap, isLastMessage, agentRunning)
        )}
      </div>
    </div>
  );
}

// ── Permission Banner ──────────────────────────────────

export function PermissionBanner({
  permission,
  onRespond,
}: {
  permission: PermissionRequest;
  onRespond: (requestId: string, behavior: 'allow' | 'deny') => void;
}) {
  const description = permission.toolInput.command
    ? `${permission.toolName}: ${String(permission.toolInput.command)}`
    : permission.toolInput.file_path
      ? `${permission.toolName}: ${String(permission.toolInput.file_path)}`
      : permission.toolName;

  return (
    <div className="permission-card">
      <div className="permission-title">Permission Required</div>
      <div className="permission-desc">{description}</div>
      <div className="permission-buttons">
        <button className="permission-btn permission-btn-deny" onClick={() => onRespond(permission.requestId, 'deny')}>Deny</button>
        <button className="permission-btn permission-btn-allow" onClick={() => onRespond(permission.requestId, 'allow')}>Allow</button>
      </div>
    </div>
  );
}
