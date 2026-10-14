import type { ChatMessage } from '../openaiClient';

/** Max messages kept per session for API context + persistence. */
export const MAX_SESSION_MESSAGES = 40;
/** Max stored chat sessions (oldest non-active dropped). */
export const MAX_SESSIONS = 30;

export type ChatMode = 'chat' | 'agent';

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  mode: ChatMode;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  activeId: string;
  sessions: ChatSession[];
}

export const SESSIONS_KEY = 'su.chat.sessions';
/** Legacy single-thread history (migrated once into sessions). */
export const LEGACY_HISTORY_KEY = 'su.chat.history';

/**
 * Creates an empty session with a fresh id.
 */
export function createEmptySession(mode: ChatMode = 'chat'): ChatSession {
  const now = Date.now();
  return {
    id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    messages: [],
    mode,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Derives a short title from the first user message.
 */
export function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim(),
  );
  if (!first || typeof first.content !== 'string') {
    return '新对话';
  }
  const line = first.content.trim().split(/\r?\n/)[0] || '新对话';
  const cleaned = line.replace(/```[\s\S]*$/, '').trim() || line.trim();
  return cleaned.length > 36 ? `${cleaned.slice(0, 36)}…` : cleaned;
}

/**
 * Keeps only user/assistant text messages, capped per session.
 */
export function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0,
    )
    .slice(-MAX_SESSION_MESSAGES);
}

/**
 * Normalizes store shape and enforces session cap.
 */
export function normalizeStore(raw: SessionStore | undefined, fallbackMode: ChatMode = 'chat'): SessionStore {
  if (!raw || !Array.isArray(raw.sessions) || raw.sessions.length === 0) {
    const s = createEmptySession(fallbackMode);
    return { activeId: s.id, sessions: [s] };
  }
  const sessions = raw.sessions
    .filter((s) => s && typeof s.id === 'string')
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : '新对话',
      messages: trimMessages(Array.isArray(s.messages) ? s.messages : []),
      mode: s.mode === 'agent' ? ('agent' as const) : ('chat' as const),
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);

  if (!sessions.length) {
    const s = createEmptySession(fallbackMode);
    return { activeId: s.id, sessions: [s] };
  }
  const activeId = sessions.some((s) => s.id === raw.activeId) ? raw.activeId : sessions[0].id;
  return { activeId, sessions };
}

/**
 * Summary rows for the history panel (no full message bodies).
 */
export function sessionSummaries(store: SessionStore): Array<{
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  active: boolean;
}> {
  return store.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    active: s.id === store.activeId,
  }));
}
