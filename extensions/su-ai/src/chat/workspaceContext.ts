import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface GitRepoInfo {
  /** Absolute path of the repo working tree. */
  root: string;
  /** Relative to workspace folder when possible. */
  label: string;
  branch: string;
  dirty?: boolean;
}

/**
 * Builds a short workspace snapshot (roots + git branches) for Ask/Agent system context.
 * Nested repos are discovered shallowly so multi-repo Unity layouts still show up.
 */
export async function buildWorkspaceContextSnippet(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    return 'Workspace: (no folder open)';
  }

  const lines: string[] = ['Workspace snapshot (read-only, injected by su):'];
  for (const folder of folders) {
    lines.push(`- Workspace folder: ${folder.name} → ${folder.uri.fsPath}`);
    const repos = await discoverGitRepos(folder.uri.fsPath, folder.name);
    if (!repos.length) {
      lines.push('  - Git: (not a git repo / git unavailable)');
      continue;
    }
    for (const repo of repos) {
      const dirty = repo.dirty === undefined ? '' : repo.dirty ? ' (dirty)' : ' (clean)';
      lines.push(`  - Git ${repo.label}: branch \`${repo.branch}\`${dirty}`);
    }
  }
  lines.push(
    'Use this snapshot to answer questions about the current branch/path. ' +
      'If you need a fresh shell check, switch to Agent mode (run_terminal shows a permission dialog).',
  );
  return lines.join('\n');
}

async function discoverGitRepos(folderFsPath: string, folderName: string): Promise<GitRepoInfo[]> {
  const candidates = new Set<string>();
  candidates.add(folderFsPath);

  // Shallow nested repos (e.g. Unity Assets/Script as submodule/separate clone).
  try {
    const entries = fs.readdirSync(folderFsPath, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) {
        continue;
      }
      const child = path.join(folderFsPath, ent.name);
      if (isGitRoot(child)) {
        candidates.add(child);
      }
      // One more level for Assets/Script style layouts.
      try {
        const sub = fs.readdirSync(child, { withFileTypes: true });
        for (const s of sub.slice(0, 40)) {
          if (!s.isDirectory() || s.name.startsWith('.')) {
            continue;
          }
          const nested = path.join(child, s.name);
          if (isGitRoot(nested)) {
            candidates.add(nested);
          }
        }
      } catch {
        // ignore unreadable dirs
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
    const gitPath = path.join(dir, '.git');
    return fs.existsSync(gitPath);
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
