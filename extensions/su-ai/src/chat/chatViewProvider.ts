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
  resetTerminalSessionPermissions,
  setTerminalPermissionAsker,
  setUserFeedbackAsker,
  type TerminalPermissionDecision,
  type UserFeedbackKind,
  type UserFeedbackRequest,
  type UserFeedbackResult,
} from '../agent/tools';
import {
  buildUserTurn,
  resolveDroppedUris,
  type ChatAttachment,
} from './attachments';
import { listAtMentionItems } from './atMentions';
import { runAskWithTools } from './askRunner';
import { getPlanProgress, parsePlanResponse, stripPlanTags, validatePlanMarkdown } from './plan';
import {
  isSuPlanFileUri,
  planUriFromRelative,
  readPlanMarkdown,
  writePlanFile,
} from './planFiles';
import { runPlanWithTools } from './planRunner';
import { renderReplyMarkdown } from './replyMarkdown';
import { loadWorkspaceRulesFragment } from './rulesCatalog';
import { listInstalledSkills } from './skillsCatalog';
import { buildWorkspaceContextSnippet } from './workspaceContext';
import {
  createEmptySession,
  LEGACY_HISTORY_KEY,
  normalizeMode,
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
  | { type: 'listAtMentions'; filter?: string }
  | { type: 'resolveDrop'; uris: string[] }
  | { type: 'pickFiles' }
  | { type: 'attachActiveFile' }
  | { type: 'openAgentWindow' }
  | { type: 'openIdeWindow' }
  | { type: 'openFolder'; forceNewWindow: boolean }
  | {
      type: 'terminalPermissionResult';
      id: string;
      decision: TerminalPermissionDecision;
    }
  | {
      type: 'userFeedbackResult';
      id: string;
      status: 'answered' | 'dismissed';
      selected: string[];
      freeText: string;
    }
  | { type: 'buildPlan'; markdown: string }
  | { type: 'viewPlan'; markdown: string };

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
      hasWorkspace: boolean;
      workspaceLabel: string;
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
  | {
      type: 'user';
      text: string;
      /** Live-turn image thumbs (not persisted in session history). */
      images?: Array<{ name: string; mime: string; dataBase64: string }>;
    }
  | { type: 'assistantStart' }
  | { type: 'assistantDelta'; text: string }
  | { type: 'assistantDone' }
  | { type: 'tool'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'planCard'; revision: string; markdown: string }
  | { type: 'planCardSync'; revision: string; markdown: string }
  | {
      type: 'terminalPermission';
      id: string;
      command: string;
      readonlyGit: boolean;
    }
  | {
      type: 'terminalPermissionSettled';
      id: string;
      decision: TerminalPermissionDecision;
    }
  | {
      type: 'userFeedback';
      id: string;
      message: string;
      options: string[];
      kind: UserFeedbackKind;
    }
  | {
      type: 'userFeedbackSettled';
      id: string;
      status: 'answered' | 'dismissed' | 'aborted';
      selected: string[];
      freeText: string;
    }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | {
      type: 'skills';
      skills: Array<{ id: string; name: string; description: string; source: string }>;
    }
  | {
      type: 'atMentions';
      items: Array<{
        kind: 'selection' | 'file' | 'folder';
        id: string;
        label: string;
        detail: string;
        path?: string;
      }>;
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
  private agentPanel?: vscode.WebviewPanel;
  private abort?: AbortController;
  private store: SessionStore;
  private streaming = false;
  readonly diffs: DiffReviewService;
  /** Fired when pending diff count changes (status bar). */
  onPendingDiffsChanged?: (count: number) => void;
  /** In-flight Chat permission cards waiting for Allow once / Always / Deny. */
  private terminalPermWaiters = new Map<string, (d: TerminalPermissionDecision) => void>();
  /** In-flight ask_user feedback cards. */
  private userFeedbackWaiters = new Map<string, (r: UserFeedbackResult) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = this.loadStore();
    this.diffs = new DiffReviewService();
    setTerminalPermissionAsker((req) => this.askTerminalPermissionInChat(req.command, req.readonlyGit));
    setUserFeedbackAsker((req) => this.askUserFeedbackInChat(req));
    this.context.subscriptions.push({
      dispose: () => {
        setTerminalPermissionAsker(undefined);
        setUserFeedbackAsker(undefined);
      },
    });
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
    // Plan View: keep chat card in sync when user saves `.su/plans/*.plan.md`.
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.onPlanFileSaved(doc);
      }),
    );
  }

  private askTerminalPermissionInChat(
    command: string,
    readonlyGit: boolean,
  ): Promise<TerminalPermissionDecision> {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const preview = command.length > 120 ? `${command.slice(0, 120)}…` : command;
    this.post({
      type: 'progress',
      text: `等待你授权终端命令：${preview}`,
    });
    // Ensure a Chat surface is visible — Agent Window if open, else side-bar Chat.
    void (async () => {
      try {
        if (this.agentPanel) {
          this.agentPanel.reveal(undefined, true);
        } else {
          await this.open({ mode: 'agent' });
        }
      } catch {
        // best-effort reveal
      }
    })();

    const PERM_WAIT_MS = 5 * 60_000;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: TerminalPermissionDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.terminalPermWaiters.delete(id);
        this.post({ type: 'terminalPermissionSettled', id, decision });
        resolve(decision);
      };

      const timer = setTimeout(() => {
        this.post({
          type: 'progress',
          text: '终端授权等待超时（5 分钟），已跳过该命令',
        });
        finish('deny');
      }, PERM_WAIT_MS);

      // Only the in-chat permission card (no parallel VS Code toast — redundant UX).
      this.terminalPermWaiters.set(id, finish);
      this.post({ type: 'terminalPermission', id, command, readonlyGit });
    });
  }

  private resolveTerminalPermission(id: string, decision: TerminalPermissionDecision): void {
    const waiter = this.terminalPermWaiters.get(id);
    if (!waiter) {
      return;
    }
    // Waiter is the finish() closer from askTerminalPermissionInChat (idempotent).
    waiter(decision);
  }

  private rejectPendingTerminalPermissions(): void {
    const ids = [...this.terminalPermWaiters.keys()];
    for (const id of ids) {
      const waiter = this.terminalPermWaiters.get(id);
      // Prefer finish() path; if somehow missing, drop the map entry.
      if (waiter) {
        waiter('deny');
      } else {
        this.terminalPermWaiters.delete(id);
      }
    }
  }

  private askUserFeedbackInChat(req: UserFeedbackRequest): Promise<UserFeedbackResult> {
    const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.post({ type: 'progress', text: '等待你的选择…' });
    const PERM_WAIT_MS = 5 * 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.userFeedbackWaiters.has(id)) {
          return;
        }
        this.userFeedbackWaiters.delete(id);
        const dismissed: UserFeedbackResult = { status: 'dismissed', selected: [], freeText: '' };
        this.post({
          type: 'userFeedbackSettled',
          id,
          status: 'dismissed',
          selected: [],
          freeText: '',
        });
        this.post({ type: 'progress', text: '选择等待超时（5 分钟），已按关闭处理' });
        resolve(dismissed);
      }, PERM_WAIT_MS);
      this.userFeedbackWaiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post({
        type: 'userFeedback',
        id,
        message: req.message,
        options: req.options,
        kind: req.kind,
      });
    });
  }

  private resolveUserFeedback(id: string, result: UserFeedbackResult): void {
    const waiter = this.userFeedbackWaiters.get(id);
    if (!waiter) {
      return;
    }
    this.userFeedbackWaiters.delete(id);
    waiter(result);
    this.post({
      type: 'userFeedbackSettled',
      id,
      status: result.status,
      selected: result.selected,
      freeText: result.freeText,
    });
  }

  private rejectPendingUserFeedback(): void {
    const ids = [...this.userFeedbackWaiters.keys()];
    for (const id of ids) {
      const waiter = this.userFeedbackWaiters.get(id);
      this.userFeedbackWaiters.delete(id);
      // Stop/Esc/session change — not a deliberate "close suggestion" dismiss.
      const aborted: UserFeedbackResult = { status: 'aborted', selected: [], freeText: '' };
      waiter?.(aborted);
      this.post({
        type: 'userFeedbackSettled',
        id,
        status: 'aborted',
        selected: [],
        freeText: '',
      });
    }
  }

  private rejectPendingAgentPrompts(): void {
    this.rejectPendingTerminalPermissions();
    this.rejectPendingUserFeedback();
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
    this.rejectPendingAgentPrompts();
    this.abort?.abort();
  }

  /** Pushes status (and pending-diff badge) to webview / status bar. */
  async refreshStatus(): Promise<void> {
    await this.pushStatus();
  }

  /**
   * Attaches workspace resources to the Chat composer (explorer / editor context menu).
   * Used when HTML5 drag from the workbench into the webview is blocked without Shift.
   */
  async attachResources(uris: readonly vscode.Uri[]): Promise<void> {
    const list = uris.filter((u) => u && (u.scheme === 'file' || u.fsPath));
    if (!list.length) {
      void vscode.window.showWarningMessage('没有可添加的文件/文件夹。');
      return;
    }
    if (!this.agentPanel) {
      await this.open();
    }
    this.post({
      type: 'dropResolved',
      items: await resolveDroppedUris(list.map((u) => u.fsPath || u.toString())),
    });
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
    webviewView.webview.html = this.getHtml(webviewView.webview, 'ide');

    webviewView.webview.onDidReceiveMessage((raw: WebviewToExt) => {
      void this.onWebviewMessage(raw);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.pushStatus();
      }
    });
  }

  /** True after Agent Window was moved into a separate OS window (auxiliary window). */
  private agentPanelDetached = false;

  /**
   * Opens Su Agent Window as a standalone OS window (ChatGPT/DeepSeek-app style),
   * not an editor tab inside the IDE. Shares sessions with the IDE side chat.
   */
  async openAgentWindow(): Promise<void> {
    if (this.agentPanel) {
      this.agentPanel.reveal(this.agentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
      if (!this.agentPanelDetached) {
        await this.detachAgentPanelToNewWindow();
      }
      await this.pushStatus();
      this.pushRestore();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'su.agentWindow',
      'Su Agent Window',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
    );
    this.agentPanel = panel;
    this.agentPanelDetached = false;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'su.svg');
    panel.webview.html = this.getHtml(panel.webview, 'agent');
    panel.webview.onDidReceiveMessage((raw: WebviewToExt) => {
      void this.onWebviewMessage(raw);
    });
    panel.onDidDispose(() => {
      this.agentPanel = undefined;
      this.agentPanelDetached = false;
    });
    this.context.subscriptions.push(panel);
    await this.pushStatus();
    this.pushRestore();
    // Webview must be the active editor before moveEditorToNewWindow can detach it.
    await this.detachAgentPanelToNewWindow();
  }

  /**
   * Moves the Agent WebviewPanel into a new OS-level window (VS Code auxiliary window).
   */
  private async detachAgentPanelToNewWindow(): Promise<void> {
    if (!this.agentPanel) {
      return;
    }
    this.agentPanel.reveal(this.agentPanel.viewColumn ?? vscode.ViewColumn.Active, false);
    // Let the workbench activate the webview editor before the move command runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      this.agentPanelDetached = true;
    } catch (e) {
      console.warn('[su-ai] moveEditorToNewWindow failed; Agent stays in IDE editor area', e);
      void vscode.window.showWarningMessage(
        '无法拆到独立窗口（将留在 IDE 编辑器内）。可手动：右键标签 → Move into New Window。',
      );
    }
  }

  /**
   * Returns to classic IDE layout: focus auxiliary Su Chat and close the standalone Agent Window.
   */
  async openIdeWindow(opts?: { closeAgentPanel?: boolean }): Promise<void> {
    if (opts?.closeAgentPanel !== false && this.agentPanel) {
      this.agentPanel.dispose();
      this.agentPanel = undefined;
      this.agentPanelDetached = false;
    }
    await this.open();
  }

  /** Shared message handler for IDE side-bar and Agent Window webviews. */
  private async onWebviewMessage(raw: WebviewToExt): Promise<void> {
    switch (raw.type) {
      case 'ready':
        await this.pushStatus();
        this.pushRestore();
        break;
      case 'send':
        await this.handleSend(
          raw.text,
          raw.includeSelection,
          normalizeMode(raw.mode),
          raw.modelPick,
          raw.attachments,
        );
        break;
      case 'buildPlan':
        await this.buildPlan(raw.markdown);
        break;
      case 'viewPlan':
        await this.viewPlan(raw.markdown);
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
      case 'listAtMentions':
        this.post({
          type: 'atMentions',
          items: await listAtMentionItems(raw.filter),
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
      case 'attachActiveFile': {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || doc.isUntitled || doc.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage('当前没有可引用的已保存文件。');
          break;
        }
        await this.attachResources([doc.uri]);
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
        await this.setMode(normalizeMode(raw.mode));
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
      case 'openAgentWindow':
        await this.openAgentWindow();
        break;
      case 'openIdeWindow':
        await this.openIdeWindow();
        break;
      case 'openFolder':
        await this.openWorkspaceFolder(raw.forceNewWindow !== false);
        break;
      case 'terminalPermissionResult':
        this.resolveTerminalPermission(raw.id, raw.decision);
        break;
      case 'userFeedbackResult':
        this.resolveUserFeedback(raw.id, {
          status: raw.status === 'answered' ? 'answered' : 'dismissed',
          selected: Array.isArray(raw.selected) ? raw.selected.map(String) : [],
          freeText: String(raw.freeText ?? ''),
        });
        break;
      default:
        break;
    }
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
    return normalizeMode(m);
  }

  private async setMode(mode: ChatMode): Promise<void> {
    const next = normalizeMode(mode);
    await this.context.workspaceState.update(MODE_KEY, next);
    const s = this.activeSession;
    s.mode = next;
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
    this.rejectPendingAgentPrompts();
    this.abort?.abort();
    this.abort = undefined;
    resetTerminalSessionPermissions();
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
    this.rejectPendingAgentPrompts();
    this.abort?.abort();
    this.abort = undefined;
    resetTerminalSessionPermissions();
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
    this.rejectPendingAgentPrompts();
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
    if (wasActive) {
      resetTerminalSessionPermissions();
    }
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
        .map((m) => ({
          role: m.role,
          // Hide raw <su-plan> tags in restored thread; plan card is posted separately.
          content: m.role === 'assistant' ? stripPlanTags(m.content) : m.content,
        })),
    });
    if (s.planDraft?.markdown) {
      this.post({
        type: 'planCard',
        revision: s.planDraft.revision,
        markdown: s.planDraft.markdown,
      });
    }
  }

  private async pushStatus(): Promise<void> {
    const cfg = await resolveSuRuntimeConfig(this.context);
    const modelPick = this.getModelPick();
    const activeModel = resolveActiveModel(modelPick, cfg);
    const s = this.activeSession;
    const folders = vscode.workspace.workspaceFolders || [];
    const workspaceLabel = folders.length
      ? folders.map((f) => f.name).join(', ')
      : '（未打开文件夹）';
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
      hasWorkspace: folders.length > 0,
      workspaceLabel,
    });
  }

  /**
   * Pick a folder and open it in a new OS window or replace the current window workspace.
   * Agent Window shares the IDE workspace; a different project needs a new window (or replace).
   */
  async openWorkspaceFolder(forceNewWindow: boolean): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: forceNewWindow ? '在新窗口打开' : '打开（替换当前项目）',
      title: forceNewWindow
        ? '选择项目文件夹 — 将在新的 su 窗口打开'
        : '选择项目文件夹 — 将替换当前窗口工作区',
    });
    const folder = uris?.[0];
    if (!folder) {
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', folder, forceNewWindow);
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
    // Do not stack turns: aborting mid-flight left the UI on「生成中」with no progress.
    if (this.streaming || this.abort) {
      void vscode.window.showWarningMessage('当前正在生成，请先点「停止」或按 Esc，再发送新任务。');
      return;
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
    const rulesFrag = await loadWorkspaceRulesFragment();
    const systemExtras = [
      workspaceCtx,
      ...(rulesFrag ? [rulesFrag] : []),
      ...turn.systemExtras,
    ];
    const next = [...this.history, { role: 'user' as const, content: turn.historyText }];
    this.history = next;
    await this.saveHistory();
    const previewImages = (attachments || [])
      .filter((a): a is Extract<ChatAttachment, { kind: 'image' }> => a.kind === 'image')
      .map((a) => ({ name: a.name, mime: a.mime, dataBase64: a.dataBase64 }));
    this.post({
      type: 'user',
      text: turn.historyText,
      images: previewImages.length ? previewImages : undefined,
    });
    this.post({ type: 'assistantStart' });
    await this.setStreaming(true);

    const cfg = await resolveSuRuntimeConfig(this.context);
    const activeModel = resolveActiveModel(this.getModelPick(), cfg);
    this.abort = new AbortController();
    // Agent/Plan: long per-round wait. Ask: shorter; bump for images/context.
    const timeoutMs =
      mode === 'agent' || mode === 'plan'
        ? cfg.agentTimeoutMs
        : Math.max(
            cfg.timeoutMs,
            Array.isArray(turn.apiContent) || systemExtras.length > 0 ? 120_000 : cfg.timeoutMs,
          );
    this.post({
      type: 'progress',
      text: `正在调用 ${activeModel}（本轮最长 ${Math.round(timeoutMs / 1000)}s）…`,
    });

    if (mode === 'agent') {
      await this.runAgentTurn(turn.apiContent, systemExtras, {
        ...cfg,
        model: activeModel,
        timeoutMs,
      });
      return;
    }

    if (mode === 'plan') {
      await this.runPlanTurn(turn.apiContent, systemExtras, {
        ...cfg,
        model: activeModel,
        timeoutMs,
      });
      return;
    }

    await this.runAskTurn(turn.apiContent, systemExtras, {
      ...cfg,
      model: activeModel,
      timeoutMs,
    });
  }

  /**
   * View: write/update `.su/plans/*.plan.md` and open it in the editor (Cursor-like).
   */
  private async viewPlan(markdown: string): Promise<void> {
    const body = validatePlanMarkdown(markdown);
    if (!body) {
      void vscode.window.showWarningMessage('计划内容为空或过长，无法打开。');
      return;
    }
    const s = this.activeSession;
    const revision = s.planDraft?.revision || `rev_${Date.now()}`;
    try {
      const { uri, relativePath } = await writePlanFile({
        markdown: body,
        revision,
        existingRelativePath: s.planDraft?.relativePath,
      });
      s.planDraft = { revision, markdown: body, relativePath };
      s.updatedAt = Date.now();
      await this.persistStore();
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      this.post({ type: 'progress', text: `已在编辑器打开计划：${relativePath}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void vscode.window.showWarningMessage(message);
    }
  }

  /**
   * Sync chat plan card when a tracked plan file is saved in the editor.
   */
  private async onPlanFileSaved(doc: vscode.TextDocument): Promise<void> {
    if (!isSuPlanFileUri(doc.uri)) {
      return;
    }
    const s = this.activeSession;
    const tracked = s.planDraft?.relativePath
      ? planUriFromRelative(s.planDraft.relativePath)
      : undefined;
    if (!tracked || tracked.toString() !== doc.uri.toString()) {
      return;
    }
    const body = validatePlanMarkdown(doc.getText());
    if (!body) {
      return;
    }
    s.planDraft = {
      revision: s.planDraft?.revision || `rev_${Date.now()}`,
      markdown: body,
      relativePath: s.planDraft?.relativePath,
    };
    s.updatedAt = Date.now();
    await this.persistStore();
    this.post({
      type: 'planCardSync',
      revision: s.planDraft.revision,
      markdown: body,
    });
  }

  /**
   * Build: switch to Agent and execute the current plan markdown.
   */
  private async buildPlan(markdown: string): Promise<void> {
    const s = this.activeSession;
    // Prefer open editor buffer / disk for the Viewed plan file so unsaved edits still apply when possible.
    const fromFile = await readPlanMarkdown(s.planDraft?.relativePath, markdown);
    const body = validatePlanMarkdown(fromFile) || validatePlanMarkdown(markdown);
    if (!body) {
      void vscode.window.showWarningMessage('计划内容为空或过长，无法 Build。');
      return;
    }
    if (this.streaming || this.abort) {
      void vscode.window.showWarningMessage('当前正在生成，请先停止后再 Build。');
      return;
    }
    const planProgress = getPlanProgress(body);
    this.post({ type: 'progress', text: `计划已 Build：${planProgress.completed}/${planProgress.total || '未知'} 项已标记完成${planProgress.next ? ` · 下一项 ${planProgress.next.id}` : ''}` });
    s.planDraft = {
      revision: `rev_${Date.now()}`,
      markdown: body,
      ...(s.planDraft?.relativePath ? { relativePath: s.planDraft.relativePath } : {}),
    };
    s.updatedAt = Date.now();
    await this.persistStore();
    this.post({ type: 'planCardSync', revision: s.planDraft.revision, markdown: body });
    await this.setMode('agent');
    const prompt =
      '请严格按照以下计划执行（不要重新大幅改规划，除非发现问题）。' +
      '在本轮内用工具连续完成所有步骤与验收项，不要中途停下来等我说「继续」或等 Keep/Reject。' +
      '全部完成后明确说明「计划已完成」并简要总结。\n\n' +
      `<su-plan>\n${body}\n</su-plan>`;
    await this.handleSend(prompt, false, 'agent');
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
          if (ev.type === 'progress') {
            this.post({ type: 'progress', text: ev.text });
          } else if (ev.type === 'tool') {
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

  private async runPlanTurn(
    userContent: import('../openaiClient').ChatMessage['content'],
    systemExtras: string[],
    cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
  ): Promise<void> {
    let assistant = '';
    try {
      await runPlanWithTools({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        userContent: userContent ?? '',
        systemExtras,
        history: this.history.slice(0, -1),
        signal: this.abort?.signal,
        onEvent: (ev) => {
          if (ev.type === 'progress') {
            this.post({ type: 'progress', text: ev.text });
          } else if (ev.type === 'tool') {
            this.post({ type: 'tool', text: ev.detail });
          } else if (ev.type === 'assistant') {
            assistant = ev.text;
            const draft = parsePlanResponse(ev.text);
            if (draft) {
              const intro = ev.text.replace(/<su-plan>[\s\S]*?<\/su-plan>/m, '').trim();
              if (intro) {
                this.post({ type: 'assistantDelta', text: intro });
              }
            } else {
              this.post({ type: 'assistantDelta', text: ev.text });
            }
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
        const draft = parsePlanResponse(assistant);
        if (draft) {
          const s = this.activeSession;
          s.planDraft = draft;
          s.updatedAt = Date.now();
          await this.persistStore();
          this.post({ type: 'planCard', revision: draft.revision, markdown: draft.markdown });
        }
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
    const contentText =
      typeof userContent === 'string'
        ? userContent
        : Array.isArray(userContent)
          ? userContent
              .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: string }).text || '') : ''))
              .join('\n')
          : '';
    // Build injects <su-plan>; "继续" after a plan draft also keeps auto-nudge on.
    const continueUntilDone =
      /<su-plan>[\s\S]*?<\/su-plan>/i.test(contentText) ||
      /连续完成所有步骤|不要中途停下来等我说「继续」/.test(contentText) ||
      (!!this.activeSession.planDraft && /^(继续|continue)\b/i.test(contentText.trim()));
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
        continueUntilDone,
        onEvent: (ev) => {
          if (ev.type === 'progress') {
            this.post({ type: 'progress', text: ev.text });
          } else if (ev.type === 'tool') {
            this.post({ type: 'tool', text: ev.detail });
            this.emitDiffsChanged();
          } else if (ev.type === 'assistant') {
            assistant = assistant ? `${assistant}\n${ev.text}` : ev.text;
            this.post({ type: 'assistantDelta', text: ev.text });
          } else if (ev.type === 'done') {
            this.activeSession.agentState = { phase: ev.progress?.phase || (ev.reason === 'completed' ? 'completed' : 'paused'), reason: ev.reason, summary: ev.summary, updatedAt: Date.now(), toolSteps: ev.progress?.toolSteps };
            void this.persistStore();
            if (!assistant) {
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
        const tip = `\n\n— 待审 ${this.diffs.size} 个文件：可用消息旁 Keep / Reject（不阻断 Agent；可边审边看后续结果）。`;
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
      this.rejectPendingAgentPrompts();
      this.abort = undefined;
      await this.setStreaming(false);
      this.emitDiffsChanged();
      await this.pushStatus();
    }
  }

  private post(msg: ExtToWebview): void {
    void this.view?.webview.postMessage(msg);
    void this.agentPanel?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview, surface: 'ide' | 'agent' = 'ide'): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // unsafe-eval: replyMarkdown is injected via new Function (shared host/webview renderer).
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
      // data: needed for dragged image thumbnails in the composer
      `img-src ${webview.cspSource} data: blob:`,
    ].join('; ');
    const switchBtn =
      surface === 'agent'
        ? `<button type="button" class="icon-btn" id="btnIdeWindow" title="回到 IDE Window">IDE ↗</button>`
        : `<button type="button" class="icon-btn" id="btnAgentWindow" title="在独立窗口打开 Agent Window">Agent ↗</button>`;
    // Inject shared reply renderer (tables/headings) into the webview without a second copy.
    // JSON.stringify keeps backticks / ${} in the function source from breaking this template.
    const mdRendererJson = JSON.stringify(renderReplyMarkdown.toString());

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${surface === 'agent' ? 'Su Agent Window' : 'Su Chat'}</title>
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
    .msg .body.md h1, .msg .body.md h2, .msg .body.md h3 {
      margin: 0.95em 0 0.4em; line-height: 1.3; font-weight: 700; letter-spacing: .01em; color: var(--fg);
    }
    .msg .body.md h1 { font-size: 1.35em; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
    .msg .body.md h2 { font-size: 1.2em; padding-bottom: 3px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
    .msg .body.md h3 { font-size: 1.06em; }
    .msg .body.md h1:first-child, .msg .body.md h2:first-child, .msg .body.md h3:first-child { margin-top: 0.15em; }
    .msg .body.md strong { font-weight: 700; color: var(--fg); }
    .msg .body.md .reply-table {
      margin: 0.7em 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;
    }
    .msg .body.md table { width: 100%; min-width: 240px; margin: 0; border-collapse: collapse; font-size: 12.5px; line-height: 1.45; }
    .msg .body.md th, .msg .body.md td { padding: 7px 10px; text-align: left; vertical-align: top; border: 1px solid var(--border); }
    .msg .body.md th { background: color-mix(in srgb, var(--btn-bg) 16%, var(--code-bg)); font-weight: 700; }
    .msg .body.md tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--code-bg) 45%, transparent); }
    .msg .body.md .align-center { text-align: center; }
    .msg .body.md .align-right { text-align: right; }
    .msg .body.md hr { border: 0; border-top: 1px solid var(--border); margin: 1em 0; }
    .msg .body.md p { margin: 0.45em 0; line-height: 1.55; }
    .msg .body.md ul, .msg .body.md ol { margin: 0.4em 0; padding-left: 1.35em; line-height: 1.5; }
    .msg .body.md li { margin: 0.18em 0; }
    .msg .body.md code { font-family: var(--mono); font-size: 12px; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
    .msg .body.md .reply-code {
      margin: 0.55em 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--code-bg);
    }
    .msg .body.md .reply-code .code-actions {
      display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap;
      margin: 0; padding: 4px 8px; border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--input-bg) 70%, transparent);
    }
    .msg .body.md .reply-code .code-actions span {
      margin-right: auto; font-size: 11px; color: var(--muted); font-family: var(--mono);
    }
    .msg .body.md pre {
      margin: 0.5em 0; padding: 8px; overflow: auto; background: var(--code-bg);
      border-radius: 6px; border: 1px solid var(--border); position: relative;
    }
    .msg .body.md .reply-code pre { margin: 0; border: none; border-radius: 0; }
    .msg .body.md pre code { padding: 0; background: transparent; }
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
      padding: 8px 10px; font-size: 12px; color: var(--fg);
      display: flex; flex-direction: column; align-items: stretch; gap: 2px;
    }
    .tool-fold > summary::-webkit-details-marker { display: none; }
    .tool-fold-summary-main {
      display: flex; align-items: center; gap: 6px; color: var(--fg); font-weight: 600;
    }
    .tool-fold-summary-main::before {
      content: '▸'; color: var(--muted); font-size: 10px; transition: transform .12s ease;
    }
    .tool-fold[open] > summary .tool-fold-summary-main::before { transform: rotate(90deg); }
    .tool-fold > summary:hover { background: var(--list-hover); }
    .tool-fold-live {
      font-size: 11px; color: var(--muted); font-weight: 400; padding-left: 16px;
    }
    .tool-fold-live.busy { color: var(--link); }
    .tool-fold-body {
      border-top: 1px solid var(--border); max-height: 320px; overflow: auto;
      padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 8px;
    }
    .tool-step {
      border: 1px solid var(--border); border-radius: 6px; background: var(--code-bg); overflow: hidden;
    }
    .tool-step[data-pending="1"] { border-color: color-mix(in srgb, var(--link) 45%, var(--border)); }
    .tool-step-label {
      font-size: 11px; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tool-step pre {
      margin: 0; padding: 6px 8px; font: 11px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word;
      max-height: 160px; overflow: auto; color: var(--fg);
    }
    .perm-card {
      align-self: stretch; border: 1px solid color-mix(in srgb, var(--link) 40%, var(--border));
      border-radius: 10px; padding: 10px 12px; background: color-mix(in srgb, var(--btn-bg) 14%, var(--bg));
      display: flex; flex-direction: column; gap: 8px;
    }
    .perm-card .perm-title { font-size: 12px; font-weight: 650; color: var(--fg); }
    .perm-card .perm-cmd {
      margin: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--code-bg); font: 11px/1.45 var(--mono); white-space: pre-wrap; word-break: break-word;
      max-height: 140px; overflow: auto; color: var(--fg);
    }
    .perm-card .perm-hint { font-size: 11px; color: var(--muted); }
    .perm-card .perm-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .perm-card .perm-actions button {
      font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
    }
    .perm-card .perm-actions button.primary {
      background: var(--btn-bg); color: var(--btn-fg); border-color: transparent;
    }
    .perm-card.done { opacity: 0.85; }
    .perm-card.done .perm-actions { display: none; }
    .fb-card {
      align-self: stretch; border: 1px solid color-mix(in srgb, var(--link) 35%, var(--border));
      border-radius: 10px; padding: 12px 12px 10px;
      background: color-mix(in srgb, var(--input-bg) 88%, var(--bg));
      display: flex; flex-direction: column; gap: 10px;
    }
    .fb-card .fb-eyebrow { font-size: 11px; color: var(--muted); letter-spacing: 0.02em; }
    .fb-card .fb-message { font-size: 13px; color: var(--fg); white-space: pre-wrap; line-height: 1.45; }
    .fb-card .fb-options { display: flex; flex-direction: column; gap: 4px; }
    .fb-card .fb-opt {
      display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 6px;
      border: 1px solid transparent; cursor: pointer; font-size: 12px; color: var(--fg);
    }
    .fb-card .fb-opt:hover { background: var(--list-hover); }
    .fb-card .fb-opt.selected {
      border-color: color-mix(in srgb, var(--link) 50%, var(--border));
      background: color-mix(in srgb, var(--btn-bg) 16%, transparent);
    }
    .fb-card .fb-opt input { margin-top: 2px; }
    .fb-card .fb-free {
      width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box;
      padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--code-bg); color: var(--fg); font: 12px/1.45 var(--font);
    }
    .fb-card .fb-hint { font-size: 11px; color: var(--muted); }
    .fb-card .fb-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .fb-card .fb-actions button {
      font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
    }
    .fb-card .fb-actions button.primary {
      background: var(--btn-bg); color: var(--btn-fg); border-color: transparent;
    }
    .fb-card.done { opacity: 0.88; }
    .fb-card.done .fb-actions, .fb-card.done .fb-options, .fb-card.done .fb-free { display: none; }
    .plan-card {
      align-self: stretch; border: 1px solid color-mix(in srgb, var(--link) 40%, var(--border));
      border-radius: 10px; padding: 12px; background: color-mix(in srgb, var(--input-bg) 90%, var(--bg));
      display: flex; flex-direction: column; gap: 8px;
    }
    .plan-card .plan-title { font-size: 12px; font-weight: 650; color: var(--fg); }
    .plan-card .plan-hint { font-size: 11px; color: var(--muted); }
    .plan-card textarea.plan-body {
      width: 100%; min-height: 180px; max-height: 420px; resize: vertical; box-sizing: border-box;
      padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--code-bg); color: var(--fg); font: 12px/1.45 var(--mono);
    }
    .plan-card .plan-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .plan-card .plan-actions button {
      font-size: 12px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
    }
    .plan-card .plan-actions button.primary {
      background: var(--btn-bg); color: var(--btn-fg); border-color: transparent; font-weight: 600;
    }
    .plan-card.built { opacity: 0.85; }
    .plan-card.built .plan-actions { display: none; }
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
    .live-progress {
      display: none; align-items: center; gap: 8px; margin: 0 10px 8px; padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--link) 40%, var(--border)); border-radius: 8px;
      background: color-mix(in srgb, var(--btn-bg) 14%, var(--bg)); color: var(--link);
      font-size: 12px; line-height: 1.4; flex-shrink: 0;
    }
    .live-progress.on { display: flex; }
    .live-progress .lp-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--link); flex-shrink: 0;
      animation: lp-pulse 1s ease-in-out infinite;
    }
    @keyframes lp-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
    .composer {
      position: relative; border: 1px solid var(--border); border-radius: 8px;
      background: var(--input-bg); padding: 6px; display: flex; flex-direction: column; gap: 6px;
    }
    .composer.dragover { border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
    .composer.dragover-vscode { border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
    .drop-hint {
      display: none; position: absolute; inset: 0; z-index: 5;
      align-items: center; justify-content: center; text-align: center;
      padding: 12px; border-radius: 8px; pointer-events: none;
      background: color-mix(in srgb, var(--btn-bg) 22%, var(--input-bg));
      color: var(--fg); font-size: 12px; line-height: 1.45;
    }
    .composer.dragover .drop-hint, .composer.dragover-vscode .drop-hint { display: flex; }
    .composer.dragover-vscode { border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
    .drop-hint {
      display: none; position: absolute; inset: 0; z-index: 5;
      align-items: center; justify-content: center; text-align: center;
      padding: 12px; border-radius: 8px; pointer-events: none;
      background: color-mix(in srgb, var(--btn-bg) 22%, var(--input-bg));
      color: var(--fg); font-size: 12px; line-height: 1.45;
    }
    .composer.dragover .drop-hint, .composer.dragover-vscode .drop-hint { display: flex; }
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
      background: var(--code-bg); cursor: zoom-in;
    }
    .msg-images {
      display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;
    }
    .msg-images img.msg-thumb, .msg .body.md img.md-img {
      max-width: 160px; max-height: 120px; object-fit: cover; border-radius: 8px;
      border: 1px solid var(--border); cursor: zoom-in; background: var(--code-bg);
      display: block;
    }
    .msg .body.md img.md-img { margin: 0.4em 0; }
    .img-lightbox {
      display: none; position: fixed; inset: 0; z-index: 1000;
      align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(2px);
      padding: 16px; box-sizing: border-box;
    }
    .img-lightbox.open { display: flex; }
    .img-lightbox img {
      max-width: min(92vw, 100%); max-height: 88vh; object-fit: contain;
      border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
      cursor: zoom-out; background: #111;
    }
    .img-lightbox-close {
      position: absolute; top: 10px; right: 12px; width: 32px; height: 32px;
      border: 1px solid color-mix(in srgb, #fff 35%, transparent);
      border-radius: 8px; background: rgba(0,0,0,.45); color: #fff;
      font-size: 20px; line-height: 1; cursor: pointer;
    }
    .img-lightbox-close:hover { background: rgba(0,0,0,.7); }
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
      <div class="title" id="sessionTitle">${surface === 'agent' ? 'Su Agent Window' : 'Su Chat'}</div>
      ${switchBtn}
      <button type="button" class="icon-btn" id="btnDiff" title="审阅 Diff">⇄<span class="badge hidden" id="diffBadge">0</span></button>
      <button type="button" class="icon-btn" id="btnNew" title="新对话">+</button>
      <button type="button" class="icon-btn" id="btnHistory" title="历史记录">◷</button>
      <div class="menu-wrap">
        <button type="button" class="icon-btn" id="btnMore" title="更多">⋯</button>
        <div class="menu-pop" id="moreMenu">
          <button type="button" id="mOpenFolderNew">打开文件夹（新窗口）</button>
          <button type="button" id="mOpenFolderHere">打开文件夹（当前窗口）</button>
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
  <div class="live-progress" id="liveProgress" aria-live="polite">
    <span class="lp-dot" aria-hidden="true"></span>
    <span id="liveProgressText">正在思考 / 等待模型…</span>
  </div>
  <div class="diff-bar" id="diffBar">
    <span class="label" id="diffLabel">待审 0 个文件</span>
    <button type="button" class="secondary" id="btnKeepAll">Keep All</button>
    <button type="button" class="secondary" id="btnRejectAll">Reject All</button>
    <button type="button" class="secondary" id="btnReviewBar">审阅</button>
  </div>
  <footer>
    <div class="composer" id="composer">
      <div class="drop-hint" id="dropHint">松开以添加引用<br/>若从左侧资源管理器/标签拖入无效，请按住 <strong>Shift</strong> 再松手<br/>或右键「添加到 Su Chat」</div>
      <div class="attach-row" id="attachRow"></div>
      <div class="slash-menu" id="slashMenu"></div>
      <textarea id="input" placeholder="问 Su… 拖文件；/ Skills；@ 引用；Enter 发送"></textarea>
    </div>
    <div class="row">
      <div class="pills" title="Ask=问答；Plan=定计划；Agent=执行改文件">
        <button type="button" id="pillAsk" class="active">Ask</button>
        <button type="button" id="pillPlan">Plan</button>
        <button type="button" id="pillAgent">Agent</button>
      </div>
      <select id="modelPick" aria-label="选择模型"><option value="auto">Auto</option></select>
      <button type="button" class="secondary" id="btnAttach" title="添加文件/文件夹">📎</button>
      <button type="button" class="secondary" id="btnActiveFile" title="引用当前编辑器文件">当前文件</button>
      <span class="chip" id="selChip" title="发送时附带当前选区">选区</span>
      <span class="streaming-hint" id="streamHint">生成中 · Esc 停止</span>
      <span style="flex:1"></span>
      <button type="button" class="secondary" id="btnStop" disabled>停止</button>
      <button type="button" class="action" id="btnSend">发送</button>
    </div>
    <div class="hint">拖入 / Shift 侧栏拖 / 右键添加 · 📎 当前文件 · / Skills · @ 引用 · Rules:.su/rules</div>
  </footer>
  <div id="historyPanel" aria-hidden="true">
    <div class="hp-head">
      <span style="flex:1">历史对话</span>
      <button type="button" class="secondary" id="btnCloseHistory">关闭</button>
    </div>
    <div class="hp-list" id="historyList"></div>
  </div>
  <div id="imgLightbox" class="img-lightbox" aria-hidden="true" title="点击空白或按 Esc 关闭">
    <button type="button" class="img-lightbox-close" id="imgLightboxClose" aria-label="关闭">×</button>
    <img id="imgLightboxImg" alt="" />
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const input = document.getElementById('input');
    const meta = document.getElementById('meta');
    const sessionTitle = document.getElementById('sessionTitle');
    const modelPick = document.getElementById('modelPick');
    const liveProgress = document.getElementById('liveProgress');
    const liveProgressText = document.getElementById('liveProgressText');
    const pillAsk = document.getElementById('pillAsk');
    const pillPlan = document.getElementById('pillPlan');
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
    let atCache = [];
    let slashIndex = 0;
    /** 'slash' | 'at' | '' */
    let menuKind = '';

    function setMode(m) {
      mode = m === 'agent' ? 'agent' : m === 'plan' ? 'plan' : 'chat';
      pillAsk.classList.toggle('active', mode === 'chat');
      if (pillPlan) pillPlan.classList.toggle('active', mode === 'plan');
      pillAgent.classList.toggle('active', mode === 'agent');
      input.placeholder = mode === 'agent'
        ? '给 Agent 下任务… 拖文件；/ Skill；@ 引用；写后 Keep/Reject'
        : mode === 'plan'
          ? '描述需求，一起定计划… Build 后交给 Agent 执行'
          : '问 Su… 拖文件；/ Skill；@ 引用；Enter 发送';
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
          img.className = 'zoomable';
          img.alt = a.name || 'image';
          img.title = '点击放大';
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

    function looksLikeWorkbenchDrag(dt) {
      const types = dt.types ? Array.from(dt.types).map(String) : [];
      const joined = types.join('|').toLowerCase();
      return (
        joined.indexOf('uri-list') >= 0 ||
        joined.indexOf('resourceurls') >= 0 ||
        joined.indexOf('vnd.code') >= 0 ||
        joined.indexOf('codeeditors') >= 0 ||
        joined.indexOf('codefiles') >= 0
      );
    }

    async function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      composer.classList.remove('dragover');
      composer.classList.remove('dragover-vscode');
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
      if (!added) {
        // Workbench blocks webview pointer-events unless Shift is held (upstream design).
        metaFlash(
          looksLikeWorkbenchDrag(dt) || !files.length
            ? '侧栏/标签拖入需按住 Shift 再松手；或右键「添加到 Su Chat」/点「当前文件」'
            : '未识别到可引用路径，请用 📎 或右键「添加到 Su Chat」',
        );
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
      menuKind = '';
    }

    function openSlash(filterText) {
      menuKind = 'slash';
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

    function openAtMenu(items) {
      menuKind = 'at';
      slashMenu.innerHTML = '';
      if (!items || !items.length) {
        slashMenu.innerHTML = '<div class="sec">无匹配引用</div>';
        slashMenu.classList.add('open');
        return;
      }
      const sec = document.createElement('div');
      sec.className = 'sec';
      sec.textContent = '@ 上下文';
      slashMenu.appendChild(sec);
      items.forEach((it, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slash-item' + (i === 0 ? ' active' : '');
        btn.dataset.index = String(i);
        btn.innerHTML = '<div>@' + escapeHtml(it.label) + '</div><div class="desc"></div>';
        btn.querySelector('.desc').textContent = it.detail || it.kind;
        btn.addEventListener('click', () => pickAt(it));
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

    function pickAt(it) {
      if (it.kind === 'selection') {
        includeSel = true;
        selChip.classList.add('on');
      } else if (it.kind === 'folder' && it.path) {
        addAttachment({ kind: 'folder', path: it.path });
      } else if (it.path) {
        addAttachment({ kind: 'file', path: it.path });
      }
      const v = input.value;
      input.value = v.replace(/(^|\\s)@[^\\s]*$/, '$1').replace(/\\s+$/, ' ');
      closeSlash();
      input.focus();
    }

    function maybeSlash() {
      const v = input.value;
      const at = v.match(/(?:^|\\s)@([^\\s]*)$/);
      if (at) {
        vscode.postMessage({ type: 'listAtMentions', filter: at[1] || '' });
        return;
      }
      const m = v.match(/(?:^|\\s)\\/([^\\s]*)$/);
      if (!m) { closeSlash(); return; }
      const filter = m[1] || '';
      if (!skillsCache.length) {
        vscode.postMessage({ type: 'listSkills' });
      }
      openSlash(filter);
    }
    pillAsk.addEventListener('click', () => { setMode('chat'); vscode.postMessage({ type: 'setMode', mode: 'chat' }); });
    if (pillPlan) {
      pillPlan.addEventListener('click', () => { setMode('plan'); vscode.postMessage({ type: 'setMode', mode: 'plan' }); });
    }
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

    // CSP must allow unsafe-eval for this inject; wrap so a failure never bricks the whole Chat UI.
    let __suRenderReplyMarkdown = null;
    try {
      __suRenderReplyMarkdown = new Function('return (' + ${mdRendererJson} + ')')();
    } catch (err) {
      console.warn('[su-chat] replyMarkdown inject failed', err);
    }
    function renderMarkdown(src) {
      try {
        if (typeof __suRenderReplyMarkdown === 'function') {
          return __suRenderReplyMarkdown(src || '');
        }
      } catch (err) { /* fall through */ }
      return '<p>' + escapeHtml(String(src || '')) + '</p>';
    }

    function wireCodeActions(root) {
      root.querySelectorAll('.reply-code').forEach((block) => {
        const codeEl = block.querySelector('pre code');
        const text = codeEl ? (codeEl.textContent || '') : '';
        const copyBtn = block.querySelector('[data-copy]');
        const applyBtn = block.querySelector('[data-apply]');
        if (copyBtn) {
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(text).catch(() => {});
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
          });
        }
        if (applyBtn) {
          applyBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'applyCode', code: text });
          });
        }
      });
    }

    function setLiveProgress(text, on) {
      if (!liveProgress || !liveProgressText) return;
      if (typeof on === 'boolean') liveProgress.classList.toggle('on', on);
      if (text) liveProgressText.textContent = text;
    }

    function setStreaming(on) {
      streaming = on;
      btnSend.disabled = on;
      btnStop.disabled = !on;
      streamHint.classList.toggle('on', on);
      pillAsk.disabled = on;
      if (pillPlan) pillPlan.disabled = on;
      pillAgent.disabled = on;
      if (on) setLiveProgress('正在思考 / 等待模型…', true);
      else setLiveProgress('', false);
    }

    function showPlanCard(msg) {
      clearEmpty();
      messageCount++;
      setLiveProgress('计划已就绪 — 可编辑后点 Build', false);
      const card = document.createElement('div');
      card.className = 'msg plan-card';
      card.setAttribute('data-plan-rev', msg.revision || '');
      const title = document.createElement('div');
      title.className = 'plan-title';
      title.textContent = '📋 执行计划（可编辑）';
      const hint = document.createElement('div');
      hint.className = 'plan-hint';
      hint.textContent = 'View 可在编辑器打开 .su/plans 计划文件；确认后点 Build 切到 Agent 执行。未 Build 不会改代码。';
      const body = document.createElement('textarea');
      body.className = 'plan-body';
      body.value = msg.markdown || '';
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const bView = document.createElement('button');
      bView.type = 'button';
      bView.textContent = 'View';
      bView.title = '在编辑器打开临时 Markdown 计划（.su/plans）';
      bView.addEventListener('click', () => {
        const md = (body.value || '').trim();
        if (!md) {
          hint.textContent = '计划内容不能为空。';
          return;
        }
        hint.textContent = '正在打开计划文件…';
        vscode.postMessage({ type: 'viewPlan', markdown: md });
      });
      const bBuild = document.createElement('button');
      bBuild.type = 'button';
      bBuild.className = 'primary';
      bBuild.textContent = 'Build';
      bBuild.addEventListener('click', () => {
        if (streaming) return;
        const md = (body.value || '').trim();
        if (!md) {
          hint.textContent = '计划内容不能为空。';
          return;
        }
        card.classList.add('built');
        hint.textContent = '已提交 Build → Agent 执行中…';
        setMode('agent');
        vscode.postMessage({ type: 'buildPlan', markdown: md });
      });
      actions.appendChild(bView);
      actions.appendChild(bBuild);
      card.appendChild(title);
      card.appendChild(hint);
      card.appendChild(body);
      card.appendChild(actions);
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
    }

    let hasWorkspace = true;

    function showEmpty() {
      thread.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'empty';
      el.id = 'emptyState';
      const projectHint = hasWorkspace
        ? '<li>顶栏 <strong>+</strong> 可开空聊天；⋯ 可换项目文件夹</li>'
        : '<li><a data-act="folderNew">打开文件夹（新窗口）</a> 绑定项目，或先纯聊天</li>' +
          '<li><a data-act="folderHere">打开文件夹（当前窗口）</a></li>';
      el.innerHTML = '<h3>开始使用 Su</h3><ol>' +
        '<li><a data-act="key">设置 API Key</a></li>' +
        '<li>在下方输入问题并发送（无项目也可闲聊）</li>' +
        projectHint +
        '<li>需要改文件时切到 <strong>Agent</strong></li>' +
        '<li><a data-act="manual">打开用户手册</a></li></ol>';
      thread.appendChild(el);
      el.querySelector('[data-act="key"]').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
      el.querySelector('[data-act="manual"]').addEventListener('click', () => vscode.postMessage({ type: 'openUserManual' }));
      const fn = el.querySelector('[data-act="folderNew"]');
      if (fn) fn.addEventListener('click', () => vscode.postMessage({ type: 'openFolder', forceNewWindow: true }));
      const fh = el.querySelector('[data-act="folderHere"]');
      if (fh) fh.addEventListener('click', () => vscode.postMessage({ type: 'openFolder', forceNewWindow: false }));
      messageCount = 0;
    }

    function clearEmpty() {
      const e = document.getElementById('emptyState');
      if (e) e.remove();
    }

    const imgLightbox = document.getElementById('imgLightbox');
    const imgLightboxImg = document.getElementById('imgLightboxImg');
    const imgLightboxClose = document.getElementById('imgLightboxClose');

    function openLightbox(src, alt) {
      if (!src || !imgLightbox || !imgLightboxImg) return;
      imgLightboxImg.src = src;
      imgLightboxImg.alt = alt || '';
      imgLightbox.classList.add('open');
      imgLightbox.setAttribute('aria-hidden', 'false');
    }

    function closeLightbox() {
      if (!imgLightbox || !imgLightboxImg) return;
      if (!imgLightbox.classList.contains('open')) return false;
      imgLightbox.classList.remove('open');
      imgLightbox.setAttribute('aria-hidden', 'true');
      imgLightboxImg.removeAttribute('src');
      return true;
    }

    function appendMsgImages(body, images) {
      if (!images || !images.length) return;
      const row = document.createElement('div');
      row.className = 'msg-images';
      images.forEach((im) => {
        if (!im || !im.dataBase64) return;
        const img = document.createElement('img');
        img.className = 'msg-thumb zoomable';
        img.alt = im.name || 'image';
        img.title = '点击放大';
        img.src = 'data:' + (im.mime || 'image/png') + ';base64,' + im.dataBase64;
        row.appendChild(img);
      });
      if (row.childNodes.length) body.appendChild(row);
    }

    function addMsg(role, text, cls, asMarkdown, images) {
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
        let display = String(text || '');
        if (images && images.length) {
          display = display.replace(/\\[图片:[^\\]]*\\]/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
        }
        b.textContent = display;
        appendMsgImages(b, images);
      }
      el.appendChild(r);
      el.appendChild(b);
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return { card: el, body: b };
    }

    const TOOL_LABELS = {
      list_dir: '浏览目录',
      read_file: '读取文件',
      write_file: '写入文件',
      replace_in_file: '修改文件',
      run_terminal: '运行终端',
      ask_user: '等待你的选择',
      thinking: '思考中',
    };

    function toolPretty(name) {
      const key = String(name || '').split(/\\s|\\n/)[0].replace(/…$/, '');
      return TOOL_LABELS[key] || key || '工具';
    }

    function refreshProcessSummary(fold, liveText, busy) {
      const main = fold.summary.querySelector('.tool-fold-summary-main');
      const live = fold.summary.querySelector('.tool-fold-live');
      if (main) {
        main.textContent = '处理过程 · ' + fold.count + ' 步' + (busy ? '' : '（点击展开）');
      }
      if (live) {
        live.textContent = liveText || '';
        live.classList.toggle('busy', !!busy);
        live.style.display = liveText ? 'block' : 'none';
      }
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
      details.open = true;
      const summary = document.createElement('summary');
      const main = document.createElement('div');
      main.className = 'tool-fold-summary-main';
      main.textContent = '处理过程';
      const live = document.createElement('div');
      live.className = 'tool-fold-live';
      summary.appendChild(main);
      summary.appendChild(live);
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
      fold.details.open = true;
      const raw = String(text || '');
      const firstLine = (raw.split('\\n')[0] || 'TOOL').trim() || 'TOOL';
      const hasBody = raw.indexOf('\\n') >= 0;
      const pretty = toolPretty(firstLine);
      // Real tools replace the thinking placeholder so the fold does not stack empty waits.
      if (!/^thinking/i.test(firstLine)) {
        Array.prototype.slice.call(fold.body.querySelectorAll('.tool-step[data-pending="1"]')).forEach((el) => {
          const lab = el.querySelector('.tool-step-label');
          if (lab && /思考中|thinking/i.test(lab.textContent || '')) el.remove();
        });
      }
      const last = fold.body.lastElementChild;
      // Replace in-progress "name…" step with the completed result.
      if (last && last.getAttribute('data-pending') === '1' && hasBody) {
        last.removeAttribute('data-pending');
        const lab = last.querySelector('.tool-step-label');
        const pre = last.querySelector('pre');
        if (lab) {
          lab.textContent = pretty + (firstLine.length > 40 ? ' · ' + firstLine.slice(0, 60) + '…' : '');
          lab.title = firstLine;
        }
        if (pre) pre.textContent = raw;
        refreshProcessSummary(fold, '已完成 ' + pretty + ' · 共 ' + fold.count + ' 步', true);
        thread.scrollTop = thread.scrollHeight;
        return;
      }
      fold.count += 1;
      const step = document.createElement('div');
      step.className = 'tool-step';
      if (!hasBody) step.setAttribute('data-pending', '1');
      const label = document.createElement('div');
      label.className = 'tool-step-label';
      label.textContent = (!hasBody ? '⏳ ' : '✓ ') + pretty;
      label.title = firstLine;
      const pre = document.createElement('pre');
      pre.textContent = hasBody ? raw : '进行中…';
      step.appendChild(label);
      step.appendChild(pre);
      fold.body.appendChild(step);
      refreshProcessSummary(
        fold,
        (!hasBody ? '正在' : '刚完成') + pretty + ' · 共 ' + fold.count + ' 步',
        !hasBody || streaming,
      );
      thread.scrollTop = thread.scrollHeight;
    }

    function showUserFeedback(msg) {
      clearEmpty();
      messageCount++;
      // Always top-level so the card is not buried inside a collapsed process fold.
      const fold = processFold && processFold.wrap && processFold.wrap.isConnected ? processFold : null;
      if (fold) {
        fold.details.open = true;
        refreshProcessSummary(fold, '等待你的选择…', true);
      }
      const card = document.createElement('div');
      card.className = 'msg fb-card';
      card.setAttribute('data-fb-id', msg.id);
      const eyebrow = document.createElement('div');
      eyebrow.className = 'fb-eyebrow';
      eyebrow.textContent = msg.kind === 'suggestion' ? '建议确认' : '需要你的选择';
      const message = document.createElement('div');
      message.className = 'fb-message';
      message.textContent = msg.message || '';
      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'fb-options';
      const checks = [];
      (msg.options || []).forEach((label, idx) => {
        const row = document.createElement('label');
        row.className = 'fb-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = label;
        cb.addEventListener('change', () => {
          row.classList.toggle('selected', cb.checked);
        });
        const span = document.createElement('span');
        span.textContent = label;
        row.appendChild(cb);
        row.appendChild(span);
        optionsWrap.appendChild(row);
        checks.push(cb);
        if (idx === 0 && (msg.options || []).length === 1) {
          cb.checked = true;
          row.classList.add('selected');
        }
      });
      const free = document.createElement('textarea');
      free.className = 'fb-free';
      free.placeholder = '补充说明（可选）';
      const hint = document.createElement('div');
      hint.className = 'fb-hint';
      hint.textContent = msg.kind === 'suggestion'
        ? '点「发送」按选择继续；点「关闭」会结束本轮且不执行该建议（不是稍后再说）。'
        : '点「发送」按选择继续；点「关闭」则继续当前方案、不做额外扩展。';
      const actions = document.createElement('div');
      actions.className = 'fb-actions';
      function settleLocal(summary) {
        if (card.classList.contains('done')) return;
        card.classList.add('done');
        hint.textContent = summary;
        if (fold) refreshProcessSummary(fold, summary, true);
      }
      function finish(status) {
        if (card.classList.contains('done')) return;
        const selected = checks.filter((c) => c.checked).map((c) => c.value);
        const freeText = (free.value || '').trim();
        if (status === 'answered' && !selected.length && !freeText) {
          hint.textContent = '请至少勾选一项或填写说明，或点关闭。';
          return;
        }
        const summary = status === 'dismissed'
          ? (msg.kind === 'suggestion' ? '已关闭建议 · 结束任务' : '已关闭 · 继续当前方案')
          : ('已选择：' + (selected.length ? selected.join('、') : '（仅文字）'));
        settleLocal(summary);
        vscode.postMessage({
          type: 'userFeedbackResult',
          id: msg.id,
          status: status,
          selected: selected,
          freeText: freeText,
        });
      }
      const bSend = document.createElement('button');
      bSend.type = 'button';
      bSend.className = 'primary';
      bSend.textContent = '发送';
      bSend.addEventListener('click', () => finish('answered'));
      const bClose = document.createElement('button');
      bClose.type = 'button';
      bClose.textContent = msg.kind === 'suggestion' ? '关闭并结束' : '关闭';
      bClose.addEventListener('click', () => finish('dismissed'));
      actions.appendChild(bSend);
      actions.appendChild(bClose);
      card.appendChild(eyebrow);
      card.appendChild(message);
      if ((msg.options || []).length) card.appendChild(optionsWrap);
      card.appendChild(free);
      card.appendChild(hint);
      card.appendChild(actions);
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
    }

    function showTerminalPermission(msg) {
      clearEmpty();
      messageCount++;
      setLiveProgress('⚠️ 等待你授权终端命令（请点下方卡片）', true);
      const fold = processFold && processFold.wrap && processFold.wrap.isConnected ? processFold : null;
      if (fold) {
        fold.details.open = true;
        refreshProcessSummary(fold, '等待终端授权…', true);
      }
      // Always top-level — do not bury the card inside a scrollable fold body.
      const card = document.createElement('div');
      card.className = 'msg perm-card';
      card.setAttribute('data-perm-id', msg.id);
      const title = document.createElement('div');
      title.className = 'perm-title';
      title.textContent = '⚠️ 请求运行终端命令';
      const cmd = document.createElement('pre');
      cmd.className = 'perm-cmd';
      cmd.textContent = msg.command || '';
      const hint = document.createElement('div');
      hint.className = 'perm-hint';
      hint.textContent = msg.readonlyGit
        ? '只读 git 类命令。可选「本会话总是允许」后本会话内终端不再询问。写文件仍走 Keep/Reject。'
        : '可选「本会话总是允许」后本会话内终端命令不再询问。危险命令请谨慎；写文件仍走 Keep/Reject。';
      const actions = document.createElement('div');
      actions.className = 'perm-actions';
      const decisionLabel = {
        allow_session: '本会话总是允许',
        allow_once: '允许一次',
        deny: '拒绝',
      };
      function settleCard(decision) {
        if (card.classList.contains('done')) return;
        card.classList.add('done');
        hint.textContent = '已选择：' + (decisionLabel[decision] || decision);
        setLiveProgress('终端授权：' + (decisionLabel[decision] || decision), true);
        if (fold) refreshProcessSummary(fold, '终端授权：' + (decisionLabel[decision] || decision), true);
      }
      function finish(decision) {
        settleCard(decision);
        vscode.postMessage({ type: 'terminalPermissionResult', id: msg.id, decision: decision });
      }
      const bAlways = document.createElement('button');
      bAlways.type = 'button';
      bAlways.className = 'primary';
      bAlways.textContent = '本会话总是允许';
      bAlways.addEventListener('click', () => finish('allow_session'));
      const bOnce = document.createElement('button');
      bOnce.type = 'button';
      bOnce.textContent = '允许一次';
      bOnce.addEventListener('click', () => finish('allow_once'));
      const bDeny = document.createElement('button');
      bDeny.type = 'button';
      bDeny.textContent = '拒绝';
      bDeny.addEventListener('click', () => finish('deny'));
      actions.appendChild(bAlways);
      actions.appendChild(bOnce);
      actions.appendChild(bDeny);
      card.appendChild(title);
      card.appendChild(cmd);
      card.appendChild(hint);
      card.appendChild(actions);
      thread.appendChild(card);
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
      if (processFold && processFold.wrap && processFold.wrap.isConnected) {
        processFold.details.open = false;
        refreshProcessSummary(processFold, '共 ' + processFold.count + ' 步 · 点击展开详情', false);
      }
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
    document.getElementById('mOpenFolderNew').addEventListener('click', () => {
      moreMenu.classList.remove('open');
      vscode.postMessage({ type: 'openFolder', forceNewWindow: true });
    });
    document.getElementById('mOpenFolderHere').addEventListener('click', () => {
      moreMenu.classList.remove('open');
      vscode.postMessage({ type: 'openFolder', forceNewWindow: false });
    });
    document.getElementById('mModels').addEventListener('click', () => vscode.postMessage({ type: 'editModels' }));
    document.getElementById('mKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('mSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('mManual').addEventListener('click', () => vscode.postMessage({ type: 'openUserManual' }));
    document.getElementById('btnAttach').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
    document.getElementById('btnActiveFile').addEventListener('click', () => vscode.postMessage({ type: 'attachActiveFile' }));
    const btnAgentWindow = document.getElementById('btnAgentWindow');
    if (btnAgentWindow) btnAgentWindow.addEventListener('click', () => vscode.postMessage({ type: 'openAgentWindow' }));
    const btnIdeWindow = document.getElementById('btnIdeWindow');
    if (btnIdeWindow) btnIdeWindow.addEventListener('click', () => vscode.postMessage({ type: 'openIdeWindow' }));

    function onDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const fromWb = e.dataTransfer ? looksLikeWorkbenchDrag(e.dataTransfer) : false;
      composer.classList.toggle('dragover', !fromWb);
      composer.classList.toggle('dragover-vscode', fromWb);
      const hint = document.getElementById('dropHint');
      if (hint) {
        hint.innerHTML = fromWb
          ? '检测到编辑器内拖入：请按住 <strong>Shift</strong> 再松手<br/>或改用右键「添加到 Su Chat」'
          : '松开以添加引用';
      }
    }
    const dropTargets = [composer, footer, document.body].filter(Boolean);
    ;['dragenter', 'dragover'].forEach((ev) => {
      dropTargets.forEach((el) => el.addEventListener(ev, onDragOver));
    });
    dropTargets.forEach((el) => {
      el.addEventListener('dragleave', (e) => {
        if (e.target === el) {
          composer.classList.remove('dragover');
          composer.classList.remove('dragover-vscode');
        }
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
      if (e.key === 'Escape') {
        if (closeLightbox()) {
          e.preventDefault();
          return;
        }
        if (streaming) vscode.postMessage({ type: 'stop' });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && closeLightbox()) {
        e.preventDefault();
      }
    });
    if (imgLightbox) {
      imgLightbox.addEventListener('click', (e) => {
        if (e.target === imgLightbox || e.target === imgLightboxImg) closeLightbox();
      });
    }
    if (imgLightboxClose) {
      imgLightboxClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
      });
    }
    vscode.postMessage({ type: 'listSkills' });
    thread.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a && a.href) e.preventDefault();
      const img = e.target && e.target.closest ? e.target.closest('img.zoomable') : null;
      if (img && img.src) {
        e.preventDefault();
        openLightbox(img.src, img.alt || '');
      }
    });
    attachRow.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.x')) return;
      const img = e.target && e.target.closest ? e.target.closest('img.zoomable') : null;
      if (img && img.src) {
        e.preventDefault();
        openLightbox(img.src, img.alt || '');
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          fillModelPick(msg.models, msg.modelPick, msg.model);
          setMode(msg.mode || 'chat');
          if (msg.sessionTitle) sessionTitle.textContent = msg.sessionTitle;
          updateDiffUi(msg.pendingDiffs);
          hasWorkspace = msg.hasWorkspace !== false;
          meta.textContent = (msg.hasKey ? 'Key ✓' : 'Key ✗')
            + ' · ' + (msg.activeModel || msg.model)
            + (msg.modelPick === 'auto' ? ' (Auto)' : '')
            + ' · ' + (msg.workspaceLabel || '')
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
          addMsg('you', msg.text, 'user', false, msg.images);
          break;
        case 'assistantStart': {
          setStreaming(true);
          setLiveProgress('正在思考 / 等待模型…', true);
          // Defer the answer card so tool steps stay above the final reply.
          currentCard = null;
          currentBody = null;
          processFold = null;
          // Show progress immediately while waiting on the first model round-trip.
          appendToolStep('thinking…');
          const fold = ensureProcessFold();
          fold.details.open = true;
          refreshProcessSummary(fold, '正在思考 / 等待模型…', true);
          thread.scrollTop = thread.scrollHeight;
          break;
        }
        case 'progress': {
          setLiveProgress(msg.text || '处理中…', true);
          const fold = ensureProcessFold();
          fold.details.open = true;
          // Keep a visible pending step, not only the summary live line.
          const last = fold.body.lastElementChild;
          if (last && last.getAttribute('data-pending') === '1') {
            const pre = last.querySelector('pre');
            if (pre) pre.textContent = msg.text || '处理中…';
          } else {
            appendToolStep('thinking…');
            const pending = fold.body.lastElementChild;
            const pre = pending && pending.querySelector('pre');
            if (pre) pre.textContent = msg.text || '处理中…';
          }
          refreshProcessSummary(fold, msg.text || '处理中…', true);
          thread.scrollTop = thread.scrollHeight;
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
          setLiveProgress('执行：' + toolPretty((msg.text || '').split('\\n')[0] || '工具'), true);
          appendToolStep(msg.text || '');
          break;
        case 'terminalPermission':
          showTerminalPermission(msg);
          break;
        case 'terminalPermissionSettled': {
          const el = thread.querySelector('[data-perm-id="' + msg.id + '"]');
          if (el && !el.classList.contains('done')) {
            el.classList.add('done');
            const h = el.querySelector('.perm-hint');
            const labels = { allow_session: '本会话总是允许', allow_once: '允许一次', deny: '拒绝' };
            if (h) h.textContent = '已选择：' + (labels[msg.decision] || msg.decision);
          }
          break;
        }
        case 'userFeedback':
          showUserFeedback(msg);
          break;
        case 'userFeedbackSettled': {
          const el = thread.querySelector('[data-fb-id="' + msg.id + '"]');
          if (el && !el.classList.contains('done')) {
            el.classList.add('done');
            const h = el.querySelector('.fb-hint');
            if (h) {
              if (msg.status === 'aborted') {
                h.textContent = '已取消（停止生成）';
              } else if (msg.status === 'dismissed') {
                h.textContent = '已关闭';
              } else {
                const sel = (msg.selected || []).join('、');
                h.textContent = '已选择：' + (sel || (msg.freeText || '（仅文字）'));
              }
            }
          }
          break;
        }
        case 'planCard':
          showPlanCard(msg);
          break;
        case 'planCardSync': {
          const cards = thread.querySelectorAll('.plan-card:not(.built)');
          const card = cards[cards.length - 1];
          if (card) {
            const ta = card.querySelector('textarea.plan-body');
            if (ta) ta.value = msg.markdown || '';
            if (msg.revision) card.setAttribute('data-plan-rev', msg.revision);
            const hintEl = card.querySelector('.plan-hint');
            if (hintEl) hintEl.textContent = '计划已从编辑器同步；确认后点 Build。';
          }
          break;
        }
        case 'assistantDone':
        case 'stopped':
          finishAssistantMarkdown();
          setStreaming(false);
          break;
        case 'error':
          setStreaming(false);
          setLiveProgress('', false);
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
        case 'atMentions':
          atCache = msg.items || [];
          openAtMenu(atCache);
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
