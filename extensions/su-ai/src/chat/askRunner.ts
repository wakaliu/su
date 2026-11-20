import * as vscode from 'vscode';
import {
  completeChatWithTools,
  type ChatContentPart,
  type ChatMessage,
} from '../openaiClient';
import { buildReadonlyTools, executeAgentTool } from '../agent/tools';
import { SU_REPLY_FORMAT_HINT } from './replyMarkdown';

export interface AskRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  userContent: string | ChatContentPart[];
  systemExtras?: string[];
  history: ChatMessage[];
  signal?: AbortSignal;
  onEvent: (ev: AskEvent) => void;
}

export type AskEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'progress'; text: string }
  | { type: 'done'; summary: string };

/**
 * Ask-mode tool loop: list_dir / read_file only, so Su can inspect the open project.
 */
export async function runAskWithTools(opts: AskRunOptions): Promise<void> {
  const tools = buildReadonlyTools();
  const cfg = vscode.workspace.getConfiguration('su');
  // Soft cap for broad "介绍项目" style probes; default 100, configurable.
  const maxSteps = Math.min(500, Math.max(1, cfg.get<number>('ask.maxSteps', 100) || 100));

  const systemParts = [
    'You are Su, a helpful coding assistant embedded in the su editor. Prefer Markdown. Reply in the user\'s language. ' +
      'A workspace snapshot is injected below. If a folder is open, you are associated with that project and MAY call list_dir / read_file. ' +
      'If no folder is open, answer general questions only; do not invent a project — suggest opening a folder from the Su menu. ' +
      'Do NOT claim you lack permission when a workspace snapshot or tools provide the facts. ' +
      'Do NOT invent file contents — read them. For edits or terminal commands, tell the user to switch to Agent (Ctrl+I). ' +
      SU_REPLY_FORMAT_HINT,
    ...(opts.systemExtras || []),
  ];

  const historyMsgs = opts.history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => typeof m.content === 'string' || m.content === null)
    .slice(-20);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    ...historyMsgs,
    { role: 'user', content: opts.userContent },
  ];

  const timeoutMs = Math.max(
    opts.timeoutMs,
    Array.isArray(opts.userContent) ? 120_000 : opts.timeoutMs,
  );

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      throw new Error('已停止生成');
    }

    const startedAt = Date.now();
    opts.onEvent({
      type: 'progress',
      text: step === 0 ? '正在思考 / 等待模型…' : `继续推理 · 第 ${step + 1} 轮…`,
    });
    const heartbeat = setInterval(() => {
      if (opts.signal?.aborted) {
        return;
      }
      const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      opts.onEvent({
        type: 'progress',
        text:
          step === 0
            ? `正在思考 / 等待模型… 已等待 ${sec}s`
            : `继续推理 · 第 ${step + 1} 轮… 已等待 ${sec}s`,
      });
    }, 5000);

    let result: Awaited<ReturnType<typeof completeChatWithTools>>;
    try {
      result = await completeChatWithTools({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        timeoutMs,
        messages,
        tools,
        signal: opts.signal,
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (result.tool_calls && result.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.tool_calls,
      });

      for (const call of result.tool_calls) {
        if (opts.signal?.aborted) {
          throw new Error('已停止生成');
        }
        const name = call.function.name;
        if (name !== 'list_dir' && name !== 'read_file') {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `ERROR: Ask mode only allows list_dir / read_file (got ${name})`,
          });
          continue;
        }
        opts.onEvent({ type: 'tool', name, detail: `${name}…` });
        const toolResult = await executeAgentTool(name, call.function.arguments || '{}');
        opts.onEvent({
          type: 'tool',
          name,
          detail: `${name}\n${toolResult.slice(0, 1200)}`,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
        });
      }
      continue;
    }

    const text = result.content || '（无文本回复）';
    opts.onEvent({ type: 'assistant', text });
    opts.onEvent({ type: 'done', summary: '完成。' });
    return;
  }

  opts.onEvent({
    type: 'done',
    summary: `已达 Ask 只读工具步数上限（${maxSteps}，设置 su.ask.maxSteps）。可改用 Agent 继续深入。`,
  });
}
