import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface PendingEdit {
  uri: vscode.Uri;
  /** Original on-disk content before agent change; null if file was newly created. */
  original: string | null;
  label: string;
}

/**
 * Tracks Agent file mutations so the user can Keep or Reject each change.
 */
export class DiffReviewService {
  private readonly pending = new Map<string, PendingEdit>();

  constructor(private readonly output?: vscode.OutputChannel) {}

  get size(): number {
    return this.pending.size;
  }

  list(): PendingEdit[] {
    return [...this.pending.values()];
  }

  /**
   * Records a file write. Captures original content once per path until Keep/Reject.
   */
  async noteWrite(uri: vscode.Uri, nextContent: string): Promise<void> {
    const key = uri.toString();
    let entry = this.pending.get(key);
    if (!entry) {
      let original: string | null = null;
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        original = Buffer.from(raw).toString('utf8');
      } catch {
        original = null;
      }
      entry = {
        uri,
        original,
        label: vscode.workspace.asRelativePath(uri, false) || uri.fsPath,
      };
      this.pending.set(key, entry);
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(nextContent, 'utf8'));
    this.output?.appendLine(`[diff] staged ${entry.label}`);
  }

  async keep(uri: vscode.Uri): Promise<void> {
    this.pending.delete(uri.toString());
  }

  async reject(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    if (entry.original === null) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        // ignore
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.original, 'utf8'));
    }
    this.pending.delete(key);
  }

  async keepAll(): Promise<number> {
    const n = this.pending.size;
    this.pending.clear();
    return n;
  }

  async rejectAll(): Promise<number> {
    const items = this.list();
    for (const item of items) {
      await this.reject(item.uri);
    }
    return items.length;
  }

  /**
   * Opens a diff editor: left = original (or empty), right = current disk.
   */
  async openDiff(uri: vscode.Uri): Promise<void> {
    const entry = this.pending.get(uri.toString());
    if (!entry) {
      void vscode.window.showInformationMessage('没有该文件的待审改动。');
      return;
    }
    const left = await this.originalSnapshotUri(entry);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      uri,
      `su: ${entry.label} (原← | →现)`,
    );
  }

  private async originalSnapshotUri(entry: PendingEdit): Promise<vscode.Uri> {
    const content = entry.original ?? '';
    const dir = this.storageDir();
    await vscode.workspace.fs.createDirectory(dir);
    const name = entry.label.replace(/[\\/]/g, '__') + '.orig';
    const file = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
    return file;
  }

  private storageDir(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder) {
      return vscode.Uri.joinPath(folder, '.su', 'agent-diff');
    }
    return vscode.Uri.file(path.join(os.tmpdir(), 'su-agent-diff'));
  }
}
