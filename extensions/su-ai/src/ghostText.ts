import * as vscode from 'vscode';
import { resolveSuRuntimeConfig } from './config';
import { completeChat } from './openaiClient';

const PREFIX_CHARS = 3500;
const SUFFIX_CHARS = 800;

/**
 * Ghost Text via VS Code InlineCompletionItemProvider.
 * Uses the same OpenAI-compatible relay/model as Chat.
 */
export class GhostTextProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Provides a single inline completion at the cursor, or none.
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined> {
    const cfg = vscode.workspace.getConfiguration('su');
    if (!cfg.get<boolean>('ghostText.enabled', true)) {
      return;
    }

    const debounceMs = Math.max(0, cfg.get<number>('ghostText.debounceMs', 400) || 0);
    if (debounceMs > 0) {
      const cancelled = await wait(debounceMs, token);
      if (cancelled || token.isCancellationRequested) {
        return;
      }
    }

    const runtime = await resolveSuRuntimeConfig(this.context);
    if (!runtime.apiKey || !runtime.baseUrl) {
      return;
    }

    const offset = document.offsetAt(position);
    const full = document.getText();
    const prefix = full.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = full.slice(offset, Math.min(full.length, offset + SUFFIX_CHARS));

    // Avoid useless calls on empty docs with no typing yet.
    if (!prefix.trim() && !suffix.trim()) {
      return;
    }

    const maxTokens = Math.min(512, Math.max(16, cfg.get<number>('ghostText.maxTokens', 96) || 96));
    const fileLabel = vscode.workspace.asRelativePath(document.uri, false) || document.fileName;

    try {
      const raw = await completeChat({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        model: runtime.model,
        timeoutMs: Math.min(runtime.timeoutMs, 20000),
        maxTokens,
        temperature: 0,
        signal: abortFromToken(token),
        messages: [
          {
            role: 'system',
            content:
              'You are a code completion engine inside the su editor. ' +
              'Complete the code at the cursor. Output ONLY the exact text to insert at the cursor. ' +
              'No markdown fences, no explanations, no repeating the prefix.',
          },
          {
            role: 'user',
            content:
              `File: ${fileLabel}\nLanguage: ${document.languageId}\n\n` +
              `CODE BEFORE CURSOR:\n${prefix}\n` +
              `CODE AFTER CURSOR:\n${suffix}\n` +
              `Insert completion now:`,
          },
        ],
      });

      if (token.isCancellationRequested) {
        return;
      }

      const text = sanitizeCompletion(raw, prefix);
      if (!text) {
        return;
      }

      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    } catch (e) {
      if (token.isCancellationRequested) {
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === '已停止生成') {
        return;
      }
      // Keep editor quiet; log for debugging.
      console.warn('[su-ai] ghost text skipped:', msg);
      return;
    }
  }
}

/**
 * Strips accidental fences / echoed prefix from model output.
 */
export function sanitizeCompletion(raw: string, prefix: string): string {
  let text = (raw || '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return '';
  }

  const fence = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```\s*$/);
  if (fence) {
    text = fence[1];
  }

  // If the model echoed the end of the prefix, drop the overlap.
  const tail = prefix.slice(-80);
  if (tail && text.startsWith(tail)) {
    text = text.slice(tail.length);
  }

  return text;
}

function wait(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(true);
    });
  });
}

function abortFromToken(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    token.onCancellationRequested(() => controller.abort());
  }
  return controller.signal;
}
