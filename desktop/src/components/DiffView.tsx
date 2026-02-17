interface DiffViewProps {
  filePath: string;
  diff: string | undefined;
  onClose: () => void;
}

function parseDiffLines(diff: string) {
  return diff.split('\n').map((line) => {
    if (line.startsWith('@@')) return { type: 'header' as const, text: line };
    if (line.startsWith('+')) return { type: 'added' as const, text: line };
    if (line.startsWith('-')) return { type: 'removed' as const, text: line };
    return { type: 'context' as const, text: line };
  });
}

export function DiffView({ filePath, diff, onClose }: DiffViewProps) {
  return (
    <div className="diffview">
      <div className="diffview-header">
        <button className="diffview-close-btn" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 2 4 6 8 10" />
          </svg>
          Back
        </button>
        <span className="diffview-filepath">{filePath}</span>
      </div>

      <div className="diffview-content">
        {!diff ? (
          <div className="diffview-loading">
            <div className="git-loading-bar shimmer" style={{ width: '40%' }} />
            <div className="git-loading-bar shimmer" style={{ width: '60%', animationDelay: '0.2s' }} />
            <div className="git-loading-bar shimmer" style={{ width: '50%', animationDelay: '0.4s' }} />
          </div>
        ) : diff.length === 0 ? (
          <div className="diffview-empty">No changes</div>
        ) : (
          <div className="diffview-lines">
            {parseDiffLines(diff).map((line, i) => (
              <div
                key={i}
                className={`diffview-line ${
                  line.type === 'added' ? 'diffview-line-added' :
                  line.type === 'removed' ? 'diffview-line-removed' :
                  line.type === 'header' ? 'diffview-line-header' : ''
                }`}
              >
                <span className="diffview-line-num">
                  {line.type === 'context' || line.type === 'added' || line.type === 'removed' ? i + 1 : ''}
                </span>
                <span className="diffview-line-prefix">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : line.type === 'header' ? '@@' : ' '}
                </span>
                <span className="diffview-line-text">{
                  line.type === 'header' ? line.text :
                  line.type === 'added' ? line.text.slice(1) :
                  line.type === 'removed' ? line.text.slice(1) :
                  line.text
                }</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
