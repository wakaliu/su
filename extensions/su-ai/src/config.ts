import * as vscode from 'vscode';

export interface SuConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * Reads Su settings from the workspace/user configuration.
 * API key is a v0.1 plain setting placeholder; migrate to SecretStorage in v0.2.
 */
export function getSuConfig(): SuConfig {
  const cfg = vscode.workspace.getConfiguration('su');
  return {
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    apiKey: cfg.get<string>('apiKey', ''),
    model: cfg.get<string>('model', 'gpt-4o-mini'),
    timeoutMs: cfg.get<number>('timeoutMs', 60000),
  };
}
