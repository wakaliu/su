import * as vscode from 'vscode';

const REDIRECT_KEY = 'su.ui.redirectedFromAgentSessions';

/**
 * Returns true when the current window is VS Code's Agents/Sessions workspace
 * (the Pitch your idea / MCP / Customizations shell), not the classic editor.
 */
export function isAgentSessionsWorkspace(): boolean {
  const file = vscode.workspace.workspaceFile;
  if (!file) {
    return false;
  }
  return /agent-sessions\.code-workspace$/i.test(file.fsPath.replace(/\\/g, '/'));
}

/**
 * If su was restored into the upstream Sessions window, open a classic empty
 * workbench window and close the Sessions shell. su Chat lives in the editor shell.
 */
export async function preferClassicWorkbench(context: vscode.ExtensionContext): Promise<void> {
  if (!isAgentSessionsWorkspace()) {
    return;
  }

  // Avoid tight reopen loops if newWindow somehow lands on sessions again.
  const redirectedAt = context.globalState.get<number>(REDIRECT_KEY, 0);
  if (Date.now() - redirectedAt < 5000) {
    return;
  }
  await context.globalState.update(REDIRECT_KEY, Date.now());

  console.log('[su-ai] detected agent-sessions workspace; opening classic editor window');
  try {
    await vscode.commands.executeCommand('workbench.action.newWindow');
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  } catch (e) {
    console.error('[su-ai] failed to leave Sessions window', e);
    void vscode.window.showWarningMessage(
      'su 检测到上游 Agents/Sessions 窗口。请运行 scripts/reset-ui-state.ps1 后重开，或手动打开文件夹进入编辑器。',
    );
  }
}
