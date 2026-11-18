import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const MAX_RULE_FILE = 24_000;
const MAX_TOTAL = 48_000;

/**
 * Loads workspace `.su/rules/` markdown files (recursive) into a system prompt fragment.
 * Honors `su.rules.enabled` (default true). Missing folder is a no-op.
 */
export async function loadWorkspaceRulesFragment(): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('su');
  if (!cfg.get<boolean>('rules.enabled', true)) {
    return undefined;
  }

  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    return undefined;
  }

  const parts: string[] = [];
  let total = 0;

  for (const folder of folders) {
    const root = path.join(folder.uri.fsPath, '.su', 'rules');
    if (!fs.existsSync(root)) {
      continue;
    }
    const files = listMarkdownFiles(root).sort((a, b) => a.localeCompare(b, 'en'));
    for (const file of files) {
      if (total >= MAX_TOTAL) {
        break;
      }
      try {
        let text = fs.readFileSync(file, 'utf8');
        if (text.length > MAX_RULE_FILE) {
          text = text.slice(0, MAX_RULE_FILE) + '\n…(truncated)';
        }
        const rel = path.relative(folder.uri.fsPath, file).replace(/\\/g, '/');
        const block = `Rule file ${rel}:\n${text.trim()}`;
        if (total + block.length > MAX_TOTAL) {
          parts.push(block.slice(0, Math.max(0, MAX_TOTAL - total)) + '\n…(truncated)');
          total = MAX_TOTAL;
          break;
        }
        parts.push(block);
        total += block.length;
      } catch {
        // skip unreadable
      }
    }
  }

  if (!parts.length) {
    return undefined;
  }
  return (
    'Follow these workspace Rules (from .su/rules). Prefer them when they conflict with generic advice:\n\n' +
    parts.join('\n\n---\n\n')
  );
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
      out.push(full);
    }
  }
}
