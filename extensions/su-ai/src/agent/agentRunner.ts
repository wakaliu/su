import * as vscode from 'vscode';
import { completeChatWithTools, type ChatMessage } from '../openaiClient';
import { DiffReviewService } from './diffReview';
import { buildAgentTools, executeAgentTool } from './tools';

export interface AgentRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  userText: string;
  history: ChatMessage[];
  signal?: AbortSignal;
  diffs: DiffReviewService;
  onEvent: (ev: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'done'; summary: string };

/**
 * Runs a tool-calling Agent loop against an OpenAI-compatible endpoint.
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  const maxSteps = Math.min(30, Math.max(1, cfg.get<number>('agent.maxSteps', 12) || 12));
  const enableTerminal = cfg.get<boolean>('agent.enableTerminal', true);
  const tools = buildAgentTools(enableTerminal);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are Su Agent inside the su editor. You can inspect and edit files in the workspace using tools. ' +
        'Prefer replace_in_file for small edits. After tools finish, summarize what you changed. ' +
        'Reply in the user\'s language. Do not claim you ran commands the user skipped.',
    },
    ...opts.history.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-20),
    { role: 'user', content: opts.userText },
  ];

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      throw new Error('已停止生成');
    }

    const result = await completeChatWithTools({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
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
        opts.onEvent({
          type: 'tool',
          name: call.function.name,
          detail: `调用 ${call.function.name}…`,
        });
        const toolResult = await executeAgentTool(
          call.function.name,
          call.function.arguments || '{}',
          opts.diffs,
        );
        opts.onEvent({
          type: 'tool',
          name: call.function.name,
          detail: toolResult.slice(0, 400),
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
    opts.onEvent({
      type: 'done',
      summary:
        opts.diffs.size > 0
          ? `完成。有 ${opts.diffs.size} 个文件待 Keep/Reject（命令：Su: 审阅 Agent 改动）。`
          : '完成。',
    });
    return;
  }

  opts.onEvent({
    type: 'done',
    summary: `已达最大工具步数（${maxSteps}）。可提高 su.agent.maxSteps 后重试。`,
  });
}
