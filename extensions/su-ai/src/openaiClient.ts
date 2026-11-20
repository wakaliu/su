/** OpenAI-compatible multimodal content part (text + image_url). */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain string or multimodal parts (vision). */
  content: string | null | ChatContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
}

export interface CompleteChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ToolChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolChatResult {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason?: string;
}

/**
 * Joins OpenAI-compatible base URL with a relative API path.
 */
export function joinApiUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = pathPart.replace(/^\/+/, '');
  return `${base}/${path}`;
}

/**
 * Maps fetch AbortError to用户停止 vs 请求超时 (timer abort must not look like Esc).
 */
function throwIfAborted(
  e: unknown,
  opts: { signal?: AbortSignal; timeoutMs: number; timedOut: () => boolean },
): never {
  if (opts.signal?.aborted) {
    throw new Error('已停止生成');
  }
  if (opts.timedOut() || (e instanceof Error && e.name === 'AbortError')) {
    const sec = Math.max(1, Math.round(opts.timeoutMs / 1000));
    throw new Error(
      `请求超时（${sec}s）。请检查中转/网络，或增大设置 su.timeoutMs 后重试。`,
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}

/**
 * Non-streaming chat.completions — used for short Ghost Text completions.
 */
export async function completeChat(opts: CompleteChatOptions): Promise<string> {
  if (!opts.apiKey) {
    throw new Error('未配置 API Key。请运行「Su: 设置 API Key」。');
  }
  if (!opts.baseUrl) {
    throw new Error('未配置 Base URL（su.baseUrl）。');
  }

  const url = joinApiUrl(opts.baseUrl, 'chat/completions');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Math.max(1000, opts.timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        max_tokens: opts.maxTokens ?? 128,
        temperature: opts.temperature ?? 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(formatHttpError(res.status, body));
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (json.error?.message) {
      throw new Error(json.error.message);
    }
    return (json.choices?.[0]?.message?.content || '').trimEnd();
  } catch (e) {
    return throwIfAborted(e, { signal: opts.signal, timeoutMs, timedOut: () => timedOut });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Non-streaming chat.completions with tools (Agent loop step).
 */
export async function completeChatWithTools(opts: ToolChatOptions): Promise<ToolChatResult> {
  if (!opts.apiKey) {
    throw new Error('未配置 API Key。请运行「Su: 设置 API Key」。');
  }
  if (!opts.baseUrl) {
    throw new Error('未配置 Base URL（su.baseUrl）。');
  }

  const url = joinApiUrl(opts.baseUrl, 'chat/completions');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Math.max(1000, opts.timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: 'auto',
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(formatHttpError(res.status, body));
    }

    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      error?: { message?: string };
    };
    if (json.error?.message) {
      throw new Error(json.error.message);
    }
    const msg = json.choices?.[0]?.message;
    return {
      content: (msg?.content || '').trim(),
      tool_calls: msg?.tool_calls,
      finish_reason: json.choices?.[0]?.finish_reason,
    };
  } catch (e) {
    return throwIfAborted(e, { signal: opts.signal, timeoutMs, timedOut: () => timedOut });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Streams an OpenAI-compatible chat.completions response (SSE) and invokes onDelta for each token.
 * Throws Error with a readable message on HTTP / network / abort failures.
 */
export async function streamChatCompletion(opts: StreamChatOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new Error('未配置 API Key。请运行「Su: 设置 API Key」。');
  }
  if (!opts.baseUrl) {
    throw new Error('未配置 Base URL（su.baseUrl）。');
  }

  const url = joinApiUrl(opts.baseUrl, 'chat/completions');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Math.max(1000, opts.timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(formatHttpError(res.status, body));
    }
    if (!res.body) {
      throw new Error('响应无 body（中转可能不支持 stream）。');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';

      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) {
          continue;
        }
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            error?: { message?: string };
          };
          if (json.error?.message) {
            throw new Error(json.error.message);
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            opts.onDelta(delta);
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            continue;
          }
          throw e;
        }
      }
    }
  } catch (e) {
    return throwIfAborted(e, { signal: opts.signal, timeoutMs, timedOut: () => timedOut });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function formatHttpError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (status === 401 || status === 403) {
    return `鉴权失败 HTTP ${status}${snippet ? `: ${snippet}` : '（请检查 API Key / 中转权限）'}`;
  }
  if (status === 404) {
    return `接口不存在 HTTP 404（请确认 su.baseUrl 含 /v1，且支持 chat/completions）`;
  }
  if (status === 429) {
    return `请求过于频繁 HTTP 429${snippet ? `: ${snippet}` : ''}`;
  }
  const visionHint = explainVisionCapabilityError(snippet);
  if (visionHint) {
    return visionHint;
  }
  return `请求失败 HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}

/**
 * Maps common upstream rejections of multimodal parts to an actionable Chinese hint.
 */
export function explainVisionCapabilityError(raw: string): string | undefined {
  const s = (raw || '').toLowerCase();
  const onlyTextAllowed =
    (s.includes('取值范围') && (s.includes("['text']") || s.includes('["text"]') || s.includes('[text]'))) ||
    (s.includes('type') && s.includes('非法') && s.includes('text'));
  const mentionsImage =
    s.includes('image_url') || s.includes('image') || s.includes('multimodal') || s.includes('vision');
  const rejectsCapability =
    s.includes('not support') ||
    s.includes('unsupported') ||
    s.includes('does not support') ||
    s.includes('不支持');
  if (!onlyTextAllowed && !(mentionsImage && (rejectsCapability || s.includes('非法') || s.includes('invalid')))) {
    return undefined;
  }
  return (
    '当前模型/中转不支持图片（仅接受文本 content）。' +
    '请在下拉框改选带视觉能力的模型（如 glm-4v、gpt-4o），或先移除图片再发送。'
  );
}

/**
 * Rewrites LLM errors when the user turn included images.
 */
export function friendlyChatError(message: string, opts?: { hadImages?: boolean }): string {
  const vision = explainVisionCapabilityError(message);
  if (vision) {
    return vision;
  }
  if (opts?.hadImages && /HTTP\s*400/i.test(message)) {
    return (
      `${message}\n` +
      '若本轮带了图片：请确认所选模型支持视觉（glm-5.x 等纯文本模型通常不行），或换 glm-4v / gpt-4o。'
    );
  }
  return message;
}
