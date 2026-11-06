import * as vscode from 'vscode';
import {
  getModelCatalog,
  MODEL_PICK_AUTO,
  resolveActiveModel,
  resolveSuRuntimeConfig,
} from '../config';
import { streamChatCompletion, type ChatMessage } from '../openaiClient';
import { promptAndSetApiKey } from '../secrets';
import { runAgent } from '../agent/agentRunner';
import { DiffReviewService } from '../agent/diffReview';
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
  | { type: 'send'; text: string; includeSelection: boolean; mode: ChatMode; modelPick?: string }
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
  | { type: 'applyCode'; code: string };

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
  | { type: 'stopped' };

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
          );
          break;
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
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
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

    let userContent = trimmed;
    if (includeSelection) {
      const sel = vscode.window.activeTextEditor?.document.getText(
        vscode.window.activeTextEditor.selection,
      );
      if (sel && sel.trim()) {
        userContent = `${trimmed}\n\n\`\`\`\n${sel.trim()}\n\`\`\``;
      }
    }

    const next = [...this.history, { role: 'user' as const, content: userContent }];
    this.history = next;
    await this.saveHistory();
    this.post({ type: 'user', text: userContent });
    this.post({ type: 'assistantStart' });
    await this.setStreaming(true);

    const cfg = await resolveSuRuntimeConfig(this.context);
    const activeModel = resolveActiveModel(this.getModelPick(), cfg);
    this.abort = new AbortController();

    if (mode === 'agent') {
      await this.runAgentTurn(userContent, { ...cfg, model: activeModel });
      return;
    }

    let assistant = '';
    try {
      await streamChatCompletion({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: activeModel,
        timeoutMs: cfg.timeoutMs,
        messages: [
          {
            role: 'system',
            content:
              'You are Su, a helpful coding assistant embedded in the su editor. Prefer Markdown. Reply in the user\'s language when possible.',
          },
          ...this.history.filter(
            (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
          ) as ChatMessage[],
        ],
        signal: this.abort.signal,
        onDelta: (delta) => {
          assistant += delta;
          this.post({ type: 'assistantDelta', text: delta });
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
        this.post({ type: 'error', message });
      }
    } finally {
      this.abort = undefined;
      await this.setStreaming(false);
      await this.pushStatus();
    }
  }

  private async runAgentTurn(
    userContent: string,
    cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
  ): Promise<void> {
    let assistant = '';
    try {
      await runAgent({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        userText: userContent,
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
        this.post({ type: 'error', message });
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
    <textarea id="input" placeholder="问 Su…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="row">
      <div class="pills" title="Ask=问答；Agent=可改工作区">
        <button type="button" id="pillAsk" class="active">Ask</button>
        <button type="button" id="pillAgent">Agent</button>
      </div>
      <select id="modelPick" aria-label="选择模型"><option value="auto">Auto</option></select>
      <span class="chip" id="selChip" title="发送时附带当前选区">选区</span>
      <span class="streaming-hint" id="streamHint">生成中 · Esc 停止</span>
      <span style="flex:1"></span>
      <button type="button" class="secondary" id="btnStop" disabled>停止</button>
      <button type="button" class="action" id="btnSend">发送</button>
    </div>
    <div class="hint">+ 新对话 · ◷ 历史 · Ctrl+L Chat · Ctrl+I Agent</div>
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
    let mode = 'chat';
    let includeSel = false;
    let streaming = false;
    let currentCard = null;
    let currentBody = null;
    let defaultModel = '';
    let messageCount = 0;

    function setMode(m) {
      mode = m === 'agent' ? 'agent' : 'chat';
      pillAsk.classList.toggle('active', mode === 'chat');
      pillAgent.classList.toggle('active', mode === 'agent');
      input.placeholder = mode === 'agent'
        ? '给 Agent 下任务…（会读写工作区，写后可 Keep/Reject）'
        : '问 Su…（Enter 发送，Shift+Enter 换行）';
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

    function finishAssistantMarkdown() {
      if (!currentCard || !currentBody) return;
      currentCard.classList.remove('streaming');
      const raw = currentBody.textContent || '';
      currentBody.classList.add('md');
      currentBody.innerHTML = renderMarkdown(raw);
      wireCodeActions(currentBody);
      currentCard = null;
      currentBody = null;
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
      if (!text.trim()) return;
      input.value = '';
      vscode.postMessage({
        type: 'send',
        text,
        includeSelection: includeSel,
        mode,
        modelPick: modelPick.value,
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
    document.body.addEventListener('click', () => moreMenu.classList.remove('open'));
    document.getElementById('mModels').addEventListener('click', () => vscode.postMessage({ type: 'editModels' }));
    document.getElementById('mKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('mSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('mManual').addEventListener('click', () => vscode.postMessage({ type: 'openUserManual' }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && streaming) { vscode.postMessage({ type: 'stop' }); }
    });
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
          const node = addMsg('su', '', 'assistant streaming', false);
          currentCard = node.card;
          currentBody = node.body;
          break;
        }
        case 'assistantDelta':
          if (currentBody) {
            currentBody.textContent += msg.text;
            thread.scrollTop = thread.scrollHeight;
          }
          break;
        case 'tool':
          addMsg('tool', msg.text, 'tool', false);
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
          addMsg('error', msg.message, 'error', false);
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
