import { useEffect, useState } from 'react';
import { bridge, type Settings } from '../../ipc.js';
import { deriveLoopCadence, POLL_SECONDS_MAX, POLL_SECONDS_MIN } from '../../shared/loop-cadence.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';

export interface LoopSectionProps {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Named hunger presets — the stored value is always one number
 *  (reviewer.pollSeconds); presets are a UI affordance over it. */
const PRESETS: Array<{ seconds: number; label: string; blurb: string }> = [
  { seconds: 90, label: 'lazy', blurb: '90s — a quiet background pulse' },
  { seconds: 45, label: 'calm', blurb: '45s — half-speed oversight' },
  { seconds: 15, label: 'standard', blurb: '15s — the default cadence' },
];

function parseSeconds(raw: string): number | undefined {
  const t = raw.trim();
  if (t.length === 0) return undefined;
  const v = Number(t);
  return Number.isInteger(v) ? v : NaN;
}

/** Settings▸Loop — the loop carrier's hunger: how often an armed goal is
 *  re-checked. While a goal is armed and the loop is idle, every tick wakes
 *  the model — permanent polling with no backstop and no stand-down, in
 *  auto-compose and for manual goals alike. The change applies LIVE to a
 *  running reviewer — no restart. */
export function LoopSection(props: LoopSectionProps): React.JSX.Element {
  const { settings, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty<string>(
    settings.reviewer.pollSeconds === undefined ? '15' : String(settings.reviewer.pollSeconds),
  );
  const { saved, flash } = useSavedFlash();
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const parsed = parseSeconds(draft);
  const error =
    touched || dirty
      ? Number.isNaN(parsed)
        ? 'seconds must be a whole number'
        : parsed !== undefined && (parsed < POLL_SECONDS_MIN || parsed > POLL_SECONDS_MAX)
          ? `must be between ${POLL_SECONDS_MIN} and ${POLL_SECONDS_MAX} seconds`
          : undefined
      : undefined;

  const effective = deriveLoopCadence(parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined);
  const activePreset = PRESETS.find((p) => p.seconds === effective.pollIntervalMs / 1000 && (parsed === undefined || parsed === p.seconds));

  const save = (): void => {
    setTouched(true);
    if (error !== undefined) {
      onNotice('fix the poll rate — it must be 2–600 whole seconds');
      return;
    }
    setSaving(true);
    const seconds = parsed ?? 15;
    // minimal patch: never resend a stale full settings object (REN-04)
    const next: Partial<Settings> = { reviewer: { pollSeconds: seconds } };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved(String(seconds));
        flash();
        onNotice('loop cadence saved — applies immediately to a running reviewer');
      })
      .catch(() => onNotice('failed to save the loop cadence'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        How hungry the loop master is: while a goal is armed and the loop is idle, the model is re-checked at this rate —
        permanent polling with no backstop and no stand-down, in auto-compose and for manual goals alike.
      </p>
      <SectionCard title="Loop hunger" hint="Applies immediately to a running reviewer — no restart needed.">
        <div className="settings-preset-row" role="radiogroup" aria-label="loop hunger preset">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={activePreset?.label === p.label}
              className={`settings-preset${activePreset?.label === p.label ? ' settings-preset-active' : ''}`}
              title={p.blurb}
              onClick={() => {
                setTouched(false);
                setDraft(() => String(p.seconds));
              }}
            >
              <span className="settings-preset-label">{p.label}</span>
              <span className="settings-preset-seconds">{p.seconds}s</span>
            </button>
          ))}
        </div>
        <Field
          label="custom poll rate (seconds)"
          htmlFor="settings-poll-seconds"
          hint={`whole seconds, ${POLL_SECONDS_MIN}–${POLL_SECONDS_MAX} · the presets above just fill this in`}
          error={error}
        >
          <input
            id="settings-poll-seconds"
            type="number"
            inputMode="numeric"
            className="settings-input"
            value={draft}
            placeholder="15"
            min={POLL_SECONDS_MIN}
            max={POLL_SECONDS_MAX}
            step={1}
            aria-invalid={error !== undefined ? true : undefined}
            onChange={(e) => {
              setTouched(true);
              setDraft(() => e.target.value);
            }}
            autoComplete="off"
          />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={saving || error !== undefined} onClick={save}>
            {saving ? 'saving…' : saved ? 'saved' : 'save'}
          </button>
        </div>
      </SectionCard>
      <SectionCard title="Effective cadence" hint="What the loop carrier will actually do at this rate.">
        <div className="settings-kv">
          <span>poll rate</span>
          <span className="settings-mono">every {effective.pollIntervalMs / 1000}s → model wake while a goal is armed</span>
        </div>
        <span className="settings-hint">
          No backstop · no stand-down — hunger is the re-check rate. Silence only means no armed goal, a met or cleared goal,
          or an explicitly stopped reviewer.
        </span>
      </SectionCard>
    </div>
  );
}
