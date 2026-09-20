import * as vscode from 'vscode';
import { getApiKey } from './secrets';

export interface SuConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/**
 * Reads non-secret Su settings (Base URL / model / timeout).
 */
export function getSuConfig(): SuConfig {
  const cfg = vscode.workspace.getConfiguration('su');
  return {
    baseUrl: (cfg.get<string>('baseUrl', 'https://api.openai.com/v1') || '').trim().replace(/\/+$/, ''),
    model: cfg.get<string>('model', 'gpt-4o-mini') || 'gpt-4o-mini',
    timeoutMs: cfg.get<number>('timeoutMs', 60000) || 60000,
  };
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
