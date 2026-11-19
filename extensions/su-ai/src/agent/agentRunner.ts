import * as vscode from 'vscode';
import {
  completeChatWithTools,
  type ChatContentPart,
  type ChatMessage,
} from '../openaiClient';
import { SU_REPLY_FORMAT_HINT } from '../chat/replyMarkdown';
import { DiffReviewService } from './diffReview';
import { buildAgentTools, executeAgentTool } from './tools';

export interface AgentRunOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Plain text or multimodal parts (vision) for the current user turn. */
  userContent: string | ChatContentPart[];
  /** Extra system fragments (e.g. selected Skills). */
  systemExtras?: string[];
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
 * Current-turn user content may include images (OpenAI vision parts).
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  const maxSteps = Math.min(30, Math.max(1, cfg.get<number>('agent.maxSteps', 12) || 12));
  const enableTerminal = cfg.get<boolean>('agent.enableTerminal', true);
  const tools = buildAgentTools(enableTerminal);

  const systemParts = [
    'You are Su Agent inside the su editor. You can inspect and edit files in the workspace using tools. ' +
      'Prefer replace_in_file for small edits. After tools finish, summarize what you changed. ' +
      'You may receive images in the user message; read them (UI screenshots, error dialogs, diagrams) and use that information when planning tool calls. ' +
      'A read-only workspace snapshot (git branches/paths) may be injected — use it first for questions like "current branch". ' +
      'If you need a live check, call run_terminal (the user will see a permission dialog; read-only git may be allowed for the rest of the session). ' +
      'Reply in the user\'s language. Do not claim you lack filesystem access or that you ran commands the user skipped. ' +
      SU_REPLY_FORMAT_HINT +
      ' After tools finish, end with a brief summary of changes and any verification or next steps.',
    ...(opts.systemExtras || []),
  ];

  const historyMsgs = opts.history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => typeof m.content === 'string' || m.content === null)
    .slice(-20);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemParts.join('\n\n'),
    },
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
        const toolName = call.function.name;
        opts.onEvent({ type: 'tool', name: toolName, detail: `${toolName}…` });
        const toolResult = await executeAgentTool(
          toolName,
          call.function.arguments || '{}',
          opts.diffs,
        );
        opts.onEvent({
          type: 'tool',
          name: toolName,
          detail: `${toolName}\n${toolResult.slice(0, 1200)}`,
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
