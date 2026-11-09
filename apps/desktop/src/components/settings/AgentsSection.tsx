import { useEffect, useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { HARNESS_PLACEHOLDERS, HARNESS_SLOT_COUNT, sanitizeAllowedLaunchers } from '../../shared/launchers.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';

export interface AgentsSectionProps {
  settings: Settings;
  sessionId: string | null;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Draft shape: the launcher command, extra allowed launchers, and the five
 *  harness slots (always length 5 in the draft — packed on save). The
 *  inline-add input stays out of the draft (it is transient until "add"). */
interface AgentsDraft {
  agentCommand: string;
  launchers: string[];
  harnesses: string[];
}

/** Pad the stored (packed) slots back to five inputs; extras beyond the
 *  slot count are dropped. */
function padSlots(stored: Settings['reviewer']['harnesses']): string[] {
  const filled = (stored ?? []).filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const out = filled.slice(0, HARNESS_SLOT_COUNT);
  while (out.length < HARNESS_SLOT_COUNT) out.push('');
  return out;
}

/** Pack the draft inputs: drop empties, keep priority order. */
function packSlots(draft: string[]): string[] {
  return draft.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Settings▸Agents & Launchers — the launcher the reviewer spawns for
 *  agents, the five priority-ordered harness slots the model picks from,
 *  plus the extra shell-tile launchers it may start beyond the built-in
 *  defaults. */
export function AgentsSection(props: AgentsSectionProps): React.JSX.Element {
  const { settings, sessionId, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty<AgentsDraft>({
    agentCommand: settings.reviewer.agentCommand ?? '',
    launchers: settings.reviewer.allowedLaunchers ?? [],
    harnesses: padSlots(settings.reviewer.harnesses),
  });
  const { saved, flash } = useSavedFlash();
  const [newLauncher, setNewLauncher] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const addLauncher = (): void => {
    const value = newLauncher.trim();
    if (value.length === 0) return;
    const next = sanitizeAllowedLaunchers([...draft.launchers, value]) ?? [];
    if (!next.includes(value)) {
      setError('rejected: too many entries, too long, or invalid');
      return;
    }
    setError(null);
    setDraft((d) => ({ ...d, launchers: next }));
    setNewLauncher('');
  };

  const save = (): void => {
    setSaving(true);
    const packed = packSlots(draft.harnesses);
    // minimal patch: sending the whole (possibly stale) settings object
    // would clobber concurrent edits made in another section (REN-04)
    const next: Partial<Settings> = {
      reviewer: {
        agentCommand: draft.agentCommand.trim() || undefined,
        allowedLaunchers: draft.launchers.length > 0 ? draft.launchers : undefined,
        harnesses: packed.length > 0 ? packed : undefined,
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved({ agentCommand: draft.agentCommand.trim(), launchers: draft.launchers, harnesses: padSlots(packed) });
        flash();
        onNotice('launcher config saved');
      })
      .catch(() => onNotice('failed to save launchers'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        What the reviewer may start. The agent launcher is the command spawned for agent tiles; the harness slots are the
        priority-ordered harnesses the model picks from (slot 1 is the default); the allowlist gates which extra
        launchers may run inside a shell tile. The defaults (opencode, agy, claude, codex, gemini, aider, shell) always apply.
      </p>
      <SectionCard title="Launcher">
        <Field label="agent launcher (optional)" htmlFor="settings-agent-command" hint="spawned agents run this command; empty = the model asks you which agent to spawn">
          <input
            id="settings-agent-command"
            className="settings-input"
            value={draft.agentCommand}
            onChange={(e) => setDraft((d) => ({ ...d, agentCommand: e.target.value }))}
            placeholder="e.g. opencode — spawned agents run it"
            autoComplete="off"
          />
        </Field>
      </SectionCard>
      <SectionCard title="Agent harnesses (priority 1 → 5)">
        <Field
          label="harness slots"
          hint="slot 1 is the default spawn kind; the filled slots form the spawn_agent kind list. Empty = unset. Applies on reviewer restart."
        >
          <ol className="settings-list">
            {draft.harnesses.map((h, i) => (
              <li key={i} className="settings-list-row">
                <span className="settings-mono" aria-hidden="true">{i + 1}</span>
                <input
                  className="settings-input"
                  value={h}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, harnesses: d.harnesses.map((x, j) => (j === i ? e.target.value : x)) }))
                  }
                  placeholder={HARNESS_PLACEHOLDERS[i] ?? 'harness launcher…'}
                  aria-label={`harness slot ${i + 1}`}
                  autoComplete="off"
                />
              </li>
            ))}
          </ol>
        </Field>
      </SectionCard>
      <SectionCard title="Allowed launchers">
        <Field label="allowed launchers (beyond the defaults)" error={error ?? undefined}>
          <ul className="settings-list">
            {draft.launchers.map((l) => (
              <li key={l} className="settings-list-row">
                <span className="settings-mono">{l}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`remove ${l}`}
                  onClick={() => setDraft((d) => ({ ...d, launchers: d.launchers.filter((x) => x !== l) }))}
                >
                  remove
                </button>
              </li>
            ))}
            {draft.launchers.length === 0 && <li className="settings-list-row settings-list-empty">no extra launchers</li>}
          </ul>
          <div className="settings-inline-add">
            <input
              className="settings-input"
              value={newLauncher}
              onChange={(e) => {
                setNewLauncher(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLauncher();
                }
              }}
              placeholder="add a launcher command…"
              aria-label="add a launcher command"
              autoComplete="off"
            />
            <button type="button" className="btn btn-sm" onClick={addLauncher}>
              add
            </button>
          </div>
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
            {saving ? 'saving…' : saved ? 'saved' : 'save'}
          </button>
          {sessionId && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void bridge.restartReviewer(sessionId).then((ok) => onNotice(ok ? 'reviewer restarted' : 'reviewer is not running'))
              }
            >
              restart reviewer now
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
