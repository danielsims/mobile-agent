import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentState } from '@shared/types';
import {
  buildToolResultMap,
  MessageRow,
  PermissionBanner,
} from './AgentMessages';

interface AgentDetailProps {
  agent: AgentState;
  onBack: () => void;
  onSendMessage: (text: string) => void;
  onInterrupt: () => void;
  onRespondPermission: (requestId: string, behavior: 'allow' | 'deny') => void;
  onDestroy: () => void;
  onRequestHistory: () => void;
}

function StatusBar({ agent }: { agent: AgentState }) {
  const statusText = agent.status === 'running' ? 'Running'
    : agent.status === 'awaiting_permission' ? 'Awaiting permission'
    : agent.status === 'error' ? 'Error'
    : agent.status === 'starting' ? 'Starting'
    : 'Idle';

  return (
    <div className="status-bar">
      <div className="status-left">
        <span>Context: {Math.round(agent.contextUsedPercent)}%</span>
        <div className="context-bar">
          <div className="context-fill" style={{
            width: `${Math.min(agent.contextUsedPercent, 100)}%`,
            background: agent.contextUsedPercent > 80 ? 'var(--danger)'
              : agent.contextUsedPercent > 50 ? 'var(--starred)'
              : 'var(--accent)',
          }} />
        </div>
      </div>
      <span className="status-label">{statusText}</span>
      {agent.totalCost > 0 && <span>${agent.totalCost.toFixed(2)}</span>}
    </div>
  );
}

export function AgentDetail({
  agent,
  onBack,
  onSendMessage,
  onInterrupt,
  onRespondPermission,
  onDestroy,
  onRequestHistory,
}: AgentDetailProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRequestedRef = useRef(false);
  const isAtBottomRef = useRef(true);

  const toolResultMap = useMemo(() => buildToolResultMap(agent.messages), [agent.messages]);

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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement !== inputRef.current) {
        onBack();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onSendMessage(text);
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [input, onSendMessage]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const permissions = Array.from(agent.pendingPermissions.values());
  const agentRunning = agent.status === 'running';

  const lastMsg = agent.messages[agent.messages.length - 1];
  const lastIsStreaming = agentRunning && lastMsg?.type === 'assistant' && typeof lastMsg.content === 'string';

  return (
    <div className="agent-detail">
      {/* Header */}
      <div className="detail-header">
        <button onClick={onBack} className="back-btn">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <div className="header-info">
          <span className="header-name">{agent.sessionName}</span>
          <div className="header-dot" style={{
            background: agent.status === 'running' ? 'var(--status-running)'
              : agent.status === 'awaiting_permission' ? 'var(--status-awaiting)'
              : agent.status === 'error' ? 'var(--status-error)'
              : 'var(--status-idle)',
          }} />
          {agent.model && <span className="header-model">{agent.model}</span>}
          {agent.projectName && <span className="header-project">{agent.projectName}</span>}
          {agent.gitBranch && <span className="header-branch">{agent.gitBranch}</span>}
        </div>
        <div className="header-actions">
          {agent.status === 'running' && (
            <button onClick={onInterrupt} className="btn-interrupt">Interrupt</button>
          )}
          <button onClick={onDestroy} className="btn-destroy">Destroy</button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="messages-container" onScroll={handleScroll}>
        {agent.messages.length === 0 && (
          <div className="empty-messages">
            <div style={{ fontSize: 13, marginBottom: 4 }}>No messages yet</div>
            <div style={{ fontSize: 11 }}>Send a message to get started</div>
          </div>
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

        {/* Streaming dots when running but no streaming text yet */}
        {agentRunning && !lastIsStreaming && agent.messages.length > 0 && (
          <div className="assistant-message-row">
            <div className="streaming-indicator">
              <span className="streaming-dot" />
              <span className="streaming-dot" style={{ animationDelay: '0.15s' }} />
              <span className="streaming-dot" style={{ animationDelay: '0.3s' }} />
            </div>
          </div>
        )}

        {/* Permission banners */}
        {permissions.map((perm) => (
          <PermissionBanner key={perm.requestId} permission={perm} onRespond={onRespondPermission} />
        ))}
      </div>

      <StatusBar agent={agent} />

      {/* Input area */}
      <div className="input-area">
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
          placeholder={agentRunning ? 'Agent is running...' : 'Send a message...'}
          rows={1}
          className="message-input"
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim()}
          className={`send-btn ${input.trim() ? 'send-btn-active' : ''}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
