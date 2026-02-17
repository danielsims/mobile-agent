import { useMemo } from 'react';
import type { AgentState, Project, Skill } from '@shared/types';
import type { Settings } from '../hooks/useSettings';
import type { ActivityTab } from './ActivityBar';
import { SettingsPanel } from './SettingsPanel';
import { SkillsPanel, type SkillSearchResult } from './SkillsPanel';
import { MobilePanel, type PairingInfo } from './MobilePanel';

export interface GitFileEntry {
  file: string;
  status: string;
}

export interface GitStatusData {
  branch: string | null;
  files: GitFileEntry[];
  ahead: number;
  behind: number;
}

interface SidebarProps {
  activeTab: ActivityTab;
  agents: Map<string, AgentState>;
  projects: Project[];
  settings: Settings;
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  gitDataMap: Map<string, GitStatusData>;
  loadingGitStatus: Set<string>;
  onFileClick: (agentId: string, filePath: string) => void;
  activeFile: { agentId: string; filePath: string } | null;
  // Skills
  skills: Skill[];
  searchResults: SkillSearchResult[];
  searchLoading: boolean;
  installStatus: string | null;
  onSearchSkills: (query: string) => void;
  onClearSearchResults: () => void;
  onInstallSkill: (packageRef: string) => void;
  onUpdateSkill: (name: string, body: string) => void;
  // Mobile
  onRequestPairingInfo: () => void;
  pairingInfo: PairingInfo | null;
  pairingError: string | null;
  tunnelAvailable: boolean;
}

const statusColors: Record<string, string> = {
  M: '#e2c08d',
  A: '#73c991',
  D: '#c74e39',
  R: '#73c991',
  U: '#e2c08d',
  '?': '#8a8980',
};

interface ProjectGroup {
  projectName: string;
  branch: string | null;
  agentId: string;
  files: GitFileEntry[];
  icon: string | null;
}

function matchProjectForAgent(agent: AgentState, projects: Project[]): Project | null {
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

function GitPanel({
  agents,
  projects,
  gitDataMap,
  loadingGitStatus,
  onFileClick,
  activeFile,
}: {
  agents: Map<string, AgentState>;
  projects: Project[];
  gitDataMap: Map<string, GitStatusData>;
  loadingGitStatus: Set<string>;
  onFileClick: (agentId: string, filePath: string) => void;
  activeFile: { agentId: string; filePath: string } | null;
}) {
  const projectGroups = useMemo(() => {
    const groups: ProjectGroup[] = [];
    const seen = new Set<string>();

    for (const agent of agents.values()) {
      if (!agent.cwd) continue;

      const key = agent.projectName || agent.cwd;
      if (seen.has(key)) continue;
      seen.add(key);

      const gitData = gitDataMap.get(agent.id);
      const matched = matchProjectForAgent(agent, projects);
      groups.push({
        projectName: agent.projectName || key.split('/').pop() || key,
        branch: gitData?.branch ?? agent.gitBranch,
        agentId: agent.id,
        files: gitData?.files ?? [],
        icon: matched?.icon ?? null,
      });
    }
    return groups;
  }, [agents, projects, gitDataMap]);

  return (
    <>
      <div className="sidebar-header">Git</div>
      <div className="sidebar-section">
        {projectGroups.length === 0 && (
          <div className="sidebar-empty">No agents with projects</div>
        )}

        {projectGroups.map((group) => {
          const isLoading = loadingGitStatus.has(group.agentId);

          return (
            <div key={group.agentId} className="git-project-group">
              <div className="git-project-header">
                {group.icon ? (
                  <img src={group.icon} className="git-project-icon" alt="" />
                ) : (
                  <div className="git-project-icon git-project-icon-letter">
                    {group.projectName.charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="git-project-name">{group.projectName}</span>
                {group.branch && (
                  <span className="git-project-branch">{group.branch}</span>
                )}
              </div>

              {isLoading && group.files.length === 0 ? (
                <div className="git-loading">
                  <div className="git-loading-bar shimmer" />
                  <div className="git-loading-bar shimmer" style={{ width: '60%', animationDelay: '0.2s' }} />
                  <div className="git-loading-bar shimmer" style={{ width: '80%', animationDelay: '0.4s' }} />
                </div>
              ) : group.files.length === 0 ? (
                <div className="git-clean">Clean</div>
              ) : (
                <div className="git-file-list">
                  {group.files.map((f) => {
                    const isActive = activeFile?.agentId === group.agentId && activeFile?.filePath === f.file;
                    const statusLetter = f.status[0]?.toUpperCase() || '?';

                    return (
                      <div
                        key={f.file}
                        className={`git-file-row ${isActive ? 'git-file-row-active' : ''}`}
                        onClick={() => onFileClick(group.agentId, f.file)}
                      >
                        <span
                          className="git-file-status"
                          style={{ color: statusColors[statusLetter] || 'var(--text-muted)' }}
                        >
                          {statusLetter}
                        </span>
                        <span className="git-file-name">{f.file}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function Sidebar({
  activeTab,
  agents,
  projects,
  settings,
  onUpdateSetting,
  gitDataMap,
  loadingGitStatus,
  onFileClick,
  activeFile,
  skills,
  searchResults,
  searchLoading,
  installStatus,
  onSearchSkills,
  onClearSearchResults,
  onInstallSkill,
  onUpdateSkill,
  onRequestPairingInfo,
  pairingInfo,
  pairingError,
  tunnelAvailable,
}: SidebarProps) {
  return (
    <div className="sidebar">
      {activeTab === 'git' && (
        <GitPanel
          agents={agents}
          projects={projects}
          gitDataMap={gitDataMap}
          loadingGitStatus={loadingGitStatus}
          onFileClick={onFileClick}
          activeFile={activeFile}
        />
      )}

      {activeTab === 'skills' && (
        <SkillsPanel
          skills={skills}
          searchResults={searchResults}
          searchLoading={searchLoading}
          installStatus={installStatus}
          onSearchSkills={onSearchSkills}
          onClearSearchResults={onClearSearchResults}
          onInstallSkill={onInstallSkill}
          onUpdateSkill={onUpdateSkill}
        />
      )}

      {activeTab === 'mobile' && (
        <MobilePanel
          onRequestPairingInfo={onRequestPairingInfo}
          pairingInfo={pairingInfo}
          pairingError={pairingError}
          tunnelAvailable={tunnelAvailable}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsPanel
          settings={settings}
          onUpdateSetting={onUpdateSetting}
          onBack={() => {/* no-op: activity bar handles navigation */}}
        />
      )}
    </div>
  );
}
