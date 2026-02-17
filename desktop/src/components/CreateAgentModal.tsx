import { useState, useEffect, useCallback, type ReactNode } from 'react';
import type { Project, ProviderModelOption, AgentType } from '@shared/types';

interface CreateAgentModalProps {
  projects: Project[];
  models: ProviderModelOption[];
  onClose: () => void;
  onCreate: (opts: {
    agentType: AgentType;
    projectId: string | null;
    worktreePath: string | null;
    model: string;
    prompt: string;
  }) => void;
  onRequestModels: (agentType: AgentType) => void;
  onRequestProjects: () => void;
}

type Step = 'type' | 'model' | 'project';

const CLAUDE_LOGO_PATH = 'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';
const OPENAI_LOGO_PATH = 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

function AgentTypeIcon({ type, color }: { type: AgentType; color: string }): ReactNode {
  if (type === 'claude') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path d={CLAUDE_LOGO_PATH} fill={color} fillRule="nonzero" />
      </svg>
    );
  }
  if (type === 'codex') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path d={OPENAI_LOGO_PATH} fill={color} fillRule="evenodd" />
      </svg>
    );
  }
  if (type === 'opencode') {
    return (
      <svg width="12" height="20" viewBox="0 0 24 42" fill="none">
        <path d="M18 30H6V18H18V30Z" fill="#4B4646" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="#B7B1B1" />
      </svg>
    );
  }
  return <span style={{ color, fontWeight: 700, fontSize: 13 }}>{type[0].toUpperCase()}</span>;
}

const AGENT_TYPES: { value: AgentType; label: string; color: string; bg: string }[] = [
  { value: 'claude', label: 'Claude Code', color: '#D97757', bg: '#FFFFFF' },
  { value: 'codex', label: 'Codex', color: '#111111', bg: '#FFFFFF' },
  { value: 'opencode', label: 'OpenCode', color: '#3B82F6', bg: '#FFFFFF' },
];

export function CreateAgentModal({
  projects,
  models,
  onClose,
  onCreate,
  onRequestModels,
  onRequestProjects,
}: CreateAgentModalProps) {
  const [step, setStep] = useState<Step>('type');
  const [selectedType, setSelectedType] = useState<AgentType>('claude');
  const [selectedModel, setSelectedModel] = useState('');

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Derive effective model — auto-select first model if none explicitly chosen
  const effectiveModel = selectedModel || (models.length > 0 ? models[0].value : '');

  const handleTypeSelect = useCallback((type: AgentType) => {
    setSelectedType(type);
    setSelectedModel('');
    onRequestModels(type);
    setStep('model');
  }, [onRequestModels]);

  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
    onRequestProjects();
    setStep('project');
  }, [onRequestProjects]);

  const handleSubmit = useCallback((projectId: string | null, worktreePath: string | null) => {
    onCreate({
      agentType: selectedType,
      projectId,
      worktreePath,
      model: effectiveModel,
      prompt: '',
    });
    onClose();
  }, [selectedType, effectiveModel, onCreate, onClose]);

  const handleBack = useCallback(() => {
    if (step === 'model') setStep('type');
    else if (step === 'project') setStep('model');
  }, [step]);

  const stepTitle = step === 'type' ? 'New Agent' : step === 'model' ? 'Select Model' : 'Select Project';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="create-modal"
      >
        {/* Header */}
        <div className="create-modal-header">
          {step !== 'type' && (
            <button className="create-modal-back" onClick={handleBack}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="8 2 4 6 8 10" />
              </svg>
            </button>
          )}
          <h2 className="create-modal-title">{stepTitle}</h2>
          <button className="create-modal-close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="10" y2="10" />
              <line x1="10" y1="2" x2="2" y2="10" />
            </svg>
          </button>
        </div>

        {/* Step 1: Agent Type */}
        {step === 'type' && (
          <div className="create-modal-body">
            {AGENT_TYPES.map((t) => (
              <button
                key={t.value}
                className="create-modal-row"
                onClick={() => handleTypeSelect(t.value)}
              >
                <div className="create-modal-row-icon" style={{ background: t.bg }}>
                  <AgentTypeIcon type={t.value} color={t.color} />
                </div>
                <span className="create-modal-row-label">{t.label}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                  <polyline points="4 2 8 6 4 10" />
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Model */}
        {step === 'model' && (
          <div className="create-modal-body">
            {models.length === 0 ? (
              <div className="create-modal-loading">Loading models...</div>
            ) : (
              models.map((m) => (
                <button
                  key={m.value}
                  className={`create-modal-row ${effectiveModel === m.value ? 'create-modal-row-selected' : ''}`}
                  onClick={() => handleModelSelect(m.value)}
                >
                  <span className="create-modal-row-label">{m.label}</span>
                  {m.note && <span className="create-modal-row-note">{m.note}</span>}
                </button>
              ))
            )}
          </div>
        )}

        {/* Step 3: Project */}
        {step === 'project' && (
          <div className="create-modal-body">
            {/* No project option */}
            <button
              className="create-modal-row"
              onClick={() => handleSubmit(null, null)}
            >
              <div className="create-modal-row-icon" style={{ background: 'var(--bg-active)' }}>
                ~
              </div>
              <div style={{ flex: 1 }}>
                <span className="create-modal-row-label">No project</span>
                <span className="create-modal-row-hint">Starts in home directory</span>
              </div>
            </button>

            {/* Projects list */}
            {projects.map((p) => (
              <div key={p.id} className="create-modal-project-group">
                <button
                  className="create-modal-row"
                  onClick={() => {
                    const mainWt = p.worktrees.find(w => w.isMain);
                    handleSubmit(p.id, mainWt?.path || null);
                  }}
                >
                  {p.icon ? (
                    <img src={p.icon} className="create-modal-row-favicon" alt="" />
                  ) : (
                    <div className="create-modal-row-icon" style={{ background: 'var(--bg-active)' }}>
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="create-modal-row-label">{p.name}</span>
                  {p.worktrees.length > 1 && (
                    <span className="create-modal-row-note">{p.worktrees.length} worktrees</span>
                  )}
                </button>

                {/* Show worktrees if more than 1 */}
                {p.worktrees.length > 1 && p.worktrees.filter(w => !w.isMain).map((wt) => (
                  <button
                    key={wt.path}
                    className="create-modal-row create-modal-row-indent"
                    onClick={() => handleSubmit(p.id, wt.path)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.4 }}>
                      <circle cx="4" cy="4" r="1.5" />
                      <circle cx="4" cy="12" r="1.5" />
                      <line x1="4" y1="5.5" x2="4" y2="10.5" />
                    </svg>
                    <span className="create-modal-row-label">{wt.branch}</span>
                  </button>
                ))}
              </div>
            ))}

          </div>
        )}
      </div>
    </div>
  );
}
