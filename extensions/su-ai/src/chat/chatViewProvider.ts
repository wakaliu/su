import * as vscode from 'vscode';
import {
  getModelCatalog,
  MODEL_PICK_AUTO,
  resolveActiveModel,
  resolveSuRuntimeConfig,
} from '../config';
import { friendlyChatError, type ChatMessage } from '../openaiClient';
import { promptAndSetApiKey } from '../secrets';
import { runAgent } from '../agent/agentRunner';
import { DiffReviewService } from '../agent/diffReview';
import {
  buildUserTurn,
  resolveDroppedUris,
  type ChatAttachment,
} from './attachments';
import { runAskWithTools } from './askRunner';
import { listInstalledSkills } from './skillsCatalog';
import { buildWorkspaceContextSnippet } from './workspaceContext';
import {
  createEmptySession,
  LEGACY_HISTORY_KEY,
  normalizeStore,
  sessionSummaries,
  SESSIONS_KEY,
  titleFromMessages,
  trimMessages,
  type ChatMode,
  type ChatSession,
  type SessionStore,
} from './chatSessions';

const MODEL_PICK_KEY = 'su.chat.modelPick';
const MODE_KEY = 'su.chat.mode';

type WebviewToExt =
  | { type: 'ready' }
  | {
      type: 'send';
      text: string;
      includeSelection: boolean;
      mode: ChatMode;
      modelPick?: string;
      attachments?: ChatAttachment[];
    }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'editModels' }
  | { type: 'setApiKey' }
  | { type: 'openUserManual' }
  | { type: 'newChat' }
  | { type: 'listSessions' }
  | { type: 'switchSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'setMode'; mode: ChatMode }
  | { type: 'reviewDiffs' }
  | { type: 'keepAllDiffs' }
  | { type: 'rejectAllDiffs' }
  | { type: 'setModelPick'; pick: string }
  | { type: 'applyCode'; code: string }
  | { type: 'listSkills' }
  | { type: 'resolveDrop'; uris: string[] }
  | { type: 'pickFiles' };

type ExtToWebview =
  | {
      type: 'status';
      hasKey: boolean;
      model: string;
      baseUrl: string;
      pendingDiffs: number;
      models: string[];
      modelPick: string;
      activeModel: string;
      mode: ChatMode;
      sessionTitle: string;
      sessionId: string;
    }
  | {
      type: 'sessions';
      sessions: Array<{
        id: string;
        title: string;
        updatedAt: number;
        messageCount: number;
        active: boolean;
      }>;
    }
  | { type: 'restore'; messages: Array<{ role: 'user' | 'assistant'; content: string }>; title: string }
  | { type: 'user'; text: string }
  | { type: 'assistantStart' }
  | { type: 'assistantDelta'; text: string }
  | { type: 'assistantDone' }
  | { type: 'tool'; text: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | {
      type: 'skills';
      skills: Array<{ id: string; name: string; description: string; source: string }>;
    }
  | {
      type: 'dropResolved';
      items: Array<{
        kind: 'file' | 'folder' | 'image';
        path?: string;
        name?: string;
        mime?: string;
        dataBase64?: string;
      }>;
    };

/**
 * Side-bar Chat panel with multi-session history, Ask/Agent mode, and streaming.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'su.chat';

  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private store: SessionStore;
  private streaming = false;
  readonly diffs: DiffReviewService;
  /** Fired when pending diff count changes (status bar). */
  onPendingDiffsChanged?: (count: number) => void;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = this.loadStore();
    this.diffs = new DiffReviewService();
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('su.model') ||
          e.affectsConfiguration('su.models') ||
          e.affectsConfiguration('su.baseUrl')
        ) {
          void this.pushStatus();
        }
      }),
    );
  }

  /**
   * Reveals Su Chat in the right auxiliary bar (Cursor-like) and focuses input.
   */
  async open(opts?: { mode?: ChatMode }): Promise<void> {
    if (opts?.mode) {
      await this.setMode(opts.mode);
    }
    try {
      await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
    } catch {
      // older hosts may only support the view command below
    }
    await vscode.commands.executeCommand('workbench.view.extension.su-ai');
    try {
      await vscode.commands.executeCommand('su.chat.focus');
    } catch {
      // focus command is generated when the view is registered
    }
  }

  /** Stops in-flight generation (Esc / stop button). */
  stopGeneration(): void {
    this.abort?.abort();
  }

  /** Pushes status (and pending-diff badge) to webview / status bar. */
  async refreshStatus(): Promise<void> {
    await this.pushStatus();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (raw: WebviewToExt) => {
      switch (raw.type) {
        case 'ready':
          await this.pushStatus();
          this.pushRestore();
          break;
        case 'send':
          await this.handleSend(
            raw.text,
            raw.includeSelection,
            raw.mode === 'agent' ? 'agent' : 'chat',
            raw.modelPick,
            raw.attachments,
          );
          break;
        case 'listSkills':
          this.post({
            type: 'skills',
            skills: (await listInstalledSkills()).map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              source: s.source,
            })),
          });
          break;
        case 'resolveDrop':
          this.post({
            type: 'dropResolved',
            items: await resolveDroppedUris(raw.uris || []),
          });
          break;
        case 'pickFiles': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: '添加到 Chat',
          });
          if (picked?.length) {
            this.post({
              type: 'dropResolved',
              items: await resolveDroppedUris(picked.map((u) => u.fsPath)),
            });
          }
          break;
        }
        case 'stop':
          this.stopGeneration();
          break;
        case 'newChat':
          await this.newSession();
          break;
        case 'listSessions':
          this.post({ type: 'sessions', sessions: sessionSummaries(this.store) });
          break;
        case 'switchSession':
          await this.switchSession(raw.id);
          break;
        case 'deleteSession':
          await this.deleteSession(raw.id);
          break;
        case 'setMode':
          await this.setMode(raw.mode === 'agent' ? 'agent' : 'chat');
          break;
        case 'reviewDiffs':
          await vscode.commands.executeCommand('su.reviewAgentDiffs');
          break;
        case 'keepAllDiffs': {
          const n = await this.diffs.keepAll();
          void vscode.window.showInformationMessage(n ? `已 Keep ${n} 个文件。` : '没有待审改动。');
          this.emitDiffsChanged();
          await this.pushStatus();
          break;
        }
        case 'rejectAllDiffs': {
          const n = await this.diffs.rejectAll();
          void vscode.window.showInformationMessage(n ? `已 Reject ${n} 个文件。` : '没有待审改动。');
          this.emitDiffsChanged();
          await this.pushStatus();
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('su.openSettings');
          break;
        case 'editModels':
          await vscode.commands.executeCommand('su.editModels');
          break;
        case 'setApiKey':
          await promptAndSetApiKey(this.context);
          await this.pushStatus();
          break;
        case 'openUserManual':
          await vscode.commands.executeCommand('su.openUserManual');
          break;
        case 'setModelPick':
          await this.setModelPick(raw.pick);
          break;
        case 'applyCode':
          await this.applyCodeToEditor(raw.code);
          break;
        default:
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.pushStatus();
      }
    });
  }

  private emitDiffsChanged(): void {
    this.onPendingDiffsChanged?.(this.diffs.size);
  }

  private async setStreaming(on: boolean): Promise<void> {
    this.streaming = on;
    await vscode.commands.executeCommand('setContext', 'su.chatStreaming', on);
  }

  private async applyCodeToEditor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('没有打开的编辑器，无法应用代码。');
      return;
    }
    const text = code.replace(/\r\n/g, '\n');
    await editor.edit((builder) => {
      if (editor.selection.isEmpty) {
        builder.insert(editor.selection.active, text);
      } else {
        builder.replace(editor.selection, text);
      }
    });
    void vscode.window.showInformationMessage('已应用到当前文件。');
  }

  private get activeSession(): ChatSession {
    const found = this.store.sessions.find((s) => s.id === this.store.activeId);
    if (found) {
      return found;
    }
    const created = createEmptySession(this.getMode());
    this.store = { activeId: created.id, sessions: [created, ...this.store.sessions] };
    return created;
  }

  private get history(): ChatMessage[] {
    return this.activeSession.messages;
  }

  private set history(messages: ChatMessage[]) {
    const s = this.activeSession;
    s.messages = trimMessages(messages);
    s.title = titleFromMessages(s.messages);
    s.updatedAt = Date.now();
  }

  private loadStore(): SessionStore {
    const existing = this.context.workspaceState.get<SessionStore>(SESSIONS_KEY);
    if (existing && Array.isArray(existing.sessions) && existing.sessions.length > 0) {
      return normalizeStore(existing, this.getMode());
    }
    const legacy = this.context.workspaceState.get<ChatMessage[]>(LEGACY_HISTORY_KEY, []);
    const mode = this.getMode();
    if (Array.isArray(legacy) && legacy.length > 0) {
      const session = createEmptySession(mode);
      session.messages = trimMessages(legacy);
      session.title = titleFromMessages(session.messages);
      const store = { activeId: session.id, sessions: [session] };
      void this.context.workspaceState.update(SESSIONS_KEY, store);
      void this.context.workspaceState.update(LEGACY_HISTORY_KEY, undefined);
      return store;
    }
    return normalizeStore(undefined, mode);
  }

  private async persistStore(): Promise<void> {
    this.store = normalizeStore(this.store, this.getMode());
    await this.context.workspaceState.update(SESSIONS_KEY, this.store);
  }

  private async saveHistory(): Promise<void> {
    this.history = this.history;
    await this.persistStore();
  }

  private getMode(): ChatMode {
    const m = this.context.workspaceState.get<string>(MODE_KEY, 'chat');
    return m === 'agent' ? 'agent' : 'chat';
  }

  private async setMode(mode: ChatMode): Promise<void> {
    await this.context.workspaceState.update(MODE_KEY, mode);
    const s = this.activeSession;
    s.mode = mode;
    s.updatedAt = Date.now();
    await this.persistStore();
    await this.pushStatus();
  }

  private getModelPick(): string {
    const stored = this.context.workspaceState.get<string>(MODEL_PICK_KEY, MODEL_PICK_AUTO);
    const pick = (stored || MODEL_PICK_AUTO).trim() || MODEL_PICK_AUTO;
    if (pick === MODEL_PICK_AUTO) {
      return MODEL_PICK_AUTO;
    }
    const catalog = getModelCatalog();
    return catalog.includes(pick) ? pick : MODEL_PICK_AUTO;
  }

  private async setModelPick(pick: string): Promise<void> {
    const next = (pick || MODEL_PICK_AUTO).trim() || MODEL_PICK_AUTO;
    const valid =
      next === MODEL_PICK_AUTO || getModelCatalog().includes(next) ? next : MODEL_PICK_AUTO;
    await this.context.workspaceState.update(MODEL_PICK_KEY, valid);
    await this.pushStatus();
  }

  private async newSession(): Promise<void> {
    this.abort?.abort();
    this.abort = undefined;
    const mode = this.getMode();
    const current = this.activeSession;
    if (current.messages.length === 0) {
      current.mode = mode;
      current.updatedAt = Date.now();
      await this.persistStore();
      this.pushRestore();
      await this.pushStatus();
      return;
    }
    const created = createEmptySession(mode);
    this.store.sessions = [created, ...this.store.sessions];
    this.store.activeId = created.id;
    await this.persistStore();
    this.pushRestore();
    await this.pushStatus();
  }

  private async switchSession(id: string): Promise<void> {
    if (!this.store.sessions.some((s) => s.id === id)) {
      return;
    }
    this.abort?.abort();
    this.abort = undefined;
    this.store.activeId = id;
    const s = this.activeSession;
    await this.context.workspaceState.update(MODE_KEY, s.mode);
    await this.persistStore();
    this.pushRestore();
    await this.pushStatus();
    this.post({ type: 'sessions', sessions: sessionSummaries(this.store) });
  }

  private async deleteSession(id: string): Promise<void> {
    const wasActive = this.store.activeId === id;
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id);
    if (!this.store.sessions.length) {
      const created = createEmptySession(this.getMode());
      this.store = { activeId: created.id, sessions: [created] };
    } else if (wasActive) {
      this.store.activeId = this.store.sessions[0].id;
      await this.context.workspaceState.update(MODE_KEY, this.activeSession.mode);
    }
    this.abort?.abort();
    this.abort = undefined;
    await this.persistStore();
    this.pushRestore();
    await this.pushStatus();
    this.post({ type: 'sessions', sessions: sessionSummaries(this.store) });
  }

  private pushRestore(): void {
    const s = this.activeSession;
    this.post({
      type: 'restore',
      title: s.title,
      messages: s.messages
        .filter(
          (m): m is ChatMessage & { role: 'user' | 'assistant'; content: string } =>
            (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        )
        .map((m) => ({ role: m.role, content: m.content })),
    });
  }

  private async pushStatus(): Promise<void> {
    const cfg = await resolveSuRuntimeConfig(this.context);
    const modelPick = this.getModelPick();
    const activeModel = resolveActiveModel(modelPick, cfg);
    const s = this.activeSession;
    this.emitDiffsChanged();
    this.post({
      type: 'status',
      hasKey: Boolean(cfg.apiKey),
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      pendingDiffs: this.diffs.size,
      models: getModelCatalog(cfg),
      modelPick,
      activeModel,
      mode: this.getMode(),
      sessionTitle: s.title,
      sessionId: s.id,
    });
  }

  private async handleSend(
    text: string,
    includeSelection: boolean,
    mode: ChatMode,
    modelPickFromUi?: string,
    attachments?: ChatAttachment[],
  ): Promise<void> {
    const trimmed = text.trim();
    const hasAtt = Boolean(attachments && attachments.length);
    if (!trimmed && !hasAtt) {
      return;
    }
    if (this.abort) {
      this.abort.abort();
      this.abort = undefined;
    }

    await this.setMode(mode);
    if (modelPickFromUi !== undefined) {
      await this.setModelPick(modelPickFromUi);
    }

    let prompt = trimmed;
    if (includeSelection) {
      const sel = vscode.window.activeTextEditor?.document.getText(
        vscode.window.activeTextEditor.selection,
      );
      if (sel && sel.trim()) {
        prompt = `${trimmed}\n\n\`\`\`\n${sel.trim()}\n\`\`\``.trim();
      }
    }

    const turn = await buildUserTurn(prompt, attachments);
    const workspaceCtx = await buildWorkspaceContextSnippet();
    const systemExtras = [workspaceCtx, ...turn.systemExtras];
    const next = [...this.history, { role: 'user' as const, content: turn.historyText }];
    this.history = next;
    await this.saveHistory();
    this.post({ type: 'user', text: turn.historyText });
    this.post({ type: 'assistantStart' });
    await this.setStreaming(true);

    const cfg = await resolveSuRuntimeConfig(this.context);
    const activeModel = resolveActiveModel(this.getModelPick(), cfg);
    this.abort = new AbortController();

    if (mode === 'agent') {
      await this.runAgentTurn(turn.apiContent, systemExtras, {
        ...cfg,
        model: activeModel,
        timeoutMs: Math.max(
          cfg.timeoutMs,
          systemExtras.length > 0 || Array.isArray(turn.apiContent) ? 120_000 : cfg.timeoutMs,
        ),
      });
      return;
    }

    await this.runAskTurn(turn.apiContent, systemExtras, {
      ...cfg,
      model: activeModel,
      timeoutMs: Math.max(
        cfg.timeoutMs,
        systemExtras.length > 0 || Array.isArray(turn.apiContent) ? 120_000 : cfg.timeoutMs,
      ),
    });
  }

  private async runAskTurn(
    userContent: import('../openaiClient').ChatMessage['content'],
    systemExtras: string[],
    cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
  ): Promise<void> {
    let assistant = '';
    try {
      await runAskWithTools({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        userContent: userContent ?? '',
        systemExtras,
        history: this.history.slice(0, -1),
        signal: this.abort?.signal,
        onEvent: (ev) => {
          if (ev.type === 'tool') {
            this.post({ type: 'tool', text: ev.detail });
          } else if (ev.type === 'assistant') {
            assistant = ev.text;
            this.post({ type: 'assistantDelta', text: ev.text });
          } else if (ev.type === 'done') {
            if (!assistant && ev.summary) {
              assistant = ev.summary;
              this.post({ type: 'assistantDelta', text: ev.summary });
            }
          }
        },
      });
      if (assistant) {
        this.history = [...this.history, { role: 'assistant', content: assistant }];
        await this.saveHistory();
      }
      this.post({ type: 'assistantDone' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === '已停止生成') {
        if (assistant) {
          this.history = [...this.history, { role: 'assistant', content: assistant }];
          await this.saveHistory();
        }
        this.post({ type: 'stopped' });
      } else {
        this.post({
          type: 'error',
          message: friendlyChatError(message, { hadImages: Array.isArray(userContent) }),
        });
      }
    } finally {
      this.abort = undefined;
      await this.setStreaming(false);
      await this.pushStatus();
    }
  }

  private async runAgentTurn(
    userContent: import('../openaiClient').ChatMessage['content'],
    systemExtras: string[],
    cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
  ): Promise<void> {
    let assistant = '';
    try {
      await runAgent({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        userContent: userContent ?? '',
        systemExtras,
        history: this.history.slice(0, -1),
        signal: this.abort?.signal,
        diffs: this.diffs,
        onEvent: (ev) => {
          if (ev.type === 'tool') {
            this.post({ type: 'tool', text: ev.detail });
            this.emitDiffsChanged();
          } else if (ev.type === 'assistant') {
            assistant = ev.text;
            this.post({ type: 'assistantDelta', text: ev.text });
          } else if (ev.type === 'done') {
            if (!assistant && ev.summary) {
              assistant = ev.summary;
              this.post({ type: 'assistantDelta', text: ev.summary });
            }
          }
        },
      });
      if (!assistant) {
        assistant = this.diffs.size
          ? `任务结束。待审改动 ${this.diffs.size} 个文件。`
          : '任务结束。';
        this.post({ type: 'assistantDelta', text: assistant });
      } else if (this.diffs.size) {
        const tip = `\n\n— 待审 ${this.diffs.size} 个文件：可用消息旁 Keep / Reject。`;
        assistant += tip;
        this.post({ type: 'assistantDelta', text: tip });
      }
      this.history = [...this.history, { role: 'assistant', content: assistant }];
      await this.saveHistory();
      this.post({ type: 'assistantDone' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === '已停止生成') {
        if (assistant) {
          this.history = [...this.history, { role: 'assistant', content: assistant }];
          await this.saveHistory();
        }
        this.post({ type: 'stopped' });
      } else {
        this.post({
          type: 'error',
          message: friendlyChatError(message, { hadImages: Array.isArray(userContent) }),
        });
      }
    } finally {
      this.abort = undefined;
      await this.setStreaming(false);
      this.emitDiffsChanged();
      await this.pushStatus();
    }
  }

  private post(msg: ExtToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      // data: needed for dragged image thumbnails in the composer
      `img-src ${webview.cspSource} data: blob:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Su Chat</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, rgba(127,127,127,.35));
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn2-bg: var(--vscode-button-secondaryBackground);
      --btn2-fg: var(--vscode-button-secondaryForeground);
      --user-bg: color-mix(in srgb, var(--vscode-button-background) 22%, transparent);
      --ai-bg: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      --code-bg: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15));
      --link: var(--vscode-textLink-foreground);
      --err: var(--vscode-errorForeground);
      --font: var(--vscode-font-family);
      --mono: var(--vscode-editor-font-family);
      --list-hover: var(--vscode-list-hoverBackground);
      --list-active: var(--vscode-list-activeSelectionBackground);
      --focus: var(--vscode-focusBorder, var(--btn-bg));
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font); }
    body { display: flex; flex-direction: column; position: relative; }
    header { padding: 8px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    .top-row { display: flex; align-items: center; gap: 6px; }
    .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn {
      width: 28px; height: 28px; padding: 0; border-radius: 6px; border: 1px solid transparent;
      background: transparent; color: var(--fg); font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer; position: relative;
    }
    .icon-btn:hover { background: var(--list-hover); border-color: var(--border); }
    .badge {
      position: absolute; top: -2px; right: -2px; min-width: 14px; height: 14px; padding: 0 3px;
      border-radius: 7px; background: var(--btn-bg); color: var(--btn-fg); font-size: 9px; line-height: 14px; text-align: center;
    }
    .badge.hidden { display: none; }
    header .meta { color: var(--muted); font-size: 11px; word-break: break-all; }
    .menu-wrap { position: relative; }
    .menu-pop {
      display: none; position: absolute; right: 0; top: 30px; z-index: 30; min-width: 160px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
    }
    .menu-pop.open { display: flex; flex-direction: column; }
    .menu-pop button {
      text-align: left; background: transparent; color: var(--fg); border: none; border-radius: 6px;
      padding: 6px 10px; cursor: pointer; font: 12px var(--font);
    }
    .menu-pop button:hover { background: var(--list-hover); }
    #thread { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .empty {
      margin: auto; max-width: 280px; text-align: left; color: var(--muted); font-size: 12px; line-height: 1.6;
      border: 1px dashed var(--border); border-radius: 10px; padding: 14px 16px;
    }
    .empty h3 { margin: 0 0 8px; color: var(--fg); font-size: 13px; }
    .empty ol { margin: 0; padding-left: 1.2em; }
    .empty a { color: var(--link); cursor: pointer; text-decoration: underline; }
    .msg { padding: 8px 10px; border-radius: 8px; word-break: break-word; border: 1px solid var(--border); }
    .msg.user { background: var(--user-bg); align-self: flex-end; max-width: 95%; white-space: pre-wrap; }
    .msg.assistant { background: var(--ai-bg); align-self: stretch; }
    .msg.error { color: var(--err); white-space: pre-wrap; }
    .msg .role { font-size: 10px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
    .msg .body.md h1, .msg .body.md h2, .msg .body.md h3 { margin: 0.6em 0 0.35em; line-height: 1.25; font-size: 1.05em; }
    .msg .body.md p { margin: 0.4em 0; }
    .msg .body.md ul, .msg .body.md ol { margin: 0.35em 0; padding-left: 1.3em; }
    .msg .body.md code { font-family: var(--mono); font-size: 12px; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
    .msg .body.md pre {
      margin: 0.5em 0; padding: 8px; overflow: auto; background: var(--code-bg);
      border-radius: 6px; border: 1px solid var(--border); position: relative;
    }
    .msg .body.md pre code { padding: 0; background: transparent; }
    .code-actions { display: flex; gap: 4px; margin: -4px 0 6px; justify-content: flex-end; }
    .code-actions button {
      font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border);
      background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
    }
    .msg .body.md a { color: var(--link); }
    .msg .body.md blockquote { margin: 0.4em 0; padding-left: 0.8em; border-left: 3px solid var(--border); color: var(--muted); }
    .msg.streaming .body { white-space: pre-wrap; }
    .msg.tool { align-self: stretch; color: var(--muted); font-size: 12px; white-space: pre-wrap; }
    .msg.tool-fold-wrap {
      align-self: stretch; padding: 0; border: 1px solid var(--border); border-radius: 8px;
      background: color-mix(in srgb, var(--input-bg) 80%, transparent); overflow: hidden;
    }
    .tool-fold { margin: 0; }
    .tool-fold > summary {
      list-style: none; cursor: pointer; user-select: none;
      padding: 8px 10px; font-size: 12px; color: var(--muted);
      display: flex; align-items: center; gap: 6px;
    }
    .tool-fold > summary::-webkit-details-marker { display: none; }
    .tool-fold > summary::before {
      content: '▸'; color: var(--muted); font-size: 10px; transition: transform .12s ease;
    }
    .tool-fold[open] > summary::before { transform: rotate(90deg); }
    .tool-fold > summary:hover { color: var(--fg); background: var(--list-hover); }
    .tool-fold-body {
      border-top: 1px solid var(--border); max-height: 280px; overflow: auto;
      padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 8px;
    }
    .tool-step {
      border: 1px solid var(--border); border-radius: 6px; background: var(--code-bg); overflow: hidden;
    }
    .tool-step-label {
      font-size: 11px; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tool-step pre {
      margin: 0; padding: 6px 8px; font: 11px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word;
      max-height: 160px; overflow: auto; color: var(--fg);
    }
    .diff-bar {
      display: none; gap: 6px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--btn-bg) 12%, var(--bg));
    }
    .diff-bar.show { display: flex; align-items: center; }
    .diff-bar .label { color: var(--muted); font-size: 11px; flex: 1; }
    footer { border-top: 1px solid var(--border); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    textarea {
      width: 100%; min-height: 64px; max-height: 160px; resize: vertical;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: 13px/1.4 var(--font);
    }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button.action {
      border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer;
      background: var(--btn-bg); color: var(--btn-fg); font: 12px var(--font);
    }
    button.secondary { background: var(--btn2-bg); color: var(--btn2-fg); border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; font: 12px var(--font); }
    button:disabled { opacity: .55; cursor: default; }
    .pills { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
    .pills button {
      border: none; background: transparent; color: var(--fg); padding: 4px 12px; cursor: pointer; font: 12px var(--font);
    }
    .pills button.active { background: var(--btn-bg); color: var(--btn-fg); }
    .chip {
      display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 999px;
      padding: 3px 10px; font-size: 11px; color: var(--muted); cursor: pointer; user-select: none;
    }
    .chip.on { border-color: var(--focus); color: var(--fg); background: color-mix(in srgb, var(--btn-bg) 18%, transparent); }
    select#modelPick {
      background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border);
      border-radius: 999px; padding: 4px 10px; font: 12px var(--font); max-width: 160px;
    }
    .hint { color: var(--muted); font-size: 11px; }
    #historyPanel {
      display: none; position: absolute; inset: 0; z-index: 20;
      background: color-mix(in srgb, var(--bg) 92%, black); flex-direction: column;
    }
    #historyPanel.open { display: flex; }
    #historyPanel .hp-head {
      display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border); font-weight: 600;
    }
    #historyPanel .hp-list { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
    .hp-item {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
    }
    .hp-item:hover { background: var(--list-hover); }
    .hp-item.active { background: var(--list-active); border-color: var(--border); }
    .hp-item .hp-main { flex: 1; min-width: 0; }
    .hp-item .hp-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hp-item .hp-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .hp-item .hp-del { background: transparent; color: var(--muted); padding: 2px 6px; border-radius: 4px; border: none; cursor: pointer; }
    .hp-item .hp-del:hover { color: var(--err); }
    .hp-empty { color: var(--muted); padding: 16px; text-align: center; }
    .streaming-hint { display: none; color: var(--muted); font-size: 11px; }
    .streaming-hint.on { display: inline; }
    .composer {
      position: relative; border: 1px solid var(--border); border-radius: 8px;
      background: var(--input-bg); padding: 6px; display: flex; flex-direction: column; gap: 6px;
    }
    .composer.dragover { border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
    .attach-row { display: none; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
    .attach-row.show { display: flex; }
    .attach-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px 3px 10px;
      font-size: 11px; color: var(--fg); background: color-mix(in srgb, var(--btn-bg) 14%, transparent);
      position: relative;
    }
    .attach-chip.file-chip {
      background: color-mix(in srgb, var(--focus) 22%, var(--input-bg));
      border-color: color-mix(in srgb, var(--focus) 45%, var(--border));
    }
    .attach-chip.image-chip {
      flex-direction: column; align-items: stretch; border-radius: 10px; padding: 4px;
      background: color-mix(in srgb, var(--bg) 70%, black); max-width: 120px;
    }
    .attach-chip.image-chip img {
      width: 108px; height: 72px; object-fit: cover; border-radius: 8px; display: block;
      background: var(--code-bg);
    }
    .attach-chip.image-chip .cap {
      display: flex; align-items: center; gap: 4px; padding: 2px 4px; max-width: 108px;
    }
    .attach-chip.image-chip .cap span {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted);
    }
    .attach-chip .x { border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 0 2px; line-height: 1; }
    .composer textarea {
      border: none; background: transparent; min-height: 56px; padding: 4px 2px; resize: vertical;
    }
    .composer textarea:focus { outline: none; }
    .slash-menu {
      display: none; position: absolute; left: 8px; right: 8px; bottom: calc(100% + 6px);
      max-height: 240px; overflow: auto; z-index: 40;
      background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 4px;
    }
    .slash-menu.open { display: block; }
    .slash-menu .sec { font-size: 10px; color: var(--muted); padding: 6px 8px 2px; text-transform: uppercase; }
    .slash-item {
      display: block; width: 100%; text-align: left; border: none; background: transparent;
      color: var(--fg); border-radius: 6px; padding: 6px 8px; cursor: pointer; font: 12px var(--font);
    }
    .slash-item:hover, .slash-item.active { background: var(--list-hover); }
    .slash-item .desc { color: var(--muted); font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body>
  <header>
    <div class="top-row">
      <div class="title" id="sessionTitle">Su Chat</div>
      <button type="button" class="icon-btn" id="btnDiff" title="审阅 Diff">⇄<span class="badge hidden" id="diffBadge">0</span></button>
      <button type="button" class="icon-btn" id="btnNew" title="新对话">+</button>
      <button type="button" class="icon-btn" id="btnHistory" title="历史记录">◷</button>
      <div class="menu-wrap">
        <button type="button" class="icon-btn" id="btnMore" title="更多">⋯</button>
        <div class="menu-pop" id="moreMenu">
          <button type="button" id="mModels">模型列表</button>
          <button type="button" id="mKey">设置 API Key</button>
          <button type="button" id="mSettings">中转 / 默认模型</button>
          <button type="button" id="mManual">用户手册</button>
        </div>
      </div>
    </div>
    <div class="meta" id="meta">加载中…</div>
  </header>
  <div id="thread"></div>
  <div class="diff-bar" id="diffBar">
    <span class="label" id="diffLabel">待审 0 个文件</span>
    <button type="button" class="secondary" id="btnKeepAll">Keep All</button>
    <button type="button" class="secondary" id="btnRejectAll">Reject All</button>
    <button type="button" class="secondary" id="btnReviewBar">审阅</button>
  </div>
  <footer>
    <div class="composer" id="composer">
      <div class="attach-row" id="attachRow"></div>
      <div class="slash-menu" id="slashMenu"></div>
      <textarea id="input" placeholder="问 Su… 可拖入图片/文件；输入 / 选 Skill；Enter 发送"></textarea>
    </div>
    <div class="row">
      <div class="pills" title="Ask=问答；Agent=可改工作区">
        <button type="button" id="pillAsk" class="active">Ask</button>
        <button type="button" id="pillAgent">Agent</button>
      </div>
      <select id="modelPick" aria-label="选择模型"><option value="auto">Auto</option></select>
      <button type="button" class="secondary" id="btnAttach" title="添加文件/文件夹">📎</button>
      <span class="chip" id="selChip" title="发送时附带当前选区">选区</span>
      <span class="streaming-hint" id="streamHint">生成中 · Esc 停止</span>
      <span style="flex:1"></span>
      <button type="button" class="secondary" id="btnStop" disabled>停止</button>
      <button type="button" class="action" id="btnSend">发送</button>
    </div>
    <div class="hint">拖入图片/文件（侧栏拖入若被拦截可按住 Shift）· 📎 添加 · / Skills</div>
  </footer>
  <div id="historyPanel" aria-hidden="true">
    <div class="hp-head">
      <span style="flex:1">历史对话</span>
      <button type="button" class="secondary" id="btnCloseHistory">关闭</button>
    </div>
    <div class="hp-list" id="historyList"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const input = document.getElementById('input');
    const meta = document.getElementById('meta');
    const sessionTitle = document.getElementById('sessionTitle');
    const modelPick = document.getElementById('modelPick');
    const pillAsk = document.getElementById('pillAsk');
    const pillAgent = document.getElementById('pillAgent');
    const selChip = document.getElementById('selChip');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const streamHint = document.getElementById('streamHint');
    const historyPanel = document.getElementById('historyPanel');
    const historyList = document.getElementById('historyList');
    const moreMenu = document.getElementById('moreMenu');
    const diffBar = document.getElementById('diffBar');
    const diffBadge = document.getElementById('diffBadge');
    const diffLabel = document.getElementById('diffLabel');
    const composer = document.getElementById('composer');
    const attachRow = document.getElementById('attachRow');
    const slashMenu = document.getElementById('slashMenu');
    const footer = document.querySelector('footer');
    let mode = 'chat';
    let includeSel = false;
    let streaming = false;
    let currentCard = null;
    let currentBody = null;
    /** Collapsed Ask/Agent tool process group for the in-flight turn. */
    let processFold = null;
    let defaultModel = '';
    let messageCount = 0;
    let attachments = [];
    let skillsCache = [];
    let slashIndex = 0;

    function setMode(m) {
      mode = m === 'agent' ? 'agent' : 'chat';
      pillAsk.classList.toggle('active', mode === 'chat');
      pillAgent.classList.toggle('active', mode === 'agent');
      input.placeholder = mode === 'agent'
        ? '给 Agent 下任务… 可拖文件；/ 选 Skill；写后 Keep/Reject'
        : '问 Su… 可拖图片/文件；输入 / 选 Skill；Enter 发送';
    }

    function isImagePath(p) {
      return /\\.(png|jpe?g|gif|webp|bmp)$/i.test(String(p || ''));
    }

    function basenameOf(p) {
      return String(p || '').split(/[/\\\\]/).filter(Boolean).pop() || String(p || 'file');
    }

    function renderAttachments() {
      attachRow.innerHTML = '';
      attachRow.classList.toggle('show', attachments.length > 0);
      attachments.forEach((a, idx) => {
        const el = document.createElement('span');
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'x';
        x.textContent = '×';
        x.addEventListener('click', () => {
          attachments.splice(idx, 1);
          renderAttachments();
        });
        if (a.kind === 'image' && a.dataBase64) {
          el.className = 'attach-chip image-chip';
          const img = document.createElement('img');
          img.alt = a.name || 'image';
          img.src = 'data:' + (a.mime || 'image/png') + ';base64,' + a.dataBase64;
          el.appendChild(img);
          const cap = document.createElement('div');
          cap.className = 'cap';
          const lab = document.createElement('span');
          lab.textContent = a.name || 'image';
          cap.appendChild(lab);
          cap.appendChild(x);
          el.appendChild(cap);
        } else if (a.kind === 'skill') {
          el.className = 'attach-chip';
          el.appendChild(document.createTextNode('/ ' + (a.name || a.id)));
          el.appendChild(x);
        } else if (a.kind === 'folder') {
          el.className = 'attach-chip file-chip';
          el.title = a.path || '';
          el.appendChild(document.createTextNode(basenameOf(a.path) + '/'));
          el.appendChild(x);
        } else if (a.kind === 'fileInline') {
          el.className = 'attach-chip file-chip';
          el.title = a.name || 'file';
          el.appendChild(document.createTextNode(a.name || 'file'));
          el.appendChild(x);
        } else {
          el.className = 'attach-chip file-chip';
          el.title = a.path || a.name || '';
          el.appendChild(document.createTextNode(basenameOf(a.path || a.name || 'file')));
          el.appendChild(x);
        }
        attachRow.appendChild(el);
      });
    }

    function addAttachment(item) {
      if (!item) return;
      if (item.kind === 'image') {
        if (!item.dataBase64) {
          if (item.path) vscode.postMessage({ type: 'resolveDrop', uris: [item.path] });
          return;
        }
        attachments.push({
          kind: 'image',
          name: item.name || 'image.png',
          mime: item.mime || 'image/png',
          dataBase64: item.dataBase64,
        });
      } else if (item.kind === 'folder') {
        if (attachments.some((a) => a.kind === 'folder' && a.path === item.path)) return;
        attachments.push({ kind: 'folder', path: item.path });
      } else if (item.kind === 'skill') {
        if (attachments.some((a) => a.kind === 'skill' && a.id === item.id)) return;
        attachments.push({ kind: 'skill', id: item.id, name: item.name });
      } else if (item.kind === 'fileInline') {
        const name = item.name || 'file';
        if (attachments.some((a) => a.kind === 'fileInline' && a.name === name && a.text === item.text)) return;
        attachments.push({ kind: 'fileInline', name: name, text: String(item.text || '') });
      } else if (item.kind === 'file' || item.path) {
        const p = item.path || '';
        if (!p) return;
        if (isImagePath(p)) {
          vscode.postMessage({ type: 'resolveDrop', uris: [p] });
          return;
        }
        if (attachments.some((a) => a.kind === 'file' && a.path === p)) return;
        attachments.push({ kind: 'file', path: p });
      }
      renderAttachments();
    }

    function fileToAttachment(file) {
      return new Promise((resolve) => {
        const looksImg = (file.type && file.type.indexOf('image/') === 0) || isImagePath(file.name);
        if (looksImg) {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            const m = result.match(/^data:([^;]+);base64,(.+)$/);
            if (!m) { resolve(null); return; }
            const mime = m[1] || file.type || 'image/png';
            resolve({
              kind: 'image',
              name: file.name,
              mime: mime.indexOf('image/') === 0 ? mime : 'image/png',
              dataBase64: m[2],
            });
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
          return;
        }
        // OS/webview often strips File.path; read text so code files still become chips.
        if (file.size > 400000) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || '');
          if (!text || /[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/.test(text.slice(0, 2048))) {
            resolve(null);
            return;
          }
          resolve({ kind: 'fileInline', name: file.name || 'file', text: text.slice(0, 100000) });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
    }

    function pushUniqueUri(arr, u) {
      const t = String(u || '').trim();
      if (!t || t.startsWith('#')) return;
      if (arr.indexOf(t) < 0) arr.push(t);
    }

    function harvestUrisFromText(text, into) {
      const raw = String(text || '');
      if (!raw.trim()) return;
      // ResourceURLs / some VS Code payloads are JSON string arrays.
      if (raw.charAt(0) === '[') {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            parsed.forEach((x) => pushUniqueUri(into, String(x)));
            return;
          }
        } catch (_) {}
      }
      raw.split(/\\r?\\n/).forEach((line) => {
        const t = String(line || '').trim();
        if (!t || t.startsWith('#')) return;
        pushUniqueUri(into, t);
        const re = /(file:\\/\\/[^\\s]+|vscode-[a-z-]+:\\/\\/[^\\s]+|[A-Za-z]:[\\\\/][^\\r\\n\\t\"<>|*?]+|\\/(?:Users|home|tmp|var|mnt|Volumes)[^\\r\\n\\t\"<>|*?]*)/g;
        let m;
        while ((m = re.exec(t))) {
          pushUniqueUri(into, m[1]);
        }
      });
    }

    function collectDropUris(dt) {
      const uris = [];
      const prefer = [
        'text/uri-list',
        'application/vnd.code.uri-list',
        'resourceurls',
        'ResourceURLs',
        'text/plain',
      ];
      prefer.forEach((t) => {
        try { harvestUrisFromText(dt.getData(t), uris); } catch (_) {}
      });
      const types = dt.types ? Array.from(dt.types) : [];
      types.forEach((t) => {
        if (prefer.indexOf(t) >= 0) return;
        try { harvestUrisFromText(dt.getData(t), uris); } catch (_) {}
      });
      return uris.filter((u) =>
        u.indexOf('file:') === 0 ||
        u.indexOf('vscode-') === 0 ||
        u.indexOf('/') === 0 ||
        /^[A-Za-z]:[\\\\/]/.test(u) ||
        u.indexOf('\\\\') === 0
      );
    }

    async function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      composer.classList.remove('dragover');
      const dt = e.dataTransfer;
      if (!dt) return;
      const uris = collectDropUris(dt);
      const files = dt.files ? Array.from(dt.files) : [];
      let added = 0;
      for (const f of files) {
        const fpath = f.path || '';
        if (fpath) pushUniqueUri(uris, fpath);
        const att = await fileToAttachment(f);
        if (att) {
          addAttachment(att);
          added += 1;
        } else if (fpath) {
          pushUniqueUri(uris, fpath);
        }
      }
      if (uris.length) {
        vscode.postMessage({ type: 'resolveDrop', uris });
        return;
      }
      if (!added && !files.length) {
        // Explorer drops sometimes need Shift so the webview receives the event with uri-list.
        metaFlash('未识别到文件路径：可按住 Shift 再拖，或点 📎 添加');
      }
    }

    function metaFlash(text) {
      const meta = document.getElementById('meta');
      if (!meta) return;
      const prev = meta.textContent;
      meta.textContent = text;
      setTimeout(() => { if (meta.textContent === text) meta.textContent = prev; }, 3500);
    }

    function closeSlash() {
      slashMenu.classList.remove('open');
      slashMenu.innerHTML = '';
      slashIndex = 0;
    }

    function openSlash(filterText) {
      const q = (filterText || '').toLowerCase();
      const list = (skillsCache || []).filter((s) => {
        if (!q) return true;
        return (s.name + ' ' + s.description + ' ' + s.id).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 40);
      slashMenu.innerHTML = '';
      if (!list.length) {
        slashMenu.innerHTML = '<div class="sec">无匹配 Skill</div>';
        slashMenu.classList.add('open');
        return;
      }
      const sec = document.createElement('div');
      sec.className = 'sec';
      sec.textContent = 'Skills';
      slashMenu.appendChild(sec);
      list.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slash-item' + (i === 0 ? ' active' : '');
        btn.dataset.index = String(i);
        btn.innerHTML = '<div>/' + escapeHtml(s.name) + '</div><div class="desc"></div>';
        btn.querySelector('.desc').textContent = s.description || s.source;
        btn.addEventListener('click', () => pickSkill(s));
        slashMenu.appendChild(btn);
      });
      slashIndex = 0;
      slashMenu.classList.add('open');
    }

    function pickSkill(s) {
      addAttachment({ kind: 'skill', id: s.id, name: s.name });
      const v = input.value;
      input.value = v.replace(/(^|\\s)\\/[^\\s]*$/, '$1').replace(/\\s+$/, ' ');
      closeSlash();
      input.focus();
    }

    function maybeSlash() {
      const v = input.value;
      const m = v.match(/(?:^|\\s)\\/([^\\s]*)$/);
      if (!m) { closeSlash(); return; }
      const filter = m[1] || '';
      if (!skillsCache.length) {
        vscode.postMessage({ type: 'listSkills' });
      }
      openSlash(filter);
    }
    pillAsk.addEventListener('click', () => { setMode('chat'); vscode.postMessage({ type: 'setMode', mode: 'chat' }); });
    pillAgent.addEventListener('click', () => { setMode('agent'); vscode.postMessage({ type: 'setMode', mode: 'agent' }); });
    selChip.addEventListener('click', () => {
      includeSel = !includeSel;
      selChip.classList.toggle('on', includeSel);
    });

    function fillModelPick(models, selected, defModel) {
      defaultModel = defModel || '';
      const cur = selected || 'auto';
      modelPick.innerHTML = '';
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = defaultModel ? ('Auto (' + defaultModel + ')') : 'Auto';
      modelPick.appendChild(autoOpt);
      (models || []).forEach((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        modelPick.appendChild(opt);
      });
      modelPick.value = (cur === 'auto' || (models || []).indexOf(cur) >= 0) ? cur : 'auto';
    }
    modelPick.addEventListener('change', () => vscode.postMessage({ type: 'setModelPick', pick: modelPick.value }));

    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderMarkdown(src) {
      const tick = String.fromCharCode(96);
      const escaped = escapeHtml(src);
      const fences = [];
      const fenceRe = new RegExp(tick + tick + tick + '([\\\\w+-]*)\\\\n([\\\\s\\\\S]*?)' + tick + tick + tick, 'g');
      let text = escaped.replace(fenceRe, (_, lang, code) => {
        const i = fences.length;
        fences.push({ lang: lang || '', code: code.replace(/\\n$/, '') });
        return '@@FENCE' + i + '@@';
      });
      text = text.replace(new RegExp(tick + '([^' + tick + '\\\\n]+)' + tick, 'g'), '<code>$1</code>');
      text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\((https?:\\\\/\\\\/[^)\\\\s]+)\\\\)', 'g'), '<a href="$2">$1</a>');
      text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
      text = text.replace(/(?:<li>[\\s\\S]*?<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>');
      text = text.replace(/\\n{2,}/g, '</p><p>');
      text = text.replace(/\\n/g, '<br>');
      text = '<p>' + text + '</p>';
      text = text.replace(/@@FENCE(\\d+)@@/g, (_, i) => {
        const f = fences[Number(i)];
        const rawAttr = escapeHtml(f.code);
        return '<div class="code-actions">' +
          '<button type="button" data-copy="' + i + '">复制</button>' +
          '<button type="button" data-apply="' + i + '">应用</button></div>' +
          '<pre><code class="language-' + f.lang + '">' + f.code + '</code></pre>' +
          '<textarea class="code-raw" data-raw-i="' + i + '" style="display:none">' + rawAttr + '</textarea>';
      });
      text = text.replace(/<p><\\/p>/g, '');
      text = text.replace(/<p>(<h[1-3]>)/g, '$1').replace(/(<\\/h[1-3]>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<div class="code-actions">)/g, '$1').replace(/(<\\/pre>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<ul>)/g, '$1').replace(/(<\\/ul>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<blockquote>)/g, '$1').replace(/(<\\/blockquote>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<textarea)/g, '$1').replace(/(<\\/textarea>)<\\/p>/g, '$1');
      return text;
    }

    function wireCodeActions(root) {
      root.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = btn.getAttribute('data-copy');
          const ta = root.querySelector('textarea[data-raw-i="' + i + '"]');
          const code = ta ? ta.value : '';
          navigator.clipboard.writeText(code).catch(() => {});
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1200);
        });
      });
      root.querySelectorAll('[data-apply]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = btn.getAttribute('data-apply');
          const ta = root.querySelector('textarea[data-raw-i="' + i + '"]');
          const code = ta ? ta.value : '';
          vscode.postMessage({ type: 'applyCode', code });
        });
      });
    }

    function setStreaming(on) {
      streaming = on;
      btnSend.disabled = on;
      btnStop.disabled = !on;
      streamHint.classList.toggle('on', on);
      pillAsk.disabled = on;
      pillAgent.disabled = on;
    }

    function showEmpty() {
      thread.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'empty';
      el.id = 'emptyState';
      el.innerHTML = '<h3>开始使用 Su</h3><ol>' +
        '<li><a data-act="key">设置 API Key</a></li>' +
        '<li>在下方输入问题并发送</li>' +
        '<li>需要改文件时切到 <strong>Agent</strong></li>' +
        '<li><a data-act="manual">打开用户手册</a></li></ol>';
      thread.appendChild(el);
      el.querySelector('[data-act="key"]').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
      el.querySelector('[data-act="manual"]').addEventListener('click', () => vscode.postMessage({ type: 'openUserManual' }));
      messageCount = 0;
    }

    function clearEmpty() {
      const e = document.getElementById('emptyState');
      if (e) e.remove();
    }

    function addMsg(role, text, cls, asMarkdown) {
      clearEmpty();
      messageCount++;
      const el = document.createElement('div');
      el.className = 'msg ' + (cls || role);
      const r = document.createElement('div');
      r.className = 'role';
      r.textContent = role;
      const b = document.createElement('div');
      b.className = 'body' + (asMarkdown ? ' md' : '');
      if (asMarkdown) {
        b.innerHTML = renderMarkdown(text || '');
        wireCodeActions(b);
      } else {
        b.textContent = text || '';
      }
      el.appendChild(r);
      el.appendChild(b);
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return { card: el, body: b };
    }

    function ensureProcessFold() {
      clearEmpty();
      if (processFold && processFold.wrap && processFold.wrap.isConnected) {
        return processFold;
      }
      messageCount++;
      const wrap = document.createElement('div');
      wrap.className = 'msg tool-fold-wrap';
      const details = document.createElement('details');
      details.className = 'tool-fold';
      const summary = document.createElement('summary');
      summary.textContent = '处理过程（点击展开）';
      const body = document.createElement('div');
      body.className = 'tool-fold-body';
      details.appendChild(summary);
      details.appendChild(body);
      wrap.appendChild(details);
      thread.appendChild(wrap);
      processFold = { wrap: wrap, details: details, summary: summary, body: body, count: 0 };
      return processFold;
    }

    function appendToolStep(text) {
      const fold = ensureProcessFold();
      const raw = String(text || '');
      const firstLine = (raw.split('\\n')[0] || 'TOOL').trim() || 'TOOL';
      const hasBody = raw.indexOf('\\n') >= 0;
      const last = fold.body.lastElementChild;
      // Replace in-progress "name…" step with the completed result.
      if (last && last.getAttribute('data-pending') === '1' && hasBody) {
        last.removeAttribute('data-pending');
        const lab = last.querySelector('.tool-step-label');
        const pre = last.querySelector('pre');
        if (lab) {
          lab.textContent = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
          lab.title = firstLine;
        }
        if (pre) pre.textContent = raw;
        fold.summary.textContent = '处理过程 · ' + fold.count + ' 步（点击展开）';
        thread.scrollTop = thread.scrollHeight;
        return;
      }
      fold.count += 1;
      fold.summary.textContent = '处理过程 · ' + fold.count + ' 步（点击展开）';
      const step = document.createElement('div');
      step.className = 'tool-step';
      if (!hasBody) step.setAttribute('data-pending', '1');
      const label = document.createElement('div');
      label.className = 'tool-step-label';
      label.textContent = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
      label.title = firstLine;
      const pre = document.createElement('pre');
      pre.textContent = raw;
      step.appendChild(label);
      step.appendChild(pre);
      fold.body.appendChild(step);
      thread.scrollTop = thread.scrollHeight;
    }

    function ensureAssistantCard() {
      if (currentCard && currentBody && currentCard.isConnected) {
        return;
      }
      const node = addMsg('su', '', 'assistant streaming', false);
      currentCard = node.card;
      currentBody = node.body;
    }

    function finishAssistantMarkdown() {
      if (!currentCard || !currentBody) {
        processFold = null;
        return;
      }
      currentCard.classList.remove('streaming');
      const raw = currentBody.textContent || '';
      currentBody.classList.add('md');
      currentBody.innerHTML = renderMarkdown(raw);
      wireCodeActions(currentBody);
      currentCard = null;
      currentBody = null;
      processFold = null;
      thread.scrollTop = thread.scrollHeight;
    }

    function updateDiffUi(n) {
      const count = Number(n) || 0;
      diffBadge.textContent = String(count);
      diffBadge.classList.toggle('hidden', count <= 0);
      diffBar.classList.toggle('show', count > 0);
      diffLabel.textContent = '待审 ' + count + ' 个文件';
    }

    function send() {
      if (streaming) return;
      const text = input.value;
      if (!text.trim() && !attachments.length) return;
      closeSlash();
      const payload = attachments.slice();
      input.value = '';
      attachments = [];
      renderAttachments();
      vscode.postMessage({
        type: 'send',
        text,
        includeSelection: includeSel,
        mode,
        modelPick: modelPick.value,
        attachments: payload,
      });
    }

    function fmtTime(ts) {
      try {
        const d = new Date(ts);
        const now = new Date();
        return d.toDateString() === now.toDateString()
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    }

    function renderSessions(list) {
      historyList.innerHTML = '';
      if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.className = 'hp-empty';
        empty.textContent = '暂无历史对话';
        historyList.appendChild(empty);
        return;
      }
      list.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'hp-item' + (s.active ? ' active' : '');
        row.innerHTML = '<div class="hp-main"><div class="hp-title"></div><div class="hp-meta"></div></div>' +
          '<button type="button" class="hp-del" title="删除">×</button>';
        row.querySelector('.hp-title').textContent = s.title || '新对话';
        row.querySelector('.hp-meta').textContent = fmtTime(s.updatedAt) + ' · ' + (s.messageCount || 0) + ' 条';
        row.addEventListener('click', (e) => {
          if (e.target.closest && e.target.closest('.hp-del')) return;
          vscode.postMessage({ type: 'switchSession', id: s.id });
          closeHistory();
        });
        row.querySelector('.hp-del').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSession', id: s.id });
        });
        historyList.appendChild(row);
      });
    }

    function openHistory() {
      historyPanel.classList.add('open');
      historyPanel.setAttribute('aria-hidden', 'false');
      vscode.postMessage({ type: 'listSessions' });
    }
    function closeHistory() {
      historyPanel.classList.remove('open');
      historyPanel.setAttribute('aria-hidden', 'true');
    }

    btnSend.addEventListener('click', send);
    btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('btnNew').addEventListener('click', () => { closeHistory(); vscode.postMessage({ type: 'newChat' }); });
    document.getElementById('btnHistory').addEventListener('click', () => {
      if (historyPanel.classList.contains('open')) closeHistory(); else openHistory();
    });
    document.getElementById('btnCloseHistory').addEventListener('click', closeHistory);
    document.getElementById('btnDiff').addEventListener('click', () => vscode.postMessage({ type: 'reviewDiffs' }));
    document.getElementById('btnKeepAll').addEventListener('click', () => vscode.postMessage({ type: 'keepAllDiffs' }));
    document.getElementById('btnRejectAll').addEventListener('click', () => vscode.postMessage({ type: 'rejectAllDiffs' }));
    document.getElementById('btnReviewBar').addEventListener('click', () => vscode.postMessage({ type: 'reviewDiffs' }));
    document.getElementById('btnMore').addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu.classList.toggle('open');
    });
    document.body.addEventListener('click', (e) => {
      moreMenu.classList.remove('open');
      if (!slashMenu.contains(e.target) && e.target !== input) closeSlash();
    });
    document.getElementById('mModels').addEventListener('click', () => vscode.postMessage({ type: 'editModels' }));
    document.getElementById('mKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('mSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('mManual').addEventListener('click', () => vscode.postMessage({ type: 'openUserManual' }));
    document.getElementById('btnAttach').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));

    function onDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      composer.classList.add('dragover');
    }
    const dropTargets = [composer, footer, document.body].filter(Boolean);
    ;['dragenter', 'dragover'].forEach((ev) => {
      dropTargets.forEach((el) => el.addEventListener(ev, onDragOver));
    });
    dropTargets.forEach((el) => {
      el.addEventListener('dragleave', (e) => {
        if (e.target === el) composer.classList.remove('dragover');
      });
      el.addEventListener('drop', (e) => { void handleDrop(e); });
    });
    // Paste image from clipboard (Cursor-like).
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
      items.forEach((it) => {
        if (it.type && it.type.indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            void fileToAttachment(f).then((att) => { if (att) addAttachment(att); });
          }
        }
      });
    });

    input.addEventListener('input', () => maybeSlash());
    input.addEventListener('keydown', (e) => {
      if (slashMenu.classList.contains('open')) {
        const items = Array.from(slashMenu.querySelectorAll('.slash-item'));
        if (e.key === 'ArrowDown' && items.length) {
          e.preventDefault();
          slashIndex = Math.min(items.length - 1, slashIndex + 1);
          items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
          return;
        }
        if (e.key === 'ArrowUp' && items.length) {
          e.preventDefault();
          slashIndex = Math.max(0, slashIndex - 1);
          items.forEach((el, i) => el.classList.toggle('active', i === slashIndex));
          return;
        }
        if (e.key === 'Enter' && items[slashIndex]) {
          e.preventDefault();
          items[slashIndex].click();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlash();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && streaming) { vscode.postMessage({ type: 'stop' }); }
    });
    vscode.postMessage({ type: 'listSkills' });
    thread.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a && a.href) e.preventDefault();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          fillModelPick(msg.models, msg.modelPick, msg.model);
          setMode(msg.mode || 'chat');
          if (msg.sessionTitle) sessionTitle.textContent = msg.sessionTitle;
          updateDiffUi(msg.pendingDiffs);
          meta.textContent = (msg.hasKey ? 'Key ✓' : 'Key ✗')
            + ' · ' + (msg.activeModel || msg.model)
            + (msg.modelPick === 'auto' ? ' (Auto)' : '')
            + ' · ' + msg.baseUrl;
          break;
        case 'sessions':
          renderSessions(msg.sessions || []);
          break;
        case 'restore':
          thread.innerHTML = '';
          currentCard = null;
          currentBody = null;
          processFold = null;
          setStreaming(false);
          if (msg.title) sessionTitle.textContent = msg.title;
          const msgs = msg.messages || [];
          if (!msgs.length) showEmpty();
          else {
            messageCount = 0;
            msgs.forEach((m) => {
              if (m.role === 'user') addMsg('you', m.content, 'user', false);
              else addMsg('su', m.content, 'assistant', true);
            });
          }
          break;
        case 'user':
          addMsg('you', msg.text, 'user', false);
          break;
        case 'assistantStart': {
          setStreaming(true);
          // Defer the answer card so tool steps stay above the final reply.
          currentCard = null;
          currentBody = null;
          processFold = null;
          break;
        }
        case 'assistantDelta':
          ensureAssistantCard();
          if (currentBody) {
            currentBody.textContent += msg.text;
            thread.scrollTop = thread.scrollHeight;
          }
          break;
        case 'tool':
          appendToolStep(msg.text || '');
          break;
        case 'assistantDone':
        case 'stopped':
          finishAssistantMarkdown();
          setStreaming(false);
          break;
        case 'error':
          setStreaming(false);
          if (currentCard) {
            currentCard.remove();
            currentCard = null;
            currentBody = null;
          }
          processFold = null;
          addMsg('error', msg.message, 'error', false);
          break;
        case 'skills':
          skillsCache = msg.skills || [];
          maybeSlash();
          break;
        case 'dropResolved':
          (msg.items || []).forEach((it) => addAttachment(it));
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
