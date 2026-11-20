import * as path from 'path';
import * as vscode from 'vscode';
import { DiffReviewService } from './diffReview';

export type TerminalPermissionDecision = 'allow_once' | 'allow_session' | 'deny';

export type TerminalPermissionRequest = {
  command: string;
  readonlyGit: boolean;
};

/** Session allowlists after the user picks「总是允许」in the Chat permission card. */
let allowTerminalSession = false;
let allowReadonlyGitSession = false;

type TerminalPermissionAsker = (
  req: TerminalPermissionRequest,
) => Promise<TerminalPermissionDecision>;

/** In-chat asker (Cursor-like). Falls back to a modal if unset. */
let terminalPermissionAsker: TerminalPermissionAsker | undefined;

/**
 * Registers the Chat/Agent Window handler for terminal permission cards.
 */
export function setTerminalPermissionAsker(asker: TerminalPermissionAsker | undefined): void {
  terminalPermissionAsker = asker;
}

/** Clears session-level terminal allowlists (e.g. new chat). */
export function resetTerminalSessionPermissions(): void {
  allowTerminalSession = false;
  allowReadonlyGitSession = false;
}

/** Marker: user dismissed a suggestion card — AgentRunner should end the turn. */
export const USER_FEEDBACK_STOP = '[[SU_USER_FEEDBACK_STOP]]';
/** Marker: Stop/Esc/session change aborted the card — AgentRunner should throw 已停止生成. */
export const USER_FEEDBACK_ABORTED = '[[SU_USER_FEEDBACK_ABORTED]]';

export type UserFeedbackKind = 'choice' | 'suggestion';

export type UserFeedbackRequest = {
  message: string;
  options: string[];
  kind: UserFeedbackKind;
};

export type UserFeedbackResult = {
  /** answered = user sent; dismissed = user closed card; aborted = Stop/Esc/session change */
  status: 'answered' | 'dismissed' | 'aborted';
  selected: string[];
  freeText: string;
};

type UserFeedbackAsker = (req: UserFeedbackRequest) => Promise<UserFeedbackResult>;

let userFeedbackAsker: UserFeedbackAsker | undefined;

/**
 * Registers the Chat/Agent Window handler for interactive feedback cards.
 */
export function setUserFeedbackAsker(asker: UserFeedbackAsker | undefined): void {
  userFeedbackAsker = asker;
}

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
          'Run a shell command in the workspace folder. Requires user confirmation in Chat (Allow once / Always this session / Deny) before running, unless already allowed for the session.',
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

  tools.push({
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Pause and show an in-chat feedback card (options + optional free text). ' +
        'kind=choice: real branching alternatives while doing the user\'s requested work (dismiss = continue current plan, no expansions). ' +
        'kind=suggestion: ONLY optional follow-ups AFTER meaningful progress (e.g. commit/push). Dismiss = stop without doing that suggestion. ' +
        'NEVER use suggestion to ask permission to start work the user already requested — just start (or use choice for real forks). ' +
        'Do NOT use for routine edits, terminal (use run_terminal), or decisions you can make yourself.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Short question / context shown on the card.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2–5 short predefined options (checkboxes). Optional but preferred.',
          },
          kind: {
            type: 'string',
            enum: ['choice', 'suggestion'],
            description:
              'choice = must branch to proceed correctly; suggestion = optional follow-up (commit/push/etc.).',
          },
        },
        required: ['message', 'kind'],
      },
    },
  });

  return tools;
}

/**
 * Ask-mode tools: workspace read-only inspection (no write / terminal).
 */
export function buildReadonlyTools(): AgentToolDef[] {
  return buildAgentTools(false).filter(
    (t) => t.function.name === 'list_dir' || t.function.name === 'read_file',
  );
}

/**
 * Executes one agent tool call. Returns a string result for the model.
 * Write tools require `diffs`; Ask mode can omit it and only call list/read.
 */
