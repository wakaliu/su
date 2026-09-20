import * as vscode from 'vscode';
import { resolveSuRuntimeConfig } from '../config';
import { streamChatCompletion, type ChatMessage } from '../openaiClient';
import { promptAndSetApiKey } from '../secrets';

type WebviewToExt =
  | { type: 'ready' }
  | { type: 'send'; text: string; includeSelection: boolean }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' };

type ExtToWebview =
  | { type: 'status'; hasKey: boolean; model: string; baseUrl: string }
  | { type: 'user'; text: string }
  | { type: 'assistantStart' }
  | { type: 'assistantDelta'; text: string }
  | { type: 'assistantDone' }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

/**
 * Side-bar Chat panel (Cursor-like Ctrl+L target) with streaming OpenAI-compatible replies.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'su.chat';

  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private history: ChatMessage[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Reveals the Su Chat side bar and focuses the webview input.
   */
  async open(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.su-ai');
    await vscode.commands.executeCommand('su.chat.focus');
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
          break;
        case 'send':
          await this.handleSend(raw.text, raw.includeSelection);
          break;
        case 'stop':
          this.abort?.abort();
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

  private async pushStatus(): Promise<void> {
    const cfg = await resolveSuRuntimeConfig(this.context);
    this.post({
      type: 'status',
      hasKey: Boolean(cfg.apiKey),
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    });
  }

  private async handleSend(text: string, includeSelection: boolean): Promise<void> {
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
    this.post({ type: 'user', text: userContent });
    this.post({ type: 'assistantStart' });

    const cfg = await resolveSuRuntimeConfig(this.context);
    this.abort = new AbortController();
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
            content: 'You are Su, a helpful coding assistant embedded in the su editor. Reply in the user\'s language when possible.',
          },
          ...this.history,
        ],
        signal: this.abort.signal,
        onDelta: (delta) => {
          assistant += delta;
          this.post({ type: 'assistantDelta', text: delta });
        },
      });
      if (assistant) {
        this.history.push({ role: 'assistant', content: assistant });
      }
      this.post({ type: 'assistantDone' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === '已停止生成') {
        if (assistant) {
          this.history.push({ role: 'assistant', content: assistant });
        }
        this.post({ type: 'stopped' });
      } else {
        // Drop the failed user turn's incomplete assistant; keep user message for retry context.
        this.post({ type: 'error', message });
      }
    } finally {
      this.abort = undefined;
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
      --err: var(--vscode-errorForeground);
      --font: var(--vscode-font-family);
      --mono: var(--vscode-editor-font-family);
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%; margin: 0;
      background: var(--bg); color: var(--fg);
      font: 13px/1.45 var(--font);
    }
    body { display: flex; flex-direction: column; }
    header {
      padding: 8px 10px; border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 4px;
    }
    header .title { font-weight: 600; }
    header .meta { color: var(--muted); font-size: 11px; word-break: break-all; }
    header .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    #thread {
      flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px;
    }
    .msg {
      padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word;
      border: 1px solid var(--border);
    }
    .msg.user { background: var(--user-bg); align-self: flex-end; max-width: 95%; }
    .msg.assistant { background: var(--ai-bg); align-self: stretch; }
    .msg.error { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }
    .msg .role { font-size: 10px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
    footer {
      border-top: 1px solid var(--border); padding: 8px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    textarea {
      width: 100%; min-height: 64px; max-height: 160px; resize: vertical;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 8px;
      font: 13px/1.4 var(--font);
    }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .row label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; user-select: none; }
    button {
      border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer;
      background: var(--btn-bg); color: var(--btn-fg); font: 12px var(--font);
    }
    button.secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
    button:disabled { opacity: .55; cursor: default; }
    .hint { color: var(--muted); font-size: 11px; }
  </style>
</head>
<body>
  <header>
    <div class="title">Su Chat</div>
    <div class="meta" id="meta">加载中…</div>
    <div class="actions">
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
    <div class="hint">快捷键 Ctrl+L / Cmd+L 打开本面板 · v0.2 流式 Chat</div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const thread = document.getElementById('thread');
    const input = document.getElementById('input');
    const meta = document.getElementById('meta');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const includeSel = document.getElementById('includeSel');
    let streaming = false;
    let currentAi = null;

    function setStreaming(on) {
      streaming = on;
      btnSend.disabled = on;
      btnStop.disabled = !on;
    }

    function addMsg(role, text, cls) {
      const el = document.createElement('div');
      el.className = 'msg ' + (cls || role);
      const r = document.createElement('div');
      r.className = 'role';
      r.textContent = role;
      const b = document.createElement('div');
      b.className = 'body';
      b.textContent = text || '';
      el.appendChild(r);
      el.appendChild(b);
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return b;
    }

    function send() {
      if (streaming) return;
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text, includeSelection: includeSel.checked });
    }

    btnSend.addEventListener('click', send);
    btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('btnKey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('btnSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'status':
          meta.textContent = (msg.hasKey ? 'Key ✓' : 'Key ✗') + ' · ' + msg.model + ' · ' + msg.baseUrl;
          break;
        case 'user':
          addMsg('you', msg.text, 'user');
          break;
        case 'assistantStart':
          setStreaming(true);
          currentAi = addMsg('su', '', 'assistant');
          break;
        case 'assistantDelta':
          if (currentAi) {
            currentAi.textContent += msg.text;
            thread.scrollTop = thread.scrollHeight;
          }
          break;
        case 'assistantDone':
        case 'stopped':
          setStreaming(false);
          currentAi = null;
          break;
        case 'error':
          setStreaming(false);
          currentAi = null;
          addMsg('error', msg.message, 'error');
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
