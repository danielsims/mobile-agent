import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import type { AgentState, AgentStatus, Project } from '@shared/types';
import {
  buildToolResultMap,
  MessageRow,
  PermissionBanner,
} from './AgentMessages';

const statusColors: Record<AgentStatus, string> = {
  running: 'var(--status-running)',
  awaiting_permission: 'var(--status-awaiting)',
  error: 'var(--status-error)',
  idle: 'var(--status-idle)',
  starting: 'var(--status-starting)',
  connected: 'var(--status-starting)',
  exited: 'var(--status-exited)',
};

function matchProject(agent: AgentState, projects: Project[]): Project | null {
  if (!projects.length) return null;
  if (agent.cwd) {
    for (const p of projects) {
      if (agent.cwd === p.path) return p;
      if (p.worktrees?.some(wt => agent.cwd === wt.path)) return p;
    }
  }
  if (agent.projectName) {
    return projects.find(p =>
      p.name === agent.projectName ||
      agent.projectName!.startsWith(p.name + '--')
    ) || null;
  }
  return null;
}

interface TerminalPaneProps {
  agent: AgentState;
  projects?: Project[];
  colorfulGitLabels?: boolean;
  onSendMessage: (text: string) => void;
  onInterrupt: () => void;
  onRespondPermission: (requestId: string, behavior: 'allow' | 'deny') => void;
  onSetAutoApprove: (enabled: boolean) => void;
  onDestroy: () => void;
  onRequestHistory: () => void;
}

