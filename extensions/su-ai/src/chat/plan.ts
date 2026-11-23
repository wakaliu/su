import { randomUUID } from 'crypto';

export const MAX_PLAN_LENGTH = 40_000;

/**
 * System prompt for Plan mode: explore read-only, discuss, then emit a full plan in <su-plan> tags.
 */
export const PLAN_SYSTEM_PROMPT = `You are in Su Plan mode. Read relevant workspace files before proposing changes. Never implement, modify files, or run commands. You may use only list_dir and read_file.
Discuss the user's goal, scope and acceptance criteria. When a consequential requirement or technical decision is unclear, finish this turn with focused questions and practical options, explaining tradeoffs and your recommendation. Wait for the user before drafting a plan. Do not ask about details you can verify by reading files.
When enough is known, return a complete Markdown document between standalone <su-plan> and </su-plan> lines (no outer code fence wrapping the tags). Include title, goal, scope and exclusions, technical approach, ordered actionable steps with relevant paths and dependencies, tests and measurable acceptance criteria, risks and rollback. Use the user's language. For revisions return the complete updated document, not a patch; ask first if a new unresolved decision blocks it. Only the user can approve execution by pressing Build.`;

export interface PlanDraft {
  revision: string;
  markdown: string;
}

/**
 * Validates plan markdown length and non-emptiness.
 */
export function validatePlanMarkdown(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PLAN_LENGTH) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Parses assistant text for a complete <su-plan>…</su-plan> document.
 * Discussion / malformed responses must not enable Build.
 */
export function parsePlanResponse(text: string): PlanDraft | undefined {
  const match = /^<su-plan>[ \t]*\r?\n([\s\S]+?)\r?\n<\/su-plan>[ \t]*$/m.exec(text.trim());
  // Prefer block anywhere in the reply (model may add a short intro).
  const anywhere = /<su-plan>[ \t]*\r?\n([\s\S]+?)\r?\n<\/su-plan>/m.exec(text);
  const raw = anywhere?.[1] ?? match?.[1];
  const markdown = validatePlanMarkdown(raw);
  if (!markdown || /^<\/?su-plan>[ \t]*$/m.test(markdown)) {
    return undefined;
  }
  return { revision: randomUUID(), markdown };
}

/**
 * Strips <su-plan> wrappers for display / history if present; otherwise returns text.
 */
export function stripPlanTags(text: string): string {
  const draft = parsePlanResponse(text);
  return draft?.markdown ?? text;
}