export async function executeAgentTool(
  name: string,
  argsJson: string,
  diffs?: DiffReviewService,
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
        if (!diffs) {
          return 'ERROR: write_file not allowed in Ask mode; switch to Agent';
        }
        return await writeFile(String(args.path ?? ''), String(args.content ?? ''), diffs);
      case 'replace_in_file':
        if (!diffs) {
          return 'ERROR: replace_in_file not allowed in Ask mode; switch to Agent';
        }
        return await replaceInFile(
          String(args.path ?? ''),
          String(args.old_text ?? ''),
          String(args.new_text ?? ''),
          diffs,
        );
      case 'run_terminal':
        return await runTerminal(String(args.command ?? ''));
      case 'ask_user':
        return await askUser(args);
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

function isReadonlyGitCommand(cmd: string): boolean {
  // Allow common inspection commands only (status/branch/log/diff/show/rev-parse/remote).
  return /^\s*git(\s+-C\s+\S+)?\s+(status|branch|log|diff|show|rev-parse|remote)\b/i.test(cmd);
}

async function askUser(args: Record<string, unknown>): Promise<string> {
  const message = String(args.message ?? '').trim();
  if (!message) {
    return 'ERROR: ask_user requires a non-empty message';
  }
  const kindRaw = String(args.kind ?? 'choice').toLowerCase();
  const kind: UserFeedbackKind = kindRaw === 'suggestion' ? 'suggestion' : 'choice';
  let options: string[] = [];
  if (Array.isArray(args.options)) {
    options = args.options
      .map((o) => String(o ?? '').trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  let result: UserFeedbackResult;
  if (userFeedbackAsker) {
    result = await userFeedbackAsker({ message, options, kind });
  } else {
    // Rare fallback when Chat UI is unavailable.
    const pick = await vscode.window.showInformationMessage(
      message,
      { modal: true, detail: kind === 'suggestion' ? '关闭/取消 = 结束建议，不执行。' : '关闭/取消 = 继续当前方案，不做额外扩展。' },
      ...(options.length ? options.slice(0, 3) : (['继续', '结束'] as const)),
    );
    if (!pick) {
      result = { status: 'dismissed', selected: [], freeText: '' };
    } else {
      result = { status: 'answered', selected: [pick], freeText: '' };
    }
  }

  if (result.status === 'aborted') {
    return (
      `${USER_FEEDBACK_ABORTED}\n` +
      'status=aborted\n' +
      'User stopped generation (Esc/Stop) or switched session. Abort the turn.'
    );
  }

  if (result.status === 'dismissed') {
    if (kind === 'suggestion') {
      return (
        `${USER_FEEDBACK_STOP}\n` +
        'status=dismissed kind=suggestion\n' +
        'User closed the suggestion card. End the turn NOW. Do not perform the suggested actions.'
      );
    }
    return (
      'status=dismissed kind=choice\n' +
      'User closed without choosing. Continue the CURRENT plan only — no optional expansions, ' +
      'no alternate branches, and do not decide among the offered options for the user.'
    );
  }

  const selected = result.selected.length ? result.selected.join(' | ') : '(none)';
  const free = result.freeText.trim() || '(none)';
  return (
    `status=answered kind=${kind}\n` +
    `selected: ${selected}\n` +
    `free_text: ${free}\n` +
    'Follow the user selection / free text. Do not do unselected options.'
  );
}

async function askTerminalPermission(cmd: string, readonlyGit: boolean): Promise<TerminalPermissionDecision> {
  if (terminalPermissionAsker) {
    return terminalPermissionAsker({ command: cmd, readonlyGit });
  }
  // Fallback when Chat UI is unavailable (should be rare).
  const buttons = readonlyGit
    ? (['允许一次', '本会话总是允许', '本会话允许只读 git', '拒绝'] as const)
    : (['允许一次', '本会话总是允许', '拒绝'] as const);
  const pick = await vscode.window.showWarningMessage(
    `Su Agent 请求执行终端命令（工作区根目录）：\n\n${cmd}`,
    { modal: true, detail: '写文件仍走 Keep/Reject；危险命令请勿轻易「总是允许」。' },
    ...buttons,
  );
  if (pick === '本会话总是允许') {
    return 'allow_session';
  }
  if (pick === '本会话允许只读 git') {
    allowReadonlyGitSession = true;
    return 'allow_once';
  }
  if (pick === '允许一次') {
    return 'allow_once';
  }
  return 'deny';
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

  const readonlyGit = isReadonlyGitCommand(cmd);
  const alreadyAllowed =
    allowTerminalSession || (readonlyGit && allowReadonlyGitSession);
  if (!alreadyAllowed) {
    const decision = await askTerminalPermission(cmd, readonlyGit);
    if (decision === 'deny') {
      return 'SKIPPED: user declined terminal command';
    }
    if (decision === 'allow_session') {
      allowTerminalSession = true;
    }
  }

  const root = workspaceRoot();
  const cp = await import('child_process');
  const shellTimeoutMs = Math.min(
    300_000,
    Math.max(5_000, vscode.workspace.getConfiguration('su').get<number>('timeoutMs', 60_000) || 60_000),
  );
  return await new Promise((resolve) => {
    cp.exec(
      cmd,
      { cwd: root.fsPath, timeout: shellTimeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr ? `\nSTDERR:\n${stderr}` : ''}`.trim();
        if (err) {
          const msg = err.message || String(err);
          const timedOut = /ETIMEDOUT|TIMEOUT|SIGTERM/i.test(msg);
          const prefix = timedOut
            ? `ERROR: terminal command timed out after ${Math.round(shellTimeoutMs / 1000)}s`
            : `ERROR: ${msg}`;
          resolve(`${prefix}\n${out}`.slice(0, 8000));
        } else {
          resolve((out || '(no output)').slice(0, 8000));
        }
      },
    );
  });
}
