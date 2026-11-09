import React from 'react';
import { AppMenu, type AppMenuProps } from './AppMenu.js';

export type AppTab = 'node' | 'editor' | 'test' | 'remote';

export interface TopBarProps extends AppMenuProps {
  tab: AppTab;
  onTabChange(tab: AppTab): void;
  /** Open session count for the quiet right corner. */
  sessionCount: number;
}

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: 'editor', label: 'File Editor' },
  { id: 'node', label: 'Node' },
  { id: 'test', label: 'Test' },
  { id: 'remote', label: 'Remote' },
];

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { tab, onTabChange, sessionCount, ...menuProps } = props;
  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <span className="top-bar-mark" aria-hidden="true">
          Fraktole
        </span>
        <AppMenu {...menuProps} />
      </div>
      <nav className="top-bar-tabs" aria-label="views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-tab={t.id}
            className={`tab-btn${tab === t.id ? ' tab-btn-active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <span className="top-bar-count">
        {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
      </span>
    </header>
  );
}
