import * as vscode from 'vscode';
import {
  completeChatWithTools,
  type ChatContentPart,
  type ChatMessage,
} from '../openaiClient';
import { SU_REPLY_FORMAT_HINT } from '../chat/replyMarkdown';
import { DiffReviewService } from './diffReview';
import {
  buildAgentTools,
  executeAgentTool,
  USER_FEEDBACK_ABORTED,
  USER_FEEDBACK_STOP,
} from './tools';

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
  /**
   * Plan Build / long tasks: if the model stops mid-work with a text reply,
   * nudge and keep the tool loop going instead of waiting for the user to type 继续.
   */
  continueUntilDone?: boolean;
}

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; detail: string }
  /** Live status while waiting on the model (no tool yet). */
  | { type: 'progress'; text: string }
  | { type: 'done'; summary: string };

const MAX_AUTO_CONTINUES = 8;

const PLAN_CONTINUE_SYSTEM =
  'You are executing an approved user plan. Keep calling tools until every plan step and acceptance criterion is finished. ' +
  'Do not stop after a partial batch to wait for Keep/Reject or for the user to type 继续 — Keep/Reject is asynchronous and does not block you. ' +
  'Only stop when the whole plan is done, you are blocked on ask_user(kind=choice), or the user cancels. ' +
  'When fully done, say clearly that the plan is complete.';

/**
 * True when the assistant text claims the overall task/plan is finished.
 */
export function looksLikeTaskComplete(text: string): boolean {
  const t = text || '';
  const done =
    /全部完成|计划已完成|所有步骤已|验收(标准)?(均已|已)?满足|已完成(本|整份)?计划|task complete|all steps (are )?done|plan (is )?complete/i.test(
      t,
    );
  const still =
    /下一步|待继续|尚未|还剩|部分完成|先到这里|请(你)?继续|输入.?继续|未完成|剩余步骤/i.test(t);
  return done && !still;
}

/**
 * True when the assistant is parking and expecting the user to say 继续 / review first.
 */
export function looksLikePausedForUser(text: string): boolean {
  return /请(你)?继续|输入.?继续|说.?继续|下一步(再|我)|等你(确认|Keep|审阅|回复)|先到这里|本轮先|部分完成|尚未完成|还剩|接下来你(可以|再)|如果需要.*继续|要我继续/i.test(
    text || '',
  );
}

/**
 * Runs a tool-calling Agent loop against an OpenAI-compatible endpoint.
 * Current-turn user content may include images (OpenAI vision parts).
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  // 0 (default) = unlimited; positive values optionally cap a runaway tool loop.
  const configuredSteps = cfg.get<number>('agent.maxSteps', 0);
  const maxSteps =
    !configuredSteps || configuredSteps <= 0
      ? Number.POSITIVE_INFINITY
      : Math.min(10_000, Math.max(1, configuredSteps));
  const enableTerminal = cfg.get<boolean>('agent.enableTerminal', true);
  const tools = buildAgentTools(enableTerminal);

  const systemParts = [
    'You are Su Agent inside the su editor. You can inspect and edit files in the workspace using tools. ' +
      'Prefer replace_in_file for small edits. ' +
      'You may receive images in the user message; read them (UI screenshots, error dialogs, diagrams) and use that information when planning tool calls. ' +
      'A read-only workspace snapshot (git branches/paths) may be injected — use it first for questions like "current branch". ' +
      'If you need a live check, call run_terminal (the user confirms in Chat: Allow once / Always this session / Deny). ' +
      'ask_user: use kind=choice only for real forks while doing the requested work; ' +
      'use kind=suggestion ONLY for optional follow-ups AFTER you already finished the requested work (e.g. commit). ' +
      'Never ask_user(suggestion) to ask whether you may start a task the user already asked for — just begin with tools. ' +
      'If ask_user is dismissed on choice → continue current plan without expansions; on suggestion → stop. ' +
      'Keep calling tools until the user request (or injected plan) is fully done. Do not stop mid-task to wait for Keep/Reject or for the user to type 继续 — Keep/Reject is async. ' +
      'Only pause for ask_user(choice) when a real decision blocks progress. ' +
      'Reply in the user\'s language. Do not claim you lack filesystem access or that you ran commands the user skipped. ' +
      SU_REPLY_FORMAT_HINT +
      ' When finished, end with a brief summary of changes and verification; do not list "next steps" that you could still do yourself in this turn.',
    ...(opts.continueUntilDone ? [PLAN_CONTINUE_SYSTEM] : []),
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

  // Per LLM round (not whole task). Caller supplies su.agent.timeoutMs (default 10min).
  const timeoutMs = opts.timeoutMs;
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));
  let autoContinues = 0;
  let toolsUsedThisTurn = false;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      throw new Error('已停止生成');
    }

    const startedAt = Date.now();
    opts.onEvent({
      type: 'progress',
      text:
        step === 0
          ? `正在思考 / 等待模型…（本轮最长 ${timeoutSec}s）`
          : `继续推理 · 第 ${step + 1} 轮…（本轮最长 ${timeoutSec}s）`,
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
            ? `正在思考 / 等待模型… 已等待 ${sec}s / ${timeoutSec}s`
            : `继续推理 · 第 ${step + 1} 轮… 已等待 ${sec}s / ${timeoutSec}s`,
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
      toolsUsedThisTurn = true;
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

        if (toolResult.includes(USER_FEEDBACK_ABORTED) || opts.signal?.aborted) {
          throw new Error('已停止生成');
        }

        if (toolResult.includes(USER_FEEDBACK_STOP)) {
          const stopText = '好的，已结束（未执行建议操作）。';
          opts.onEvent({ type: 'assistant', text: stopText });
          opts.onEvent({ type: 'done', summary: '用户关闭建议卡片，任务结束。' });
          return;
        }
      }
      continue;
    }

    const text = result.content || '（无文本回复）';
    const shouldNudge =
      !!opts.continueUntilDone &&
      autoContinues < MAX_AUTO_CONTINUES &&
      toolsUsedThisTurn &&
      !looksLikeTaskComplete(text) &&
      (looksLikePausedForUser(text) || opts.diffs.size > 0 || autoContinues === 0);

    if (shouldNudge) {
      autoContinues++;
      messages.push({ role: 'assistant', content: text });
      opts.onEvent({ type: 'assistant', text: `${text}\n\n---` });
      opts.onEvent({
        type: 'progress',
        text: `计划尚未完成，自动继续（${autoContinues}/${MAX_AUTO_CONTINUES}）…`,
      });
      messages.push({
        role: 'user',
        content:
          '请继续执行剩余步骤与验收项，不要停下来等我说「继续」或等 Keep/Reject。' +
          '用工具接着做，直到整份计划完成；完成后明确说明「计划已完成」。' +
          '仅在真正需要我抉择时才 ask_user(kind=choice)。',
      });
      continue;
    }

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
    summary: `已达最大工具步数（${maxSteps}）。可将 su.agent.maxSteps 设为 0 取消上限，或调高后重试。`,
  });
}
