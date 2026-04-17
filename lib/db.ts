import Dexie, { type EntityTable } from 'dexie';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

// ─── Schema ───

export interface SessionRecord {
  id: string;
  title: string;
  model: string;
  provider: string;
  userInstructions: string;
  thinkingLevel: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
}

// ─── Database ───

const db = new Dexie('cebian') as Dexie & {
  sessions: EntityTable<SessionRecord, 'id'>;
};

db.version(1).stores({
  sessions: 'id, updatedAt',
});

// ─── Session CRUD ───

export async function createSession(session: SessionRecord): Promise<void> {
  await db.sessions.add(session);
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return db.sessions.get(id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function updateSessionMessages(
  id: string,
  messages: AgentMessage[],
): Promise<void> {
  // Aggregate usage from assistant messages
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  for (const msg of messages) {
    if ('role' in msg && msg.role === 'assistant') {
      const am = msg as AssistantMessage;
      if (am.usage) {
        totalInputTokens += am.usage.input ?? 0;
        totalOutputTokens += am.usage.output ?? 0;
        totalCost += am.usage.cost?.total ?? 0;
      }
    }
  }

  await db.sessions.update(id, {
    messages,
    messageCount: messages.length,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
    updatedAt: Date.now(),
  });
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await db.sessions.update(id, { title, updatedAt: Date.now() });
}

export async function deleteSession(id: string): Promise<void> {
  await db.sessions.delete(id);
}

// ─── Throttled writer ───

export class ThrottledSessionWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { id: string; messages: AgentMessage[] } | null = null;

  constructor(private delayMs = 3000) {}

  schedule(id: string, messages: AgentMessage[]): void {
    this.pending = { id, messages: [...messages] };
    if (this.timer) return; // Already scheduled
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const { id, messages } = this.pending;
      this.pending = null;
      await updateSessionMessages(id, messages);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
