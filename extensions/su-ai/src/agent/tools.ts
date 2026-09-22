import * as path from 'path';
import * as vscode from 'vscode';
import { DiffReviewService } from './diffReview';

export interface AgentToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI-compatible tool schemas for the su Agent (workspace-scoped).
 */
export function buildAgentTools(enableTerminal: boolean): AgentToolDef[] {
  const tools: AgentToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List files and folders under a workspace-relative path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path; empty or "." for workspace root.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file inside the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a UTF-8 text file inside the workspace. Change is pending Keep/Reject review.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: 'Replace the first occurrence of old_text with new_text in a workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_text: { type: 'string' },
            new_text: { type: 'string' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
  ];

  if (enableTerminal) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_terminal',
        description:
          'Run a shell command in the workspace folder. Always requires the user to confirm in the UI before running.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    });
  }

  return tools;
}

/**
 * Executes one agent tool call. Returns a string result for the model.
 */
export async function executeAgentTool(
  name: string,
  argsJson: string,
  diffs: DiffReviewService,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return `ERROR: invalid JSON arguments`;
  }

  try {
    switch (name) {
      case 'list_dir':
        return await listDir(String(args.path ?? '.'));
      case 'read_file':
        return await readFile(String(args.path ?? ''));
      case 'write_file':
        return await writeFile(String(args.path ?? ''), String(args.content ?? ''), diffs);
      case 'replace_in_file':
        return await replaceInFile(
          String(args.path ?? ''),
          String(args.old_text ?? ''),
          String(args.new_text ?? ''),
          diffs,
        );
      case 'run_terminal':
        return await runTerminal(String(args.command ?? ''));
      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('没有打开的工作区文件夹。请先 Open Folder。');
  }
  return folder.uri;
}

/**
 * Resolves a relative path and ensures it stays inside the workspace.
 */
export function resolveWorkspacePath(rel: string): vscode.Uri {
  const root = workspaceRoot();
  const cleaned = (rel || '.').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = vscode.Uri.joinPath(root, cleaned === '.' ? '' : cleaned);
  const rootPath = path.resolve(root.fsPath);
  const targetPath = path.resolve(target.fsPath);
  if (targetPath !== rootPath && !targetPath.startsWith(rootPath + path.sep)) {
    throw new Error(`路径越出工作区: ${rel}`);
  }
  return target;
}

async function listDir(rel: string): Promise<string> {
  const uri = resolveWorkspacePath(rel);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const lines = entries
    .map(([name, type]) => {
      const kind =
        type & vscode.FileType.Directory
          ? 'dir'
          : type & vscode.FileType.SymbolicLink
            ? 'link'
            : 'file';
      return `${kind}\t${name}`;
    })
    .sort();
  return lines.length ? lines.join('\n') : '(empty)';
}

async function readFile(rel: string): Promise<string> {
  const uri = resolveWorkspacePath(rel);
  const raw = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(raw).toString('utf8');
  if (text.length > 120_000) {
    return text.slice(0, 120_000) + '\n\n…[truncated]';
  }
  return text;
}

async function writeFile(rel: string, content: string, diffs: DiffReviewService): Promise<string> {
  const uri = resolveWorkspacePath(rel);
  const parent = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(parent);
  await diffs.noteWrite(uri, content);
  return `OK wrote ${vscode.workspace.asRelativePath(uri)} (${content.length} chars). Pending Keep/Reject.`;
}

async function replaceInFile(
  rel: string,
  oldText: string,
  newText: string,
  diffs: DiffReviewService,
): Promise<string> {
  if (!oldText) {
    return 'ERROR: old_text is empty';
  }
  const uri = resolveWorkspacePath(rel);
  const raw = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(raw).toString('utf8');
  const idx = text.indexOf(oldText);
  if (idx < 0) {
    return 'ERROR: old_text not found in file';
  }
  const next = text.slice(0, idx) + newText + text.slice(idx + oldText.length);
  await diffs.noteWrite(uri, next);
  return `OK replaced in ${vscode.workspace.asRelativePath(uri)}. Pending Keep/Reject.`;
}

async function runTerminal(command: string): Promise<string> {
  const cmd = command.trim();
  if (!cmd) {
    return 'ERROR: empty command';
  }
  const enable = vscode.workspace.getConfiguration('su').get<boolean>('agent.enableTerminal', true);
  if (!enable) {
    return 'ERROR: terminal tool disabled (su.agent.enableTerminal=false)';
  }

  const pick = await vscode.window.showWarningMessage(
    `Agent 请求执行终端命令：\n${cmd}`,
    { modal: true },
    '运行',
    '跳过',
  );
  if (pick !== '运行') {
    return 'SKIPPED: user declined terminal command';
  }

  const root = workspaceRoot();
  const cp = await import('child_process');
  return await new Promise((resolve) => {
    cp.exec(
      cmd,
      { cwd: root.fsPath, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr ? `\nSTDERR:\n${stderr}` : ''}`.trim();
        if (err) {
          resolve(`ERROR: ${err.message}\n${out}`.slice(0, 8000));
        } else {
          resolve((out || '(no output)').slice(0, 8000));
        }
      },
    );
  });
}
