import * as vscode from 'vscode';
import { completeChatWithTools, type ChatContentPart, type ChatMessage } from '../openaiClient';
import { SU_REPLY_FORMAT_HINT } from '../chat/replyMarkdown';
import { DiffReviewService } from './diffReview';
import { ProgressGuard } from './progressGuard';
import { buildAgentTools, executeAgentTool, USER_FEEDBACK_ABORTED, USER_FEEDBACK_STOP } from './tools';

export type AgentPhase = 'starting' | 'inspecting' | 'planning' | 'editing' | 'verifying' | 'waiting_user' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentEndReason = 'completed' | 'max_steps' | 'max_auto_continues' | 'no_progress' | 'repeated_tool_calls' | 'timeout' | 'user_stopped' | 'waiting_user' | 'error';
export interface AgentProgress { phase: AgentPhase; round: number; toolSteps: number; summary: string; currentPath?: string; planStep?: string; elapsedMs?: number; pendingDiffs?: number; }

export interface AgentRunOptions {
  baseUrl: string; apiKey: string; model: string; timeoutMs: number;
  userContent: string | ChatContentPart[]; systemExtras?: string[]; history: ChatMessage[];
  signal?: AbortSignal; diffs: DiffReviewService; onEvent: (ev: AgentEvent) => void; continueUntilDone?: boolean;
}
export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'progress'; text: string; progress?: AgentProgress }
  | { type: 'done'; summary: string; reason?: AgentEndReason; progress?: AgentProgress };

const PLAN_CONTINUE_SYSTEM = 'You are executing an approved user plan. Keep calling tools until every plan step and acceptance criterion is finished. Do not stop for Keep/Reject or for the user to type 继续. Only stop when the plan is done, blocked on ask_user(kind=choice), or cancelled. When fully done, say clearly that the plan is complete.';

export function looksLikeTaskComplete(text: string): boolean {
  const done = /全部完成|计划已完成|所有步骤已|验收(标准)?(均已|已)?满足|已完成(本|整份)?计划|task complete|all steps (are )?done|plan (is )?complete/i.test(text || '');
  return done && !/下一步|待继续|尚未|还剩|部分完成|先到这里|请(你)?继续|输入.?继续|未完成|剩余步骤/i.test(text || '');
}
export function looksLikePausedForUser(text: string): boolean { return /请(你)?继续|输入.?继续|说.?继续|等你(确认|Keep|审阅|回复)|先到这里|本轮先|部分完成|尚未完成|还剩|要我继续/i.test(text || ''); }

