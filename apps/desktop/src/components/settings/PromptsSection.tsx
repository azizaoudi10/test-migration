import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type PromptEntry } from '../../ipc.js';
import { fuzzyScore } from '../../fuzzy.js';
import { expandPromptVars } from '../../shared/prompt-vars.js';
import { insertPrompt } from '../../prompt-bus.js';
import { SectionCard, Field } from './fields.js';

export interface PromptsSectionProps {
  /** Context for {{cwd}}/{{project}}/{{goal}}/{{selection}} expansion. */
  projectPath: string | null;
  cwd: string | null;
  goalText: string | null;
  onNotice(message: string): void;
}

interface Draft {
  id: string | null;
  name: string;
  body: string;
  tags: string;
}

const EMPTY: Draft = { id: null, name: '', body: '', tags: '' };

/** Prompt Library: the global prompt store ledger (search, tags, usage
 *  counts, CRUD). Use actions expand variables and load the reviewer
 *  composer; the palette and /prompt offer the same actions elsewhere. */
export function PromptsSection(props: PromptsSectionProps): React.JSX.Element {
  const { projectPath, cwd, goalText, onNotice } = props;
  const [entries, setEntries] = useState<PromptEntry[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setEntries(await bridge.listPrompts());
    } catch {
      onNotice('prompt library unavailable');
    }
  }, [onNotice]);

  useEffect(() => {
    void refresh();
    return bridge.onPromptsChanged(() => void refresh());
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const base = q.length === 0 ? entries : entries.filter((e) => (fuzzyScore(q, `${e.name} ${e.tags.join(' ')} ${e.body}`) ?? -1) > 0);
    return [...base].sort((a, b) => b.useCount - a.useCount || b.updatedAt - a.updatedAt);
  }, [entries, query]);

  const edit = (entry: PromptEntry): void => {
    setError(null);
    setDraft({ id: entry.id, name: entry.name, body: entry.body, tags: entry.tags.join(', ') });
  };

  const save = async (): Promise<void> => {
    if (draft.name.trim().length === 0 || draft.body.trim().length === 0) {
      setError('a prompt needs a name and a body');
      return;
    }
    setSaving(true);
    try {
      await bridge.savePrompt({
        id: draft.id ?? undefined,
        name: draft.name,
        body: draft.body,
        tags: draft.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
      });
      setDraft(EMPTY);
      onNotice('prompt saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: PromptEntry): Promise<void> => {
    if (!window.confirm(`Delete prompt "${entry.name}"?`)) return;
    await bridge.deletePrompt(entry.id);
    if (draft.id === entry.id) setDraft(EMPTY);
    onNotice('prompt deleted');
  };

  const doExport = async (): Promise<void> => {
    try {
      const json = await bridge.exportPrompts();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fraktole-prompts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotice('prompts exported');
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const doImportFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const res = await bridge.importPrompts(text);
      onNotice(
        `imported ${res.imported} prompt(s)` +
          (res.errors.length > 0 ? ` — ${res.errors.length} error(s): ${res.errors.join('; ')}` : ''),
      );
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const use = async (entry: PromptEntry, send: boolean): Promise<void> => {
    const used = await bridge.usePrompt(entry.id);
    if (used === null) return;
    const text = expandPromptVars(used.body, {
      cwd: cwd ?? projectPath ?? '',
      project: projectPath ?? '',
      goal: goalText ?? '',
      selection: '',
    });
    if (send) {
      insertPrompt(text);
      onNotice(`"${used.name}" loaded into the reviewer composer`);
    } else {
      void navigator.clipboard.writeText(text).then(
        () => onNotice(`"${used.name}" copied`),
        () => onNotice('clipboard unavailable'),
      );
    }
    void refresh();
  };

  return (
    <div className="settings-section-body">
      <SectionCard
        title="Prompt library"
        hint="Saved prompts for the reviewer harness — variables {{cwd}}, {{project}}, {{goal}}, {{selection}} expand when used."
      >
        <Field label="search" hint={`${entries.length} saved`}>
          <input
            className="settings-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter by name, tag or body"
            spellCheck={false}
          />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm" onClick={() => void doExport()}>
            export
          </button>
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
            import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void doImportFile(file);
            }}
          />
        </div>
        {filtered.length === 0 ? (
          <p className="settings-list-empty">{entries.length === 0 ? 'no prompts yet — save one below' : 'no prompt matches'}</p>
        ) : (
          <ul className="settings-list">
            {filtered.map((entry) => (
              <li key={entry.id} className="settings-list-row prompt-row">
                <div className="prompt-row-main">
                  <span className="prompt-row-name">{entry.name}</span>
                  <span className="prompt-row-meta">
                    {entry.tags.length > 0 ? `${entry.tags.join(' · ')} · ` : ''}used {entry.useCount}×
                  </span>
                </div>
                <div className="prompt-row-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void use(entry, true)}>
                    insert
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void use(entry, false)}>
                    copy
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => edit(entry)}>
                    edit
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(entry)}>
                    delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={draft.id === null ? 'New prompt' : 'Edit prompt'} hint="Bodies are sanitized on save; newlines are preserved.">
        <Field label="name" htmlFor="prompt-name">
          <input
            id="prompt-name"
            className="settings-input"
            value={draft.name}
            maxLength={120}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="tags" hint="comma separated (project names, topics)">
          <input
            className="settings-input"
            value={draft.tags}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
          />
        </Field>
        <Field label="body" hint="the prompt text sent to the reviewer" error={error ?? undefined} wide>
          <textarea
            className="settings-textarea"
            value={draft.body}
            maxLength={4000}
            rows={8}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'saving…' : draft.id === null ? 'save prompt' : 'update prompt'}
          </button>
          {draft.id !== null && (
            <button type="button" className="btn btn-sm" onClick={() => setDraft(EMPTY)}>
              cancel
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
