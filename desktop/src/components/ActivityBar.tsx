import type { ReactNode } from 'react';

export type ActivityTab = 'git' | 'skills' | 'settings';

interface ActivityBarProps {
  activeTab: ActivityTab;
  onTabChange: (tab: ActivityTab) => void;
}

const tabs: { id: ActivityTab; label: string; icon: ReactNode }[] = [
  {
    id: 'git',
    label: 'Git',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9" />
      </svg>
    ),
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" />
      </svg>
    ),
  },
];

export function ActivityBar({ activeTab, onTabChange }: ActivityBarProps) {
  return (
    <div className="activity-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`activity-bar-btn ${activeTab === tab.id ? 'activity-bar-btn-active' : ''}`}
          onClick={() => onTabChange(tab.id)}
          title={tab.label}
        >
          {tab.icon}
        </button>
      ))}
    </div>
  );
}
