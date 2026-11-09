/** Prompt Store template variables: `{{cwd}}`, `{{project}}`, `{{goal}}`,
 *  `{{selection}}` are expanded at USE time (never stored expanded). Only
 *  known keys are replaced — an unknown `{{placeholder}}` passes through
 *  untouched so user text is never silently rewritten. Pure and
 *  renderer-safe. */
export type PromptVarKey = 'cwd' | 'project' | 'goal' | 'selection';

const VAR_RE = /\{\{\s*(cwd|project|goal|selection)\s*\}\}/g;

export function expandPromptVars(body: string, ctx: Partial<Record<PromptVarKey, string>>): string {
  return body.replace(VAR_RE, (_match, key: PromptVarKey) => ctx[key] ?? '');
}
