import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuSessionAction, SettingsSection } from '../ipc.js';
import { THEMES } from '../themes.js';

export interface AppMenuProps {
  onNewTile(): void;
  onAddProject(): void;
  onQuickOpen(): void;
  onCommandPalette(): void;
  onQuit(): void;
  onSessionAction(action: MenuSessionAction): void;
  sessions: Array<{ id: string; name: string }>;
  activeSessionId: string | null;
  onOpenSettings(section?: SettingsSection): void;
  currentTheme: string;
  onThemeChange(themeId: string): void;
  onHelp(topic: string): void;
  onOpenPrompts(): void;
}

type MenuKey = 'file' | 'session' | 'settings' | 'help' | null;

export function AppMenu(props: AppMenuProps): React.JSX.Element {
  const {
    onNewTile,
    onAddProject,
    onQuickOpen,
    onCommandPalette,
    onQuit,
    onSessionAction,
    sessions,
    activeSessionId,
    onOpenSettings,
    currentTheme,
    onThemeChange,
    onHelp,
    onOpenPrompts,
  } = props;

  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  const closeAll = useCallback(() => {
    setOpenMenu(null);
    setOpenSubmenu(null);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        closeAll();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAll();
      }
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openMenu, closeAll]);

  const handleMenuClick = (menu: MenuKey) => {
    if (openMenu === menu) {
      closeAll();
    } else {
      setOpenMenu(menu);
      setOpenSubmenu(null);
    }
  };

  const handleMenuHover = (menu: MenuKey) => {
    if (openMenu && openMenu !== menu) {
      setOpenMenu(menu);
      setOpenSubmenu(null);
    }
  };

  const runItem = (fn: () => void) => {
    closeAll();
    fn();
  };

  return (
    <div className="app-menu-bar" ref={barRef} role="menubar" aria-label="Application menu">
      {/* FILE MENU */}
      <div className="app-menu-group">
        <button
          type="button"
          className={`app-menu-btn${openMenu === 'file' ? ' app-menu-btn-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'file'}
          onClick={() => handleMenuClick('file')}
          onMouseEnter={() => handleMenuHover('file')}
        >
          File
        </button>
        {openMenu === 'file' && (
          <div className="app-menu-dropdown" role="menu">
            <button type="button" className="app-menu-item" onClick={() => runItem(onNewTile)}>
              <span className="app-menu-item-label">New Tile</span>
              <span className="app-menu-item-key">Ctrl+Shift+T</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(onAddProject)}>
              <span className="app-menu-item-label">Add Project Folder…</span>
              <span className="app-menu-item-key">Ctrl+Shift+O</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(onQuickOpen)}>
              <span className="app-menu-item-label">Quick Open…</span>
              <span className="app-menu-item-key">Ctrl+P</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(onCommandPalette)}>
              <span className="app-menu-item-label">Command Palette…</span>
              <span className="app-menu-item-key">Ctrl+Shift+P</span>
            </button>
            <div className="app-menu-separator" />
            <button type="button" className="app-menu-item" onClick={() => runItem(onQuit)}>
              <span className="app-menu-item-label">Quit</span>
              <span className="app-menu-item-key">Ctrl+Q</span>
            </button>
          </div>
        )}
      </div>

      {/* SESSION MENU */}
      <div className="app-menu-group">
        <button
          type="button"
          className={`app-menu-btn${openMenu === 'session' ? ' app-menu-btn-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'session'}
          onClick={() => handleMenuClick('session')}
          onMouseEnter={() => handleMenuHover('session')}
        >
          Session
        </button>
        {openMenu === 'session' && (
          <div className="app-menu-dropdown" role="menu">
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onSessionAction({ action: 'new' }))}>
              <span className="app-menu-item-label">New Session…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onSessionAction({ action: 'save-as' }))}>
              <span className="app-menu-item-label">Save As…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onSessionAction({ action: 'rename' }))}>
              <span className="app-menu-item-label">Rename…</span>
            </button>
            <div className="app-menu-separator" />
            <button
              type="button"
              className="app-menu-item"
              onClick={() => runItem(() => onSessionAction({ action: 'export-bundle' }))}
            >
              <span className="app-menu-item-label">Export Session Bundle…</span>
            </button>
            <button
              type="button"
              className="app-menu-item"
              onClick={() => runItem(() => onSessionAction({ action: 'import-bundle' }))}
            >
              <span className="app-menu-item-label">Import Session Bundle…</span>
            </button>

            {sessions.length > 0 && (
              <>
                <div className="app-menu-separator" />
                <div className="app-menu-heading">Sessions ({sessions.length})</div>
                {sessions.map((s) => {
                  const isActive = s.id === activeSessionId;
                  const isSubOpen = openSubmenu === `sess-${s.id}`;
                  return (
                    <div
                      key={s.id}
                      className="app-menu-sub-trigger"
                      onMouseEnter={() => setOpenSubmenu(`sess-${s.id}`)}
                      onMouseLeave={() => setOpenSubmenu(null)}
                    >
                      <button
                        type="button"
                        className={`app-menu-item app-menu-item-parent${isActive ? ' app-menu-item-active' : ''}`}
                        onClick={() => runItem(() => onSessionAction({ action: 'open', id: s.id }))}
                      >
                        <span className="app-menu-item-label">
                          {isActive && <span className="app-menu-item-bullet">●</span>} {s.name}
                        </span>
                        <span className="app-menu-item-arrow">▸</span>
                      </button>
                      {isSubOpen && (
                        <div className="app-menu-submenu" role="menu">
                          <button
                            type="button"
                            className="app-menu-item"
                            onClick={() => runItem(() => onSessionAction({ action: 'open', id: s.id }))}
                          >
                            <span className="app-menu-item-label">Open</span>
                          </button>
                          <button
                            type="button"
                            className="app-menu-item"
                            onClick={() => runItem(() => onSessionAction({ action: 'stop', id: s.id }))}
                          >
                            <span className="app-menu-item-label">Stop</span>
                          </button>
                          <button
                            type="button"
                            className="app-menu-item"
                            onClick={() => runItem(() => onSessionAction({ action: 'start', id: s.id }))}
                          >
                            <span className="app-menu-item-label">Start</span>
                          </button>
                          <div className="app-menu-separator" />
                          <button
                            type="button"
                            className="app-menu-item app-menu-item-danger"
                            onClick={() => runItem(() => onSessionAction({ action: 'delete', id: s.id }))}
                          >
                            <span className="app-menu-item-label">Delete…</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* SETTINGS MENU */}
      <div className="app-menu-group">
        <button
          type="button"
          className={`app-menu-btn${openMenu === 'settings' ? ' app-menu-btn-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'settings'}
          onClick={() => handleMenuClick('settings')}
          onMouseEnter={() => handleMenuHover('settings')}
        >
          Settings
        </button>
        {openMenu === 'settings' && (
          <div className="app-menu-dropdown" role="menu">
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('general'))}>
              <span className="app-menu-item-label">Settings…</span>
              <span className="app-menu-item-key">Ctrl+,</span>
            </button>
            <div className="app-menu-separator" />
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('model'))}>
              <span className="app-menu-item-label">Model…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('sampling'))}>
              <span className="app-menu-item-label">Sampling &amp; Context…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('agents'))}>
              <span className="app-menu-item-label">Agents &amp; Launchers…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('compose'))}>
              <span className="app-menu-item-label">Auto Compose…</span>
            </button>
            <button
              type="button"
              className="app-menu-item app-menu-item-highlight"
              onClick={() => runItem(() => onOpenSettings('prompts'))}
            >
              <span className="app-menu-item-label">Prompt Library…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('editor'))}>
              <span className="app-menu-item-label">Editor…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('shortcuts'))}>
              <span className="app-menu-item-label">Shortcuts…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('usage'))}>
              <span className="app-menu-item-label">Usage…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('advanced'))}>
              <span className="app-menu-item-label">Advanced…</span>
            </button>
            <div className="app-menu-separator" />

            {/* THEMES SUBMENU */}
            <div
              className="app-menu-sub-trigger"
              onMouseEnter={() => setOpenSubmenu('themes')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <button type="button" className="app-menu-item app-menu-item-parent">
                <span className="app-menu-item-label">Theme</span>
                <span className="app-menu-item-arrow">▸</span>
              </button>
              {openSubmenu === 'themes' && (
                <div className="app-menu-submenu" role="menu">
                  {THEMES.map((t) => {
                    const isSelected = t.id === currentTheme;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`app-menu-item${isSelected ? ' app-menu-item-active' : ''}`}
                        onClick={() => runItem(() => onThemeChange(t.id))}
                      >
                        <span className="app-menu-item-label">
                          {isSelected ? '✓ ' : '  '}
                          {t.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* HELP MENU */}
      <div className="app-menu-group">
        <button
          type="button"
          className={`app-menu-btn${openMenu === 'help' ? ' app-menu-btn-active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'help'}
          onClick={() => handleMenuClick('help')}
          onMouseEnter={() => handleMenuHover('help')}
        >
          Help
        </button>
        {openMenu === 'help' && (
          <div className="app-menu-dropdown" role="menu">
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onHelp('reviewer-commands'))}>
              <span className="app-menu-item-label">Reviewer commands…</span>
            </button>
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('shortcuts'))}>
              <span className="app-menu-item-label">Keyboard Shortcuts…</span>
            </button>
            <div className="app-menu-separator" />
            <button type="button" className="app-menu-item" onClick={() => runItem(() => onOpenSettings('advanced'))}>
              <span className="app-menu-item-label">About Fraktole…</span>
            </button>
          </div>
        )}
      </div>

      {/* DEDICATED PROMPTS BUTTON */}
      <button
        type="button"
        className="app-menu-prompts-btn"
        title="Prompt Library — manage and use saved prompts"
        onClick={() => runItem(onOpenPrompts)}
      >
        <span className="app-menu-prompts-dot" aria-hidden="true">◆</span>
        Prompts
      </button>
    </div>
  );
}
