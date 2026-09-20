export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

/**
 * Joins OpenAI-compatible base URL with a relative API path.
 */
export function joinApiUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = pathPart.replace(/^\/+/, '');
  return `${base}/${path}`;
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

  const timer = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));

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
    if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
      throw new Error('已停止生成');
    }
    throw e instanceof Error ? e : new Error(String(e));
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
  return `请求失败 HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}
