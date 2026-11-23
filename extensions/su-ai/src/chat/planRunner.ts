import * as vscode from 'vscode';
import {
  completeChatWithTools,
  type ChatContentPart,
  type ChatMessage,
} from '../openaiClient';
import { buildReadonlyTools, executeAgentTool } from '../agent/tools';
import { PLAN_SYSTEM_PROMPT } from './plan';
import { SU_REPLY_FORMAT_HINT } from './replyMarkdown';

export interface PlanRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  userContent: string | ChatContentPart[];
  systemExtras?: string[];
  history: ChatMessage[];
  signal?: AbortSignal;
  onEvent: (ev: PlanEvent) => void;
}

export type PlanEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'progress'; text: string }
  | { type: 'done'; summary: string };

/**
 * Plan-mode tool loop: list_dir / read_file only; emits discussion or a <su-plan> document.
 */
export async function runPlanWithTools(opts: PlanRunOptions): Promise<void> {
  const tools = buildReadonlyTools();
  const cfg = vscode.workspace.getConfiguration('su');
  const maxSteps = Math.min(500, Math.max(1, cfg.get<number>('ask.maxSteps', 100) || 100));

  const systemParts = [
    PLAN_SYSTEM_PROMPT,
    SU_REPLY_FORMAT_HINT,
    'A workspace snapshot may be injected below — use it and tools; do not invent paths.',
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
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      throw new Error('已停止生成');
    }

    const startedAt = Date.now();
    opts.onEvent({
      type: 'progress',
      text:
        step === 0
          ? `Plan：正在思考…（本轮最长 ${timeoutSec}s）`
          : `Plan：继续推理 · 第 ${step + 1} 轮…`,
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
            ? `Plan：正在思考… 已等待 ${sec}s / ${timeoutSec}s`
            : `Plan：第 ${step + 1} 轮… 已等待 ${sec}s / ${timeoutSec}s`,
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
            content: `ERROR: Plan mode only allows list_dir / read_file (got ${name})`,
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
    opts.onEvent({ type: 'done', summary: 'Plan 轮次完成。' });
    return;
  }

  opts.onEvent({
    type: 'done',
    summary: `已达 Plan 只读工具步数上限（${maxSteps}）。可缩小范围或改用 Agent。`,
  });
}
