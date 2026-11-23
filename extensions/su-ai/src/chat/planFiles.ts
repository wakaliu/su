import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';

/** Workspace-relative directory for Plan markdown files (Cursor-like). */
export const PLANS_DIR = '.su/plans';

/**
 * Derives a short filesystem-safe slug from plan markdown (heading or first line).
 */
export function slugFromPlanMarkdown(markdown: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  const line = (heading?.[1] || markdown.trim().split(/\r?\n/)[0] || 'plan').trim();
  const slug = line
    .replace(/[`*_#\[\]()]/g, '')
    .replace(/[^\w\u4e00-\u9fff\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'plan';
}

/**
 * Short stable fragment from revision / uuid for filenames.
 */
export function shortPlanId(revision: string): string {
  const cleaned = revision.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 8) || Date.now().toString(36).slice(-8);
}

/**
 * True when uri looks like a Su plan file under `.su/plans/*.plan.md`.
 */
export function isSuPlanFileUri(uri: vscode.Uri): boolean {
  const norm = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  return norm.includes('/.su/plans/') && norm.endsWith('.plan.md');
}

/**
 * Writes (or updates) a plan markdown file under the first workspace folder.
 */
export async function writePlanFile(opts: {
  markdown: string;
  revision: string;
  existingRelativePath?: string;
}): Promise<{ uri: vscode.Uri; relativePath: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error('需要打开工作区文件夹才能在编辑器中查看计划（写入 .su/plans）。');
  }
  const root = folders[0].uri;
  const existing = opts.existingRelativePath?.replace(/\\/g, '/');
  const relativePath =
    existing && existing.startsWith(`${PLANS_DIR}/`) && existing.endsWith('.plan.md')
      ? existing
      : `${PLANS_DIR}/${slugFromPlanMarkdown(opts.markdown)}_${shortPlanId(opts.revision)}.plan.md`;

  const dir = vscode.Uri.joinPath(root, PLANS_DIR);
  try {
    await vscode.workspace.fs.stat(dir);
  } catch {
    await vscode.workspace.fs.createDirectory(dir);
  }

  const uri = vscode.Uri.joinPath(root, ...relativePath.split('/'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(opts.markdown));
  return { uri, relativePath };
}

/**
 * Resolves workspace-relative plan path to a Uri, or undefined if no folder.
 */
export function planUriFromRelative(relativePath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  const rel = relativePath.replace(/\\/g, '/');
  if (!rel.startsWith(`${PLANS_DIR}/`) || !rel.endsWith('.plan.md')) {
    return undefined;
  }
  return vscode.Uri.joinPath(folders[0].uri, ...rel.split('/'));
}

/**
 * Reads plan text from an open editor buffer if present, else from disk.
 */
export async function readPlanMarkdown(
  relativePath: string | undefined,
  fallback: string,
): Promise<string> {
  if (!relativePath) {
    return fallback;
  }
  const uri = planUriFromRelative(relativePath);
  if (!uri) {
    return fallback;
  }
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf8').decode(bytes);
  } catch {
    return fallback;
  }
}
