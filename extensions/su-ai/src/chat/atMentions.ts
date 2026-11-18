import * as path from 'path';
import * as vscode from 'vscode';

export type AtMentionItem =
  | { kind: 'selection'; id: string; label: string; detail: string }
  | { kind: 'file'; id: string; label: string; detail: string; path: string }
  | { kind: 'folder'; id: string; label: string; detail: string; path: string };

/**
 * Builds @-mention candidates: current selection, open editors, and a light
 * workspace file sample (no vector search).
 */
export async function listAtMentionItems(filter?: string): Promise<AtMentionItem[]> {
  const q = (filter || '').trim().toLowerCase();
  const out: AtMentionItem[] = [];

  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const sel = editor.document.getText(editor.selection);
    if (sel.trim()) {
      out.push({
        kind: 'selection',
        id: 'selection',
        label: '当前选区',
        detail: `${vscode.workspace.asRelativePath(editor.document.uri, false)} (${sel.length} chars)`,
      });
    }
  }

  const seen = new Set<string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isUntitled || doc.uri.scheme !== 'file') {
      continue;
    }
    const fsPath = doc.uri.fsPath;
    if (seen.has(fsPath)) {
      continue;
    }
    seen.add(fsPath);
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    out.push({
      kind: 'file',
      id: `open:${fsPath}`,
      label: path.basename(fsPath),
      detail: `打开中 · ${rel}`,
      path: fsPath,
    });
  }

  try {
    const uris = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx,cs,lua,py,md,json,go,rs,java,kt}',
      '**/{node_modules,Library,Temp,.git,bin,obj}/**',
      80,
    );
    for (const uri of uris) {
      const fsPath = uri.fsPath;
      if (seen.has(fsPath)) {
        continue;
      }
      seen.add(fsPath);
      const rel = vscode.workspace.asRelativePath(uri, false);
      out.push({
        kind: 'file',
        id: `file:${fsPath}`,
        label: path.basename(fsPath),
        detail: rel,
        path: fsPath,
      });
    }
  } catch {
    // ignore
  }

  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    out.push({
      kind: 'folder',
      id: `folder:${f.uri.fsPath}`,
      label: f.name + '/',
      detail: f.uri.fsPath,
      path: f.uri.fsPath,
    });
  }

  if (!q) {
    return out.slice(0, 40);
  }
  return out
    .filter((i) => (i.label + ' ' + i.detail).toLowerCase().includes(q))
    .slice(0, 40);
}
