import * as vscode from 'vscode';
import { getSuConfig } from './config';

/**
 * Activates the built-in Su AI extension and registers v0.1 commands.
 */
export function activate(context: vscode.ExtensionContext): void {
  const openSettings = vscode.commands.registerCommand('su.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:su.su-ai');
  });

  context.subscriptions.push(openSettings);

  const cfg = getSuConfig();
  console.log(`[su-ai] activated; model=${cfg.model}; baseUrl=${cfg.baseUrl}`);
}

/**
 * Disposes extension resources on shutdown.
 */
export function deactivate(): void {
  // no-op for v0.1
}
