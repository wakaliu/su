import * as vscode from 'vscode';
import { resolveSuRuntimeConfig } from '../config';
import { streamChatCompletion, type ChatMessage } from '../openaiClient';
import { promptAndSetApiKey } from '../secrets';
import { runAgent } from '../agent/agentRunner';
import { DiffReviewService } from '../agent/diffReview';

const HISTORY_KEY = 'su.chat.history';
/** Max messages kept for API context + persistence (user+assistant pairs). */
const MAX_HISTORY = 40;

type WebviewToExt =
  | { type: 'ready' }
  | { type: 'send'; text: string; includeSelection: boolean; mode: 'chat' | 'agent' }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'newChat' }
  | { type: 'reviewDiffs' };

type ExtToWebview =
  | { type: 'status'; hasKey: boolean; model: string; baseUrl: string; pendingDiffs: number }
  | { type: 'restore'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'user'; text: string }
  | { type: 'assistantStart' }
  | { type: 'assistantDelta'; text: string }
  | { type: 'assistantDone' }
  | { type: 'tool'; text: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'cleared' };

/**
 * Side-bar Chat panel with streaming replies, persisted history, and Markdown rendering.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'su.chat';

  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private history: ChatMessage[] = [];
  readonly diffs: DiffReviewService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = this.loadHistory();
    this.diffs = new DiffReviewService();
  }

  /**
   * Reveals Su Chat in the right auxiliary bar (Cursor-like) and focuses input.
   */
  async open(): Promise<void> {
    // Ensure the secondary/auxiliary side bar is visible, then focus our container.
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
          this.post({
            type: 'restore',
            messages: this.history
              .filter(
                (m): m is ChatMessage & { role: 'user' | 'assistant'; content: string } =>
                  (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
              )
              .map((m) => ({ role: m.role, content: m.content })),
          });
          break;
        case 'send':
          await this.handleSend(raw.text, raw.includeSelection, raw.mode === 'agent' ? 'agent' : 'chat');
          break;
        case 'stop':
          this.abort?.abort();
          break;
        case 'newChat':
          this.abort?.abort();
          this.history = [];
          await this.saveHistory();
          this.post({ type: 'cleared' });
          break;
        case 'reviewDiffs':
          await vscode.commands.executeCommand('su.reviewAgentDiffs');
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('su.openSettings');
          break;
        case 'setApiKey':
          await promptAndSetApiKey(this.context);
          await this.pushStatus();
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

  private loadHistory(): ChatMessage[] {
    const raw = this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      )
      .slice(-MAX_HISTORY);
  }

  private async saveHistory(): Promise<void> {
    const trimmed = this.history
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      )
      .slice(-MAX_HISTORY);
    this.history = trimmed;
    await this.context.workspaceState.update(HISTORY_KEY, trimmed);
  }

  private async pushStatus(): Promise<void> {
    const cfg = await resolveSuRuntimeConfig(this.context);
    this.post({
      type: 'status',
      hasKey: Boolean(cfg.apiKey),
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      pendingDiffs: this.diffs.size,
    });
  }

  private async handleSend(
    text: string,
    includeSelection: boolean,
    mode: 'chat' | 'agent',
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.abort) {
      this.abort.abort();
      this.abort = undefined;
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

    this.history.push({ role: 'user', content: userContent });
    await this.saveHistory();
    this.post({ type: 'user', text: userContent });
    this.post({ type: 'assistantStart' });

    const cfg = await resolveSuRuntimeConfig(this.context);
    this.abort = new AbortController();

    if (mode === 'agent') {
      await this.runAgentTurn(userContent, cfg);
      return;
    }

    let assistant = '';
    try {
      await streamChatCompletion({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        messages: [
          {
            role: 'system',
            content:
              'You are Su, a helpful coding assistant embedded in the su editor. Prefer Markdown. Reply in the user\'s language when possible.',
          },
          ...this.history
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-MAX_HISTORY) as ChatMessage[],
        ],
        signal: this.abort.signal,
        onDelta: (delta) => {
          assistant += delta;
          this.post({ type: 'assistantDelta', text: delta });
        },
      });
      if (assistant) {
        this.history.push({ role: 'assistant', content: assistant });
        await this.saveHistory();
      }
      this.post({ type: 'assistantDone' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === '已停止生成') {
        if (assistant) {
          this.history.push({ role: 'assistant', content: assistant });
          await this.saveHistory();
        }
        this.post({ type: 'stopped' });
      } else {
        this.post({ type: 'error', message });
      }
    } finally {
      this.abort = undefined;
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
          } else if (ev.type === 'assistant') {
            assistant = ev.text;
            this.post({ type: 'assistantDelta', text: ev.text });
          } else if (ev.type === 'done') {
            if (assistant) {
              // already streamed as one chunk
            } else if (ev.summary) {
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
        const tip = `\n\n— 待审 ${this.diffs.size} 个文件：用命令「Su: 审阅 Agent 改动」Keep/Reject。`;
        assistant += tip;
        this.post({ type: 'assistantDelta', text: tip });
      }
      this.history.push({ role: 'assistant', content: assistant });
      await this.saveHistory();
      this.post({ type: 'assistantDone' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === '已停止生成') {
        if (assistant) {
          this.history.push({ role: 'assistant', content: assistant });
          await this.saveHistory();
        }
        this.post({ type: 'stopped' });
      } else {
        this.post({ type: 'error', message });
      }
    } finally {
      this.abort = undefined;
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
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font); }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    header .title { font-weight: 600; }
    header .meta { color: var(--muted); font-size: 11px; word-break: break-all; }
    header .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    #thread { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .msg { padding: 8px 10px; border-radius: 8px; word-break: break-word; border: 1px solid var(--border); }
    .msg.user { background: var(--user-bg); align-self: flex-end; max-width: 95%; white-space: pre-wrap; }
    .msg.assistant { background: var(--ai-bg); align-self: stretch; }
    .msg.error { color: var(--err); white-space: pre-wrap; border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }
    .msg .role { font-size: 10px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
    .msg .body.md h1, .msg .body.md h2, .msg .body.md h3 { margin: 0.6em 0 0.35em; line-height: 1.25; font-size: 1.05em; }
    .msg .body.md p { margin: 0.4em 0; }
    .msg .body.md ul, .msg .body.md ol { margin: 0.35em 0; padding-left: 1.3em; }
    .msg .body.md code {
      font-family: var(--mono); font-size: 12px; background: var(--code-bg);
      padding: 0.1em 0.35em; border-radius: 4px;
    }
    .msg .body.md pre {
      margin: 0.5em 0; padding: 8px; overflow: auto; background: var(--code-bg);
      border-radius: 6px; border: 1px solid var(--border);
    }
    .msg .body.md pre code { padding: 0; background: transparent; }
    .msg .body.md a { color: var(--link); }
    .msg .body.md blockquote {
      margin: 0.4em 0; padding-left: 0.8em; border-left: 3px solid var(--border); color: var(--muted);
    }
    .msg.streaming .body { white-space: pre-wrap; }
    footer { border-top: 1px solid var(--border); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    textarea {
      width: 100%; min-height: 64px; max-height: 160px; resize: vertical;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 8px; font: 13px/1.4 var(--font);
    }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .row label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; user-select: none; }
    button {
      border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer;
      background: var(--btn-bg); color: var(--btn-fg); font: 12px var(--font);
    }
    button.secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
    button:disabled { opacity: .55; cursor: default; }
    .msg.tool { align-self: stretch; color: var(--muted); font-size: 12px; white-space: pre-wrap; }
    .mode-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .mode-seg button { border-radius: 0; padding: 4px 10px; background: transparent; color: var(--fg); }
    .mode-seg button.active { background: var(--btn-bg); color: var(--btn-fg); }
    .hint { color: var(--muted); font-size: 11px; }
  </style>
</head>
<body>
  <header>
    <div class="title">Su Chat</div>
    <div class="meta" id="meta">加载中…</div>
    <div class="actions">
      <div class="mode-seg" title="对话模式 / Agent 改文件">
        <button type="button" id="modeChat" class="active">Chat</button>
        <button type="button" id="modeAgent">Agent</button>
      </div>
      <button type="button" class="secondary" id="btnNew">新对话</button>
      <button type="button" class="secondary" id="btnReview">审阅 Diff</button>
      <button type="button" class="secondary" id="btnKey">设置 API Key</button>
      <button type="button" class="secondary" id="btnSettings">中转 / 模型</button>
    </div>
  </header>
  <div id="thread"></div>
  <footer>
    <textarea id="input" placeholder="问 Su…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="row">
      <label><input type="checkbox" id="includeSel" /> 附带当前选区</label>
      <span style="flex:1"></span>
      <button type="button" class="secondary" id="btnStop" disabled>停止</button>
      <button type="button" id="btnSend">发送</button>
    </div>
    <div class="hint">Agent 可改工作区文件；写后需 Keep/Reject · Ctrl+L</div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const input = document.getElementById('input');
    const meta = document.getElementById('meta');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const includeSel = document.getElementById('includeSel');
    const modeChat = document.getElementById('modeChat');
    const modeAgent = document.getElementById('modeAgent');
    let mode = 'chat';
    let streaming = false;
    let currentCard = null;
    let currentBody = null;

    function setMode(m) {
      mode = m;
      modeChat.classList.toggle('active', m === 'chat');
      modeAgent.classList.toggle('active', m === 'agent');
      input.placeholder = m === 'agent'
        ? '给 Agent 下任务…（会读写工作区，写后需审阅）'
        : '问 Su…（Enter 发送，Shift+Enter 换行）';
    }
    modeChat.addEventListener('click', () => setMode('chat'));
    modeAgent.addEventListener('click', () => setMode('agent'));

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /** Minimal Markdown → HTML after HTML-escaping (safe for model output). */
    function renderMarkdown(src) {
      const escaped = escapeHtml(src);
      const fences = [];
      let text = escaped.replace(/\`\`\`([\\w+-]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        const i = fences.length;
        fences.push('<pre><code class="language-' + lang + '">' + code.replace(/\\n$/, '') + '</code></pre>');
        return '\\x00FENCE' + i + '\\x00';
      });
      text = text.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
      text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(/(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)/g, '<em>$1</em>');
      text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" title="$2">$1</a>');
      text = text.replace(/^(?:- |\\* )(.+)$/gm, '<li>$1</li>');
      text = text.replace(/(?:<li>.*<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>');
      text = text.replace(/\\n{2,}/g, '</p><p>');
      text = text.replace(/\\n/g, '<br>');
      text = '<p>' + text + '</p>';
      text = text.replace(/\\x00FENCE(\\d+)\\x00/g, (_, i) => fences[Number(i)]);
      text = text.replace(/<p><\\/p>/g, '');
      text = text.replace(/<p>(<h[1-3]>)/g, '$1').replace(/(<\\/h[1-3]>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<pre>)/g, '$1').replace(/(<\\/pre>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<ul>)/g, '$1').replace(/(<\\/ul>)<\\/p>/g, '$1');
      text = text.replace(/<p>(<blockquote>)/g, '$1').replace(/(<\\/blockquote>)<\\/p>/g, '$1');
      return text;
    }

    function setStreaming(on) {
      streaming = on;
      btnSend.disabled = on;
      btnStop.disabled = !on;
    }

    function addMsg(role, text, cls, asMarkdown) {
      const el = document.createElement('div');
      el.className = 'msg ' + (cls || role);
      const r = document.createElement('div');
      r.className = 'role';
      r.textContent = role;
      const b = document.createElement('div');
      b.className = 'body' + (asMarkdown ? ' md' : '');
      if (asMarkdown) {
        b.innerHTML = renderMarkdown(text || '');
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
      currentCard = null;
      currentBody = null;
      thread.scrollTop = thread.scrollHeight;
    }

    function send() {
      if (streaming) return;
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text, includeSelection: includeSel.checked, mode });
    }

    btnSend.addEventListener('click', send);
    btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('btnNew').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    document.getElementById('btnReview').addEventListener('click', () => vscode.postMessage({ type: 'reviewDiffs' }));
    document.getElementById('btnKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    thread.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a && a.href) {
        e.preventDefault();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          meta.textContent = (msg.hasKey ? 'Key ✓' : 'Key ✗') + ' · ' + msg.model + ' · ' + msg.baseUrl
            + (msg.pendingDiffs ? (' · 待审 ' + msg.pendingDiffs) : '');
          break;
        case 'restore':
          thread.innerHTML = '';
          (msg.messages || []).forEach((m) => {
            if (m.role === 'user') addMsg('you', m.content, 'user', false);
            else addMsg('su', m.content, 'assistant', true);
          });
          break;
        case 'cleared':
          thread.innerHTML = '';
          currentCard = null;
          currentBody = null;
          setStreaming(false);
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
