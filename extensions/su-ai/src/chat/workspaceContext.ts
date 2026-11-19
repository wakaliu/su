import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'Library',
  'Temp',
  'obj',
  'bin',
  '.vs',
  '.idea',
  'Logs',
]);

export interface GitRepoInfo {
  /** Absolute path of the repo working tree. */
  root: string;
  /** Relative to workspace folder when possible. */
  label: string;
  branch: string;
  dirty?: boolean;
}

/**
 * Builds a workspace snapshot for Ask/Agent system context:
 * folders, git branches, top-level listing, README/ROADMAP excerpt, open editors.
 */
export async function buildWorkspaceContextSnippet(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    return [
      'Workspace snapshot (injected by su):',
      '- No folder open (ChatGPT-like empty workspace). You may still answer general questions.',
      '- For project-specific work (list/read/edit files), ask the user to open a folder via Su Chat menu 「打开文件夹」 or IDE File → Open Folder.',
      '- Do NOT invent a project path or file tree.',
    ].join('\n');
  }

  const lines: string[] = [
    'Workspace snapshot (read-only, injected by su).',
    'You ARE associated with this project — use the facts below. Do NOT claim you lack access to the project/files/repo when answering from this snapshot or after using list_dir/read_file.',
  ];

  const active = vscode.window.activeTextEditor?.document;
  if (active && !active.isUntitled) {
    lines.push(`- Active file: ${vscode.workspace.asRelativePath(active.uri, false)}`);
  }
  const openDocs = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === 'file')
    .slice(0, 12)
    .map((d) => vscode.workspace.asRelativePath(d.uri, false));
  if (openDocs.length) {
    lines.push(`- Open editors: ${openDocs.join(', ')}`);
  }

  for (const folder of folders) {
    lines.push(`- Workspace folder: ${folder.name} → ${folder.uri.fsPath}`);

    const top = listTopLevel(folder.uri.fsPath);
    if (top.length) {
      lines.push(`  - Top-level: ${top.join(', ')}`);
    }

    const readme = readSmallProjectDoc(folder.uri.fsPath);
    if (readme) {
      lines.push(`  - ${readme.name} (excerpt):\n\`\`\`\n${readme.text}\n\`\`\``);
    }

    const repos = await discoverGitRepos(folder.uri.fsPath, folder.name);
    if (!repos.length) {
      lines.push('  - Git: (not a git repo / git unavailable)');
    } else {
      for (const repo of repos) {
        const dirty = repo.dirty === undefined ? '' : repo.dirty ? ' (dirty)' : ' (clean)';
        lines.push(`  - Git ${repo.label}: branch \`${repo.branch}\`${dirty}`);
      }
    }
  }

  lines.push(
    'For deeper inspection in Ask mode, call list_dir / read_file. ' +
      'For edits or terminal, tell the user to switch to Agent (Ctrl+I).',
  );
  return lines.join('\n');
}

function listTopLevel(folderFsPath: string): string[] {
  try {
    const entries = fs.readdirSync(folderFsPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.') && !SKIP_DIR.has(e.name))
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
}

function readSmallProjectDoc(folderFsPath: string): { name: string; text: string } | undefined {
  const candidates = [
    'README.md',
    'README.MD',
    'readme.md',
    'ROADMAP.md',
    'package.json',
    'ProjectSettings/ProjectVersion.txt',
  ];
  for (const name of candidates) {
    const full = path.join(folderFsPath, name);
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        continue;
      }
      const st = fs.statSync(full);
      if (st.size > 80_000) {
        continue;
      }
      let text = fs.readFileSync(full, 'utf8');
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(text) as { name?: string; description?: string; version?: string };
          text = JSON.stringify(
            { name: pkg.name, version: pkg.version, description: pkg.description },
            null,
            2,
          );
        } catch {
          // keep raw
        }
      }
      if (text.length > 2500) {
        text = text.slice(0, 2500) + '\n…(truncated)';
      }
      return { name, text };
    } catch {
      // try next
    }
  }
  return undefined;
}

async function discoverGitRepos(folderFsPath: string, folderName: string): Promise<GitRepoInfo[]> {
  const candidates = new Set<string>();
  candidates.add(folderFsPath);

  try {
    const entries = fs.readdirSync(folderFsPath, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || SKIP_DIR.has(ent.name)) {
        continue;
      }
      const child = path.join(folderFsPath, ent.name);
      if (isGitRoot(child)) {
        candidates.add(child);
      }
      try {
        const sub = fs.readdirSync(child, { withFileTypes: true });
        for (const s of sub.slice(0, 40)) {
          if (!s.isDirectory() || s.name.startsWith('.') || SKIP_DIR.has(s.name)) {
            continue;
          }
          const nested = path.join(child, s.name);
          if (isGitRoot(nested)) {
            candidates.add(nested);
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const out: GitRepoInfo[] = [];
  for (const root of candidates) {
    const info = await readGitInfo(root, folderFsPath, folderName);
    if (info) {
      out.push(info);
    }
  }
  return out;
}

function isGitRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

async function readGitInfo(
  root: string,
  workspaceFsPath: string,
  folderName: string,
): Promise<GitRepoInfo | undefined> {
  try {
    const branch = (
      await execFileAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: 4000,
        windowsHide: true,
      })
    ).stdout
      .toString()
      .trim();
    if (!branch) {
      return undefined;
    }
    let dirty: boolean | undefined;
    try {
      const st = (
        await execFileAsync('git', ['-C', root, 'status', '--porcelain'], {
          timeout: 4000,
          windowsHide: true,
        })
      ).stdout
        .toString()
        .trim();
      dirty = st.length > 0;
    } catch {
      dirty = undefined;
    }
    const rel =
      path.resolve(root) === path.resolve(workspaceFsPath)
        ? folderName
        : `${folderName}/${path.relative(workspaceFsPath, root).replace(/\\/g, '/')}`;
    return { root, label: rel, branch, dirty };
  } catch {
    return undefined;
  }
}
