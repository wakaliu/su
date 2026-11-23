import * as vscode from 'vscode';
import { getApiKey } from './secrets';

/** Chat panel pick: Auto uses `su.model`; otherwise an explicit model id. */
export const MODEL_PICK_AUTO = 'auto';

export interface SuConfig {
  baseUrl: string;
  /** Default model (`su.model`); used by Auto and Ghost Text. */
  model: string;
  /** Extra model ids from `su.models` (same Base URL / API Key). */
  models: string[];
  /** Ask / general request timeout. */
  timeoutMs: number;
  /** Per Agent LLM round-trip timeout (tool loop step). */
  agentTimeoutMs: number;
}

/**
 * Reads non-secret Su settings (Base URL / model list / timeout).
 */
export function getSuConfig(): SuConfig {
  const cfg = vscode.workspace.getConfiguration('su');
  const model = (cfg.get<string>('model', 'gpt-4o-mini') || 'gpt-4o-mini').trim();
  const extra = cfg.get<string[]>('models', []) || [];
  const models = extra
    .map((m) => (typeof m === 'string' ? m.trim() : ''))
    .filter((m) => m.length > 0);
  const timeoutMs = Math.min(600_000, Math.max(5_000, cfg.get<number>('timeoutMs', 60_000) || 60_000));
  // Agent rounds often need minutes (large prompts + tools + slow relays); default 10 min.
  const agentTimeoutMs = Math.min(
    1_800_000,
    Math.max(30_000, cfg.get<number>('agent.timeoutMs', 600_000) || 600_000),
  );
  return {
    baseUrl: (cfg.get<string>('baseUrl', 'https://api.openai.com/v1') || '').trim().replace(/\/+$/, ''),
    model: model || 'gpt-4o-mini',
    models,
    timeoutMs,
    agentTimeoutMs,
  };
}

/**
 * Unique model ids available in the Chat picker (default + extras).
 */
export function getModelCatalog(cfg: SuConfig = getSuConfig()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [cfg.model, ...cfg.models]) {
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolves the API model id for a Chat pick (`auto` → `su.model`).
 */
export function resolveActiveModel(pick: string | undefined, cfg: SuConfig = getSuConfig()): string {
  const catalog = getModelCatalog(cfg);
  const raw = (pick || MODEL_PICK_AUTO).trim();
  if (!raw || raw === MODEL_PICK_AUTO) {
    return cfg.model;
  }
  if (catalog.includes(raw)) {
    return raw;
  }
  // Stale pick after settings change — fall back to default.
  return cfg.model;
}

/**
 * Resolves runtime config including SecretStorage API key.
 */
export async function resolveSuRuntimeConfig(
  context: vscode.ExtensionContext,
): Promise<SuConfig & { apiKey: string }> {
  const base = getSuConfig();
  const apiKey = await getApiKey(context);
  return { ...base, apiKey };
}