export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('su');
  const configuredSteps = cfg.get<number>('agent.maxSteps', 0);
  const maxSteps = configuredSteps > 0 ? Math.min(10000, Math.max(1, configuredSteps)) : Number.POSITIVE_INFINITY;
  const maxAutoContinues = Math.min(20, Math.max(0, cfg.get<number>('agent.maxAutoContinues', 8) || 8));
  const maxNoProgressRounds = Math.min(20, Math.max(1, cfg.get<number>('agent.maxNoProgressRounds', 3) || 3));
  const guard = new ProgressGuard({ maxNoProgressRounds, detectRepeatedTools: cfg.get<boolean>('agent.detectRepeatedTools', true) });
  const tools = buildAgentTools(cfg.get<boolean>('agent.enableTerminal', true));
  const system = ['You are Su Agent inside the su editor. Inspect and edit only inside the workspace. Use replace_in_file for small edits. Terminal commands require user confirmation. Keep calling tools until the request is fully done. Keep/Reject is asynchronous. Reply in the user language. ' + SU_REPLY_FORMAT_HINT, ...(opts.continueUntilDone ? [PLAN_CONTINUE_SYSTEM] : []), ...(opts.systemExtras || [])].join('\n\n');
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...opts.history.filter((m) => (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || m.content === null)).slice(-20), { role: 'user', content: opts.userContent }];
  const timeoutSec = Math.max(1, Math.round(opts.timeoutMs / 1000));
  let autoContinues = 0, toolSteps = 0, toolsUsed = false;
  const progress = (phase: AgentPhase, round: number, summary: string): AgentProgress => ({ phase, round, toolSteps, summary, elapsedMs: 0, pendingDiffs: opts.diffs.size });

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) throw new Error('已停止生成');
    const started = Date.now();
    opts.onEvent({ type: 'progress', text: `${step ? '继续推理' : '正在思考 / 等待模型'} · 第 ${step + 1} 轮 · 工具步骤 ${toolSteps}（本轮最长 ${timeoutSec}s）`, progress: progress(step ? 'planning' : 'starting', step + 1, '等待模型响应') });
    const heartbeat = setInterval(() => { if (!opts.signal?.aborted) { const sec = Math.max(1, Math.round((Date.now() - started) / 1000)); const slow = sec > 120 ? ' · 仍在等待模型，可停止本轮' : sec > 30 ? ' · 模型响应较慢' : ''; opts.onEvent({ type: 'progress', text: `${step ? '继续推理' : '正在思考 / 等待模型'} · 第 ${step + 1} 轮 · 已等待 ${sec}s / ${timeoutSec}s${slow} · 工具步骤 ${toolSteps} · 待审 Diff ${opts.diffs.size}`,  progress: { ...progress('planning', step + 1, '等待模型响应'), elapsedMs: Date.now() - started } }); } }, 5000);
    let result: Awaited<ReturnType<typeof completeChatWithTools>>;
    try { result = await completeChatWithTools({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.model, timeoutMs: opts.timeoutMs, messages, tools, signal: opts.signal }); } finally { clearInterval(heartbeat); }
    if (result.tool_calls?.length) {
      toolsUsed = true; messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.tool_calls });
      for (const call of result.tool_calls) {
        if (opts.signal?.aborted) throw new Error('已停止生成');
        toolSteps++; const name = call.function.name; const args = call.function.arguments || '{}'; opts.onEvent({ type: 'tool', name, detail: `${name}…` });
        const output = await executeAgentTool(name, args, opts.diffs);
        const guardResult = guard.observe({ name, args, result: output, changed: /^(write_file|replace_in_file)$/.test(name) && !/^ERROR:/i.test(output) });
        opts.onEvent({ type: 'tool', name, detail: `${name}${guardResult.repeated ? ' · 检测到重复调用' : ''}\n${output.slice(0, 1200)}` });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        if (output.includes(USER_FEEDBACK_ABORTED) || opts.signal?.aborted) throw new Error('已停止生成');
        if (output.includes(USER_FEEDBACK_STOP)) { opts.onEvent({ type: 'assistant', text: '好的，已结束（未执行建议操作）。' }); opts.onEvent({ type: 'done', summary: '用户关闭建议卡片，任务结束。', reason: 'waiting_user' }); return; }
        if (guardResult.noProgress) { opts.onEvent({ type: 'progress', text: `检测到连续 ${maxNoProgressRounds} 轮无有效进展，已暂停；已有改动已保留。`, progress: progress('paused', step + 1, '重复操作或无进展') }); opts.onEvent({ type: 'done', summary: '任务已暂停：检测到重复操作或无有效进展。', reason: 'no_progress' }); return; }
      }
      continue;
    }
    const text = result.content || '（无文本回复）';
    const nudge = !!opts.continueUntilDone && autoContinues < maxAutoContinues && toolsUsed && !looksLikeTaskComplete(text) && (looksLikePausedForUser(text) || opts.diffs.size > 0 || autoContinues === 0);
    if (nudge) { autoContinues++; messages.push({ role: 'assistant', content: text }, { role: 'user', content: '请继续执行剩余步骤与验收项，不要等待继续或 Keep/Reject，完成后明确说明计划已完成。' }); opts.onEvent({ type: 'assistant', text: `${text}\n\n---` }); opts.onEvent({ type: 'progress', text: `计划尚未完成，自动继续（${autoContinues}/${maxAutoContinues}）…` }); continue; }
    opts.onEvent({ type: 'assistant', text }); opts.onEvent({ type: 'done', summary: opts.diffs.size ? `完成。有 ${opts.diffs.size} 个文件待 Keep/Reject。` : '完成。', reason: 'completed', progress: progress('completed', step + 1, '任务完成') }); return;
  }
  opts.onEvent({ type: 'done', summary: `已暂停：达到最大工具步数（${maxSteps}），已有改动已保留。`, reason: 'max_steps', progress: progress('paused', 0, '达到工具步数上限') });
}
