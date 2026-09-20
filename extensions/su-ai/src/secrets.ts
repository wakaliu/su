import * as vscode from 'vscode';

const SECRET_API_KEY = 'su.apiKey';

/**
 * Reads the API key from SecretStorage (preferred) with one-time migration from plain settings.
 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string> {
  const fromSecret = await context.secrets.get(SECRET_API_KEY);
  if (fromSecret) {
    return fromSecret;
  }

  // v0.1 stored the key in settings.json; move it once then clear the plain value.
  const cfg = vscode.workspace.getConfiguration('su');
  const legacy = (cfg.get<string>('apiKey', '') || '').trim();
  if (!legacy) {
    return '';
  }
  await context.secrets.store(SECRET_API_KEY, legacy);
  await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
  return legacy;
}

/**
 * Stores the API key in SecretStorage only (never write secrets into settings.json).
 */
export async function setApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearApiKey(context);
    return;
  }
  await context.secrets.store(SECRET_API_KEY, trimmed);
  const cfg = vscode.workspace.getConfiguration('su');
  if (cfg.get<string>('apiKey')) {
    await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
  }
}

/**
 * Removes the stored API key.
 */
export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_API_KEY);
  const cfg = vscode.workspace.getConfiguration('su');
  if (cfg.get<string>('apiKey')) {
    await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
  }
}

/**
 * Prompts the user for an API key (password input) and stores it.
 */
export async function promptAndSetApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: 'Su: 设置 API Key',
    prompt: '密钥仅保存在本机 SecretStorage，不会写入 settings.json',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-... 或中转提供的 Key',
  });
  if (value === undefined) {
    return false;
  }
  await setApiKey(context, value);
  void vscode.window.showInformationMessage(value.trim() ? 'API Key 已保存。' : 'API Key 已清除。');
  return true;
}
