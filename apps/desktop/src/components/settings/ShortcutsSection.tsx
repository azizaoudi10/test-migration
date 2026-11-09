import { useEffect, useState } from 'react';
import {
  SHORTCUTS,
  shortcutsByScope,
  remapShortcut,
  resetShortcut,
  getRemappedKeys,
  type ShortcutScope,
} from '../../shortcuts.js';
import { bridge } from '../../ipc.js';
import { SectionCard } from './fields.js';

const SCOPES: Array<{ id: ShortcutScope; label: string }> = [
  { id: 'global', label: 'global' },
  { id: 'node', label: 'node workspace' },
  { id: 'editor', label: 'file editor' },
  { id: 'terminal', label: 'terminal' },
  { id: 'test', label: 'test browser' },
];

export interface ShortcutsSectionProps {
  onNotice(message: string): void;
}

/** Build a `Ctrl+Shift+X` style combo from a KeyboardEvent. Returns null
 *  when the event is not a valid remappable combo (modifier-only press, or
 *  no modifier held). */
function buildCombo(e: KeyboardEvent): string | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (parts.length === 0) return null;
  let main: string | null = null;
  if (e.code.startsWith('Key') && e.code.length === 4) {
    main = e.code.slice(3).toUpperCase();
  } else if (e.code.startsWith('Digit') && e.code.length === 6) {
    main = e.code.slice(5);
  } else if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
    main = 'Space';
  } else if (e.key.length === 1) {
    main = e.key.toUpperCase();
  } else if (e.key.startsWith('Arrow')) {
    main = e.key.slice(5);
  } else if (e.key.length > 0) {
    main = e.key[0]!.toUpperCase() + e.key.slice(1);
  }
  if (main === null || main === '') return null;
  return [...parts, main].join('+');
}

/** Settings▸Shortcuts — interactive editor rendered from the same registry
 *  the keymap and status bar use, so it cannot drift. */
export function ShortcutsSection(props: ShortcutsSectionProps): React.JSX.Element {
  const { onNotice } = props;
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const remaps = getRemappedKeys();

  useEffect(() => {
    if (capturingId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingId(null);
        return;
      }
      const combo = buildCombo(e);
      if (combo === null) return;
      const id = capturingId;
      remapShortcut(id, combo);
      void bridge
        .setSettings({ shortcuts: getRemappedKeys() })
        .catch(() => onNotice('failed to save the shortcut'));
      setCapturingId(null);
      setVersion((v) => v + 1);
      onNotice('shortcut updated');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturingId, onNotice]);

  const resetOne = (id: string): void => {
    resetShortcut(id);
    void bridge
      .setSettings({ shortcuts: getRemappedKeys() })
      .catch(() => onNotice('failed to save the shortcut'));
    setVersion((v) => v + 1);
    onNotice('shortcut reset');
  };

  const resetAll = (): void => {
    for (const sc of SHORTCUTS) resetShortcut(sc.id);
    void bridge
      .setSettings({ shortcuts: getRemappedKeys() })
      .catch(() => onNotice('failed to save the shortcuts'));
    setVersion((v) => v + 1);
    onNotice('shortcuts reset');
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        Every binding, from the single shortcut registry the app runs on. The command palette (Ctrl+Shift+P) also lists these as
        commands. Select edit on a row, then press the new key combination.
      </p>
      <div className="settings-actions">
        <button type="button" className="btn btn-sm" onClick={resetAll}>
          Reset all
        </button>
      </div>
      {SCOPES.map((s) => (
        <SectionCard key={s.id} title={s.label}>
          <table className="settings-shortcuts">
            <tbody>
              {shortcutsByScope(s.id).map((sc) =>
                sc.id === 'tile.focusN' ? (
                  <tr key={sc.id}>
                    <td className="settings-mono">{sc.keys}</td>
                    <td>{sc.label}</td>
                    <td>
                      <span className="settings-hint">range binding, not remappable</span>
                    </td>
                  </tr>
                ) : (
                  <tr key={sc.id}>
                    <td className="settings-mono">
                      {capturingId === sc.id ? 'press keys…' : sc.keys}
                    </td>
                    <td>{sc.label}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`edit ${sc.label}`}
                        onClick={() => setCapturingId(sc.id)}
                      >
                        {capturingId === sc.id ? 'cancel' : 'edit'}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`reset ${sc.label}`}
                        disabled={!(sc.id in remaps)}
                        onClick={() => resetOne(sc.id)}
                      >
                        reset
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </SectionCard>
      ))}
      <span className="settings-hint">{SHORTCUTS.length} bindings registered</span>
    </div>
  );
}
