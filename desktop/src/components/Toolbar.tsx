import type { ConnectionStatus } from '@shared/types';

interface ToolbarProps {
  connectionStatus: ConnectionStatus;
  onCreateAgent: () => void;
}

const statusColors: Record<ConnectionStatus, string> = {
  connected: 'var(--status-running)',
  connecting: 'var(--status-awaiting)',
  disconnected: 'var(--status-error)',
};

const statusLabels: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
};

export function Toolbar({ connectionStatus, onCreateAgent }: ToolbarProps) {
  return (
    <div style={{
      height: 49,
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      flexShrink: 0,
      background: 'var(--bg-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontWeight: 500, fontSize: 14, letterSpacing: '-0.02em' }}>
          Mobile Agent
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: statusColors[connectionStatus],
            transition: 'background 0.2s',
          }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {statusLabels[connectionStatus]}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onCreateAgent}
          disabled={connectionStatus !== 'connected'}
          style={{
            background: connectionStatus === 'connected' ? 'var(--text)' : 'var(--bg-active)',
            color: connectionStatus === 'connected' ? 'var(--bg)' : 'var(--text-muted)',
            border: 'none',
            padding: '6px 14px',
            borderRadius: 6,
            cursor: connectionStatus === 'connected' ? 'pointer' : 'default',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          New Session
        </button>
      </div>
    </div>
  );
}
