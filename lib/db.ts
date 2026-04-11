import Dexie, { type EntityTable } from 'dexie';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

// ─── Schema ───

export interface ConversationRecord {
  id: string;
  title: string;
  model: string;
  provider: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id?: number;
  conversationId: string;
  message: AgentMessage;
  timestamp: number;
}

// ─── Database ───

const db = new Dexie('cebian') as Dexie & {
  conversations: EntityTable<ConversationRecord, 'id'>;
  messages: EntityTable<MessageRecord, 'id'>;
};

db.version(1).stores({
  conversations: 'id, updatedAt',
  messages: '++id, conversationId, timestamp',
});

// ─── Conversations ───

export async function createConversation(
  id: string,
  title: string,
  model: string,
  provider: string,
): Promise<void> {
  const now = Date.now();
  await db.conversations.add({ id, title, model, provider, createdAt: now, updatedAt: now });
}

export async function getConversation(id: string): Promise<ConversationRecord | undefined> {
  return db.conversations.get(id);
}

export async function listConversations(): Promise<ConversationRecord[]> {
  return db.conversations.orderBy('updatedAt').reverse().toArray();
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<ConversationRecord, 'title' | 'model' | 'provider'>>,
): Promise<void> {
  await db.conversations.update(id, { ...updates, updatedAt: Date.now() });
}

export async function deleteConversation(id: string): Promise<void> {
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(id).delete();
    await db.conversations.delete(id);
  });
}

// ─── Messages ───

export async function saveMessage(conversationId: string, message: AgentMessage): Promise<void> {
  const ts = 'timestamp' in message && typeof (message as { timestamp: unknown }).timestamp === 'number'
    ? (message as { timestamp: number }).timestamp
    : Date.now();
  await db.messages.add({ conversationId, message, timestamp: ts });
  await db.conversations.update(conversationId, { updatedAt: Date.now() });
}

export async function getMessages(conversationId: string): Promise<AgentMessage[]> {
  const records = await db.messages
    .where('conversationId')
    .equals(conversationId)
    .sortBy('timestamp');
  return records.map(r => r.message);
}

export async function clearMessages(conversationId: string): Promise<void> {
  await db.messages.where('conversationId').equals(conversationId).delete();
}
