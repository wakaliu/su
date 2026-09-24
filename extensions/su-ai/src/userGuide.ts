import * as vscode from 'vscode';

/**
 * Opens the bundled user manual (Markdown preview).
 */
export async function openUserManual(context: vscode.ExtensionContext): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'media', 'USER_GUIDE.md');
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    // Fallback when Markdown preview is unavailable.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  }
}
