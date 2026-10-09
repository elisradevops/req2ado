// Models the deployment does not want users to run req2ado on: unusable entries (they fail the request contract)
// and persona/agent presets (they inject their own prompt into every call), plus retired aliases. Configured as a
// comma-separated list of glob patterns in LLM_MODEL_HIDE_PATTERNS so a new entry needs no code change or deploy;
// empty by default, so the repository itself stays vendor-neutral.

/** Parses a comma-separated glob list (`*` any run, `?` one character, case-insensitive, whole-name match). */
export function parseModelHidePatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${escaped}$`, 'i');
    });
}

export function isModelHidden(model: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(model));
}
