import type { Theme, Settings } from '../hooks/useSettings';

interface SettingsPanelProps {
  settings: Settings;
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onBack?: () => void;
}

const themes: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

export function SettingsPanel({ settings, onUpdateSetting }: SettingsPanelProps) {
  return (
    <div className="settings-panel">
      <div className="sidebar-header">Settings</div>

      <div className="settings-content">
        <div className="settings-section">
          <div className="settings-section-label">Appearance</div>

          <div className="settings-row">
            <span className="settings-row-label">Theme</span>
            <div className="settings-theme-picker">
              {themes.map((t) => (
                <button
                  key={t.value}
                  className={`settings-theme-btn ${settings.theme === t.value ? 'settings-theme-btn-active' : ''}`}
                  onClick={() => onUpdateSetting('theme', t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row-label">Colorful git labels</span>
            <button
              className={`settings-toggle ${settings.colorfulGitLabels ? 'settings-toggle-on' : ''}`}
              onClick={() => onUpdateSetting('colorfulGitLabels', !settings.colorfulGitLabels)}
            >
              <div className="settings-toggle-knob" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
