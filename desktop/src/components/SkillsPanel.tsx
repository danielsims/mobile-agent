import { useState, useCallback } from 'react';
import type { Skill } from '@shared/types';

export interface SkillSearchResult {
  name: string;
  description: string;
  packageRef: string;
  url?: string;
}

interface SkillsPanelProps {
  skills: Skill[];
  searchResults: SkillSearchResult[];
  searchLoading: boolean;
  installStatus: string | null;
  onSearchSkills: (query: string) => void;
  onClearSearchResults: () => void;
  onInstallSkill: (packageRef: string) => void;
  onUpdateSkill: (name: string, body: string) => void;
}

export function SkillsPanel({
  skills,
  searchResults,
  searchLoading,
  installStatus,
  onSearchSkills,
  onClearSearchResults,
  onInstallSkill,
  onUpdateSkill,
}: SkillsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');

  const userSkills = skills.filter(s => s.source === 'user');

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (!value.trim()) {
      onClearSearchResults();
    }
  }, [onClearSearchResults]);

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      onSearchSkills(searchQuery.trim());
    }
  }, [searchQuery, onSearchSkills]);

  const handleStartEdit = useCallback((skill: Skill) => {
    setEditingSkill(skill.name);
    setEditBody(skill.body);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editingSkill) {
      onUpdateSkill(editingSkill, editBody);
      setEditingSkill(null);
    }
  }, [editingSkill, editBody, onUpdateSkill]);

  return (
    <div className="skills-panel">
      <div className="sidebar-header">Skills</div>

      <div className="skills-search">
        <input
          type="text"
          className="skills-search-input"
          placeholder="Search skills marketplace..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch();
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section">
        {searchLoading && (
          <div className="skills-loading">
            <div className="git-loading-bar shimmer" />
            <div className="git-loading-bar shimmer" style={{ width: '70%', animationDelay: '0.2s' }} />
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="skills-group">
            <div className="skills-group-label">Search Results</div>
            {searchResults.map((result) => (
              <div key={result.packageRef} className="skill-row">
                <div className="skill-info">
                  <span className="skill-name">{result.name}</span>
                  <span className="skill-desc">{result.description}</span>
                </div>
                <button
                  className="skill-action-btn"
                  onClick={() => onInstallSkill(result.packageRef)}
                  disabled={installStatus === 'installing'}
                >
                  {installStatus === 'installing' ? '...' : 'Install'}
                </button>
              </div>
            ))}
          </div>
        )}

        {userSkills.length > 0 && (
          <div className="skills-group">
            <div className="skills-group-label">Installed</div>
            {userSkills.map((skill) => (
              <div key={skill.name} className="skill-row">
                {editingSkill === skill.name ? (
                  <div className="skill-edit">
                    <textarea
                      className="skill-edit-textarea"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="skill-edit-actions">
                      <button className="skill-action-btn" onClick={handleSaveEdit}>Save</button>
                      <button className="skill-action-btn skill-action-btn-muted" onClick={() => setEditingSkill(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="skill-info" onClick={() => handleStartEdit(skill)}>
                      <span className="skill-name">{skill.name}</span>
                      <span className="skill-desc">{skill.description}</span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {!searchLoading && searchResults.length === 0 && userSkills.length === 0 && (
          <div className="sidebar-empty">
            No skills installed<br />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Search above to find and install skills
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
