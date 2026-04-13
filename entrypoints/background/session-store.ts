// Background-only session store.
// Sole writer to Dexie DB — eliminates write conflicts from multiple sidepanels.

import {
  createSession,
  getSession,
  listSessions,
  updateSessionMessages,
  deleteSession,
  ThrottledSessionWriter,
  type SessionRecord,
} from '@/lib/db';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

class SessionStore {
  private writers = new Map<string, ThrottledSessionWriter>();

  async create(session: SessionRecord): Promise<void> {
    await createSession(session);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    return getSession(id);
  }

  async list(): Promise<Omit<SessionRecord, 'messages'>[]> {
    const all = await listSessions();
    return all.map(({ messages, ...rest }) => rest);
  }

  async delete(id: string): Promise<void> {
    await deleteSession(id);
    this.disposeWriter(id);
  }

  scheduleWrite(id: string, messages: AgentMessage[]): void {
    let writer = this.writers.get(id);
    if (!writer) {
      writer = new ThrottledSessionWriter();
      this.writers.set(id, writer);
    }
    writer.schedule(id, messages);
  }

  async flush(id: string): Promise<void> {
    const writer = this.writers.get(id);
    if (writer) await writer.flush();
  }

  private disposeWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer) {
      writer.dispose();
      this.writers.delete(id);
    }
  }
}

export const sessionStore = new SessionStore();