export function TerminalPane({
  agent,
  projects = [],
  colorfulGitLabels = true,
  onSendMessage,
  onInterrupt,
  onRespondPermission,
  onSetAutoApprove,
  onDestroy,
  onRequestHistory,
}: TerminalPaneProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prefixRef = useRef<HTMLDivElement>(null);
  const [prefixWidth, setPrefixWidth] = useState(0);
  const historyRequestedRef = useRef(false);
  const isAtBottomRef = useRef(true);

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: agent.id });

  const toolResultMap = useMemo(() => buildToolResultMap(agent.messages), [agent.messages]);
  const matched = useMemo(() => matchProject(agent, projects), [agent, projects]);

  // Measure prefix width for text-indent + sync textarea height
  useEffect(() => {
    if (prefixRef.current) {
      setPrefixWidth(prefixRef.current.offsetWidth);
    }
    if (inputRef.current) {
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
    }
  }, [agent.projectName, agent.gitBranch]);

  useEffect(() => {
    if (!historyRequestedRef.current && agent.messages.length === 0) {
      historyRequestedRef.current = true;
      onRequestHistory();
    }
  }, [agent.messages.length, onRequestHistory]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  useEffect(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  const baseHeight = useRef(0);

  // Capture single-line height on mount
  useEffect(() => {
    if (inputRef.current && !baseHeight.current) {
      baseHeight.current = inputRef.current.scrollHeight;
      inputRef.current.style.height = `${baseHeight.current}px`;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onSendMessage(text);
    setInput('');
    if (inputRef.current && baseHeight.current) {
      inputRef.current.style.height = `${baseHeight.current}px`;
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [input, onSendMessage]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    const h = baseHeight.current || 0;
    el.style.height = `${h}px`;
    if (el.scrollHeight > h) {
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  const permissions = Array.from(agent.pendingPermissions.values());
  const agentRunning = agent.status === 'running';
  const lastMsg = agent.messages[agent.messages.length - 1];
  const lastIsStreaming = agentRunning && lastMsg?.type === 'assistant' && typeof lastMsg.content === 'string';

  const costStr = agent.totalCost > 0
    ? agent.totalCost < 0.01 ? '<$0.01' : `$${agent.totalCost.toFixed(2)}`
    : '';

  return (
    <div ref={setNodeRef} className={`terminal-pane ${isDragging ? 'pane-dragging' : ''}`}>
      {/* Header — drag handle */}
      <div className={`pane-header ${isDragging ? 'dragging' : ''}`} {...attributes} {...listeners}>
        <div className="pane-header-left">
          {matched?.icon ? (
            <img src={matched.icon} className="pane-project-icon" alt="" />
          ) : matched ? (
            <div className="pane-project-icon pane-project-icon-letter">
              {matched.name.charAt(0).toUpperCase()}
            </div>
          ) : (
            <div className="pane-type-icon">
              {agent.type[0]?.toUpperCase()}
            </div>
          )}
          {agent.model && (
            <span className="pane-model">{agent.model}</span>
          )}
          <div className="pane-status-dot" style={{ background: statusColors[agent.status] }} />
        </div>
        <div className="pane-header-right">
          <div
            className="pane-mode-toggle"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={`pane-mode-btn ${!agent.autoApprove ? 'pane-mode-btn-active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onSetAutoApprove(false); }}
            >
              Ask
            </button>
            <button
              type="button"
              className={`pane-mode-btn ${agent.autoApprove ? 'pane-mode-btn-active pane-mode-btn-auto' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onSetAutoApprove(true); }}
            >
              Auto
            </button>
          </div>
          {agent.contextUsedPercent > 0 && (
            <span className="pane-context">{Math.round(agent.contextUsedPercent)}%</span>
          )}
          {costStr && <span className="pane-cost">{costStr}</span>}
          {agentRunning && (
            <div className="pane-header-actions">
              <button
                className="pane-btn pane-btn-interrupt"
                onClick={(e) => { e.stopPropagation(); onInterrupt(); }}
                onPointerDown={(e) => e.stopPropagation()}
                title="Interrupt"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect x="1" y="1" width="8" height="8" rx="1" />
                </svg>
              </button>
            </div>
          )}
          <button
            className="pane-btn pane-btn-destroy"
            onClick={(e) => { e.stopPropagation(); onDestroy(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Destroy"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="pane-messages" onScroll={handleScroll}>
        {agent.messages.length === 0 && (
          <div className="pane-empty">No messages yet</div>
        )}

        {agent.messages.map((msg, i) => (
          <MessageRow
            key={msg.id}
            message={msg}
            toolResultMap={toolResultMap}
            isLastMessage={i === agent.messages.length - 1}
            agentRunning={agentRunning}
            isStreaming={lastIsStreaming && i === agent.messages.length - 1}
          />
        ))}

        {agentRunning && !lastIsStreaming && agent.messages.length > 0 && (
          <div className="assistant-message-row">
            <div className="streaming-indicator">
              <span className="streaming-dot" />
              <span className="streaming-dot" style={{ animationDelay: '0.15s' }} />
              <span className="streaming-dot" style={{ animationDelay: '0.3s' }} />
            </div>
          </div>
        )}

        {permissions.map((perm) => (
          <PermissionBanner key={perm.requestId} permission={perm} onRespond={onRespondPermission} />
        ))}
      </div>

      {/* Terminal-style prompt input */}
      <div className="pane-prompt" onPointerDown={(e) => e.stopPropagation()}>
        <div className="pane-prompt-scroll">
          <div className="pane-prompt-prefix" ref={prefixRef}>
            <span className="pane-prompt-arrow">→</span>
            {agent.projectName && (
              <>
                <span className={`pane-prompt-project ${colorfulGitLabels ? 'pane-project-color' : ''}`}>
                  {agent.projectName}
                </span>
                {agent.gitBranch && (
                  <>
                    <span className={`pane-prompt-git ${colorfulGitLabels ? 'pane-git-color' : ''}`}>
                      git:(
                    </span>
                    <span className={`pane-prompt-branch ${colorfulGitLabels ? 'pane-branch-color' : ''}`}>
                      {agent.gitBranch}
                    </span>
                    <span className={`pane-prompt-git ${colorfulGitLabels ? 'pane-git-color' : ''}`}>
                      )
                    </span>
                  </>
                )}
              </>
            )}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            className="pane-prompt-input"
            style={prefixWidth ? { textIndent: `${prefixWidth + 4}px` } : undefined}
            rows={1}
            disabled={agentRunning}
          />
        </div>
        {agentRunning ? (
          <button
            className="pane-prompt-btn pane-prompt-btn-stop"
            onClick={onInterrupt}
            title="Stop"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            className={`pane-prompt-btn pane-prompt-btn-send ${input.trim() ? '' : 'pane-prompt-btn-muted'}`}
            onClick={handleSubmit}
            disabled={!input.trim()}
            title="Send"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="10" x2="6" y2="2" />
              <polyline points="2 5 6 1.5 10 5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
