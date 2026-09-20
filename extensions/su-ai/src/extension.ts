import * as vscode from 'vscode';
import { getSuConfig } from './config';
import { ChatViewProvider } from './chat/chatViewProvider';
import { clearApiKey, promptAndSetApiKey } from './secrets';
import { UpdateService } from './update';

/** Opens Settings focused on Su AI relay/model fields (not a fuzzy "su" search). */
async function openSuAiSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:su.su-ai');
}

/**
 * Activates Su AI: Chat sidebar, SecretStorage key commands, and update checks.
 */
export function activate(context: vscode.ExtensionContext): void {
  const chat = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('su.openSettings', openSuAiSettings),
    vscode.commands.registerCommand('su.openChat', () => chat.open()),
    vscode.commands.registerCommand('su.setApiKey', () => promptAndSetApiKey(context)),
    vscode.commands.registerCommand('su.clearApiKey', async () => {
      await clearApiKey(context);
      void vscode.window.showInformationMessage('API Key 已清除。');
    }),
  );

  const updates = new UpdateService(context);
  updates.activate();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) Su Chat';
  status.tooltip = '打开 Su Chat（Ctrl+L）· 配置中转/模型';
  status.command = 'su.openChat';
  status.show();
  context.subscriptions.push(status);

  const cfg = getSuConfig();
  console.log(`[su-ai] activated v0.2; model=${cfg.model}; baseUrl=${cfg.baseUrl}; version=${updates.currentVersion}`);
}

/**
 * Disposes extension resources on shutdown.
 */
export function deactivate(): void {
  // webview / disposables cleaned via subscriptions
}
