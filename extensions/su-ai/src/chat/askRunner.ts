import * as vscode from 'vscode';
import {
  completeChatWithTools,
  type ChatContentPart,
  type ChatMessage,
} from '../openaiClient';
import { buildReadonlyTools, executeAgentTool } from '../agent/tools';

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
  | { type: 'done'; summary: string };

/**
 * Ask-mode tool loop: list_dir / read_file only, so Su can inspect the open project.
 */
export async function runAskWithTools(opts: AskRunOptions): Promise<void> {
  const tools = buildReadonlyTools();
  const cfg = vscode.workspace.getConfiguration('su');
  // Cap Ask tool loops so a broad "介绍项目" cannot burn unbounded list/read rounds.
  const maxSteps = Math.min(30, Math.max(1, cfg.get<number>('ask.maxSteps', 16) || 16));

  const systemParts = [
    'You are Su, a helpful coding assistant embedded in the su editor. Prefer Markdown. Reply in the user\'s language. ' +
      'You are associated with the currently open workspace. A workspace snapshot is injected below. ' +
      'You MAY call list_dir and read_file to inspect the project (README, source files, folders). ' +
      'Do NOT claim you lack permission to access the project, files, or repository. ' +
      'Do NOT invent file contents — read them. For edits or terminal commands, tell the user to switch to Agent (Ctrl+I).',
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

    const result = await completeChatWithTools({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      timeoutMs,
      messages,
      tools,
      signal: opts.signal,
    });

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
