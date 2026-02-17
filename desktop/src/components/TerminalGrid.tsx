import { useMemo, useState, useCallback, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import type { AgentState, AgentAction, AgentStatus, Project } from '@shared/types';
import { TerminalPane } from './TerminalPane';

const statusColors: Record<AgentStatus, string> = {
  running: 'var(--status-running)',
  awaiting_permission: 'var(--status-awaiting)',
  error: 'var(--status-error)',
  idle: 'var(--status-idle)',
  starting: 'var(--status-starting)',
  connected: 'var(--status-starting)',
  exited: 'var(--status-exited)',
};

interface TerminalGridProps {
  agents: Map<string, AgentState>;
  agentOrder: string[];
  projects?: Project[];
  colorfulGitLabels?: boolean;
  dispatch: React.Dispatch<AgentAction>;
  onSendMessage: (agentId: string, text: string) => void;
  onInterrupt: (agentId: string) => void;
  onRespondPermission: (agentId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  onSetAutoApprove: (agentId: string, enabled: boolean) => void;
  onDestroy: (agentId: string) => void;
  onRequestHistory: (agentId: string) => void;
  onCreateAgent: () => void;
}

function getColCount(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 3) return 3;
  if (count <= 4) return 2;
  return 3;
}

function getPaneBasis(count: number): string {
  const cols = getColCount(count);
  return `${100 / cols}%`;
}

function DragOverlayContent({ agent }: { agent: AgentState }) {
  const costStr = agent.totalCost > 0
    ? agent.totalCost < 0.01 ? '<$0.01' : `$${agent.totalCost.toFixed(2)}`
    : '';

  return (
    <div className="terminal-pane drag-overlay-pane">
      <div className="pane-header" style={{ cursor: 'grabbing' }}>
        <div className="pane-header-left">
          <div className="pane-type-icon">
            {agent.type[0]?.toUpperCase()}
          </div>
          {agent.model && <span className="pane-model">{agent.model}</span>}
          <div className="pane-status-dot" style={{ background: statusColors[agent.status] }} />
        </div>
        <div className="pane-header-right">
          {agent.contextUsedPercent > 0 && (
            <span className="pane-context">{Math.round(agent.contextUsedPercent)}%</span>
          )}
          {costStr && <span className="pane-cost">{costStr}</span>}
        </div>
      </div>
      <div className="pane-messages" style={{ flex: 1, opacity: 0.6 }}>
        <div className="pane-empty">
          {agent.messages.length} messages
        </div>
      </div>
    </div>
  );
}

export function TerminalGrid({
  agents,
  agentOrder,
  projects,
  colorfulGitLabels,
  dispatch,
  onSendMessage,
  onInterrupt,
  onRespondPermission,
  onSetAutoApprove,
  onDestroy,
  onRequestHistory,
  onCreateAgent,
}: TerminalGridProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);
  const wrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const orderedAgents = useMemo(() => {
    const result: AgentState[] = [];
    for (const id of agentOrder) {
      const agent = agents.get(id);
      if (agent) result.push(agent);
    }
    for (const [id, agent] of agents) {
      if (!agentOrder.includes(id)) result.push(agent);
    }
    return result;
  }, [agents, agentOrder]);

  const sortableIds = useMemo(() => orderedAgents.map(a => a.id), [orderedAgents]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveId(id);
    const el = wrapperRefs.current.get(id);
    if (el) {
      const rect = el.getBoundingClientRect();
      setDragSize({ width: rect.width, height: rect.height });
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    setOverId(over ? String(over.id) : null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverId(null);
    setDragSize(null);
    if (!over || active.id === over.id) return;

    const oldIndex = sortableIds.indexOf(String(active.id));
    const newIndex = sortableIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = arrayMove(sortableIds, oldIndex, newIndex);
    dispatch({ type: 'REORDER_AGENTS', order: newOrder });
  }, [sortableIds, dispatch]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
    setDragSize(null);
  }, []);

  const setWrapperRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      wrapperRefs.current.set(id, el);
    } else {
      wrapperRefs.current.delete(id);
    }
  }, []);

  if (orderedAgents.length === 0) {
    return (
      <div className="terminal-grid-empty">
        <div style={{ fontSize: 14 }}>No agents running</div>
        <button onClick={onCreateAgent} className="terminal-grid-create-btn">
          Create Agent
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          <kbd className="kbd">N</kbd> New agent
        </div>
      </div>
    );
  }

  const count = orderedAgents.length;
  const cols = getColCount(count);
  const rows = Math.ceil(count / cols);
  const basis = getPaneBasis(count);
  const rowHeight = `${100 / rows}%`;

  const activeAgent = activeId ? agents.get(activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        <div className="terminal-grid">
          {orderedAgents.map((agent) => {
            const isDragSource = activeId === agent.id;
            const isDropTarget = overId === agent.id && overId !== activeId;

            return (
              <div
                key={agent.id}
                ref={(el) => setWrapperRef(agent.id, el)}
                className={`terminal-pane-wrapper ${isDropTarget ? 'pane-drop-target' : ''}`}
                style={{ flex: `0 0 ${basis}`, maxWidth: basis, height: rowHeight }}
              >
                <TerminalPane
                  agent={agent}
                  projects={projects}
                  colorfulGitLabels={colorfulGitLabels}
                  onSendMessage={(text) => onSendMessage(agent.id, text)}
                  onInterrupt={() => onInterrupt(agent.id)}
                  onRespondPermission={(requestId, behavior) => onRespondPermission(agent.id, requestId, behavior)}
                  onSetAutoApprove={(enabled) => onSetAutoApprove(agent.id, enabled)}
                  onDestroy={() => onDestroy(agent.id)}
                  onRequestHistory={() => onRequestHistory(agent.id)}
                />
                {isDragSource && <div className="pane-drag-source-overlay" />}
              </div>
            );
          })}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeAgent && dragSize ? (
          <div style={{ width: dragSize.width, height: dragSize.height }}>
            <DragOverlayContent agent={activeAgent} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
