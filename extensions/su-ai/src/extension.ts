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
 * Activates Su AI: Chat, Agent diffs, Ghost Text, and update checks.
 */
export function activate(context: vscode.ExtensionContext): void {
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
    vscode.commands.registerCommand('su.reviewAgentDiffs', () => reviewDiffs(chat)),
    vscode.commands.registerCommand('su.keepAllAgentDiffs', async () => {
      const n = await chat.diffs.keepAll();
      void vscode.window.showInformationMessage(n ? `已 Keep ${n} 个文件。` : '没有待审改动。');
    }),
    vscode.commands.registerCommand('su.rejectAllAgentDiffs', async () => {
      const n = await chat.diffs.rejectAll();
      void vscode.window.showInformationMessage(n ? `已 Reject ${n} 个文件。` : '没有待审改动。');
    }),
  );

  const updates = new UpdateService(context);
  updates.activate();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) Su Chat';
  status.tooltip = '打开 Su Chat / Agent（Ctrl+L）';
  status.command = 'su.openChat';
  status.show();
  context.subscriptions.push(status);

  const cfg = getSuConfig();
  console.log(`[su-ai] activated v0.4; model=${cfg.model}; baseUrl=${cfg.baseUrl}; version=${updates.currentVersion}`);
}

/**
 * Lets the user pick a pending file to diff, then Keep or Reject.
 */
async function reviewDiffs(chat: ChatViewProvider): Promise<void> {
  const items = chat.diffs.list();
  if (!items.length) {
    void vscode.window.showInformationMessage('没有待审的 Agent 改动。');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...items.map((p) => ({
        label: p.label,
        description: p.original === null ? '新建' : '修改',
        edit: p,
      })),
      { label: '$(check) Keep All', description: '保留全部当前磁盘内容', edit: undefined as undefined },
      { label: '$(discard) Reject All', description: '全部恢复修改前', edit: undefined as undefined },
    ],
    { title: 'Su: 审阅 Agent 改动' },
  );
  if (!picked) {
    return;
  }
  if (picked.label.includes('Keep All')) {
    const n = await chat.diffs.keepAll();
    void vscode.window.showInformationMessage(`已 Keep ${n} 个文件。`);
    return;
  }
  if (picked.label.includes('Reject All')) {
    const n = await chat.diffs.rejectAll();
    void vscode.window.showInformationMessage(`已 Reject ${n} 个文件。`);
    return;
  }
  if (!('edit' in picked) || !picked.edit) {
    return;
  }

  await chat.diffs.openDiff(picked.edit.uri);
  const action = await vscode.window.showInformationMessage(
    `审阅 ${picked.edit.label}`,
    'Keep',
    'Reject',
  );
  if (action === 'Keep') {
    await chat.diffs.keep(picked.edit.uri);
    void vscode.window.showInformationMessage(`已 Keep ${picked.edit.label}`);
  } else if (action === 'Reject') {
    await chat.diffs.reject(picked.edit.uri);
    void vscode.window.showInformationMessage(`已 Reject ${picked.edit.label}`);
  }
}

/**
 * Disposes extension resources on shutdown.
 */
export function deactivate(): void {
  // subscriptions cleaned automatically
}
