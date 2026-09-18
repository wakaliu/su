import * as vscode from 'vscode';
import { getSuConfig } from './config';
import { UpdateService } from './update';

/** Opens Settings focused on Su AI relay/model fields (not a fuzzy "su" search). */
async function openSuAiSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:su.su-ai');
}

/**
 * Activates the built-in Su AI extension and registers v0.1 commands / UI entry points.
 */
export function activate(context: vscode.ExtensionContext): void {
  const openSettings = vscode.commands.registerCommand('su.openSettings', openSuAiSettings);
  context.subscriptions.push(openSettings);

  const updates = new UpdateService(context);
  updates.activate();

  // Status bar: always-visible shortcut when the Activity Bar icon is easy to miss.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(gear) Su AI';
  status.tooltip = '打开 Su AI 配置（中转 Base URL / API Key / Model）';
  status.command = 'su.openSettings';
  status.show();
  context.subscriptions.push(status);

  const cfg = getSuConfig();
  console.log(`[su-ai] activated; model=${cfg.model}; baseUrl=${cfg.baseUrl}; version=${updates.currentVersion}`);
}

/**
 * Disposes extension resources on shutdown.
 */
export function deactivate(): void {
  // no-op for v0.1
}
