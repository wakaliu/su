import * as vscode from 'vscode';
import { getSuConfig } from './config';
import { ChatViewProvider } from './chat/chatViewProvider';
import { GhostTextProvider } from './ghostText';
import { clearApiKey, promptAndSetApiKey } from './secrets';
import { UpdateService } from './update';
import { preferClassicWorkbench } from './workbench';

/** Opens Settings focused on Su AI relay/model fields (not a fuzzy "su" search). */
async function openSuAiSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:su.su-ai');
}

/** Toggles su.ghostText.enabled and reports the new state. */
async function toggleGhostText(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  const next = !cfg.get<boolean>('ghostText.enabled', true);
  await cfg.update('ghostText.enabled', next, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(next ? 'Ghost Text 已开启。' : 'Ghost Text 已关闭。');
}

/**
 * Activates Su AI: Chat, Ghost Text, SecretStorage keys, and update checks.
 */
export function activate(context: vscode.ExtensionContext): void {
  // vscode 1.136 may restore Agents/Sessions ("Pitch your idea") as last window.
  void preferClassicWorkbench(context);

  const chat = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const ghost = new GhostTextProvider(context);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, ghost),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('su.openSettings', openSuAiSettings),
    vscode.commands.registerCommand('su.openChat', () => chat.open()),
    vscode.commands.registerCommand('su.setApiKey', () => promptAndSetApiKey(context)),
    vscode.commands.registerCommand('su.clearApiKey', async () => {
      await clearApiKey(context);
      void vscode.window.showInformationMessage('API Key 已清除。');
    }),
    vscode.commands.registerCommand('su.toggleGhostText', () => toggleGhostText()),
  );

  const updates = new UpdateService(context);
  updates.activate();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) Su Chat';
  status.tooltip = '打开 Su Chat（Ctrl+L）· Ghost Text 见设置 su.ghostText';
  status.command = 'su.openChat';
  status.show();
  context.subscriptions.push(status);

  const cfg = getSuConfig();
  console.log(`[su-ai] activated v0.3; model=${cfg.model}; baseUrl=${cfg.baseUrl}; version=${updates.currentVersion}`);
}

/**
 * Disposes extension resources on shutdown.
 */
export function deactivate(): void {
  // webview / disposables cleaned via subscriptions
}
