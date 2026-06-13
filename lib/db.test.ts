import { describe, it, expect } from 'vitest';
import { toSessionRecord, isValidSessionLike, type SessionRecordLike } from '@/lib/db';

const base: SessionRecordLike = {
  id: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
  createdAt: 1000,
  updatedAt: 2000,
  messages: [{ role: 'user' }, { role: 'assistant' }] as unknown[],
};

describe('isValidSessionLike', () => {
  it('关键字段齐全 + messages 元素是对象 → 通过', () => {
    expect(isValidSessionLike(base)).toBe(true);
    expect(isValidSessionLike({ ...base, messages: [] })).toBe(true);
  });

  it('id 非 UUID / 时间非有限数 → 拒绝', () => {
    expect(isValidSessionLike({ ...base, id: 'not-a-uuid' })).toBe(false);
    expect(isValidSessionLike({ ...base, createdAt: NaN })).toBe(false);
    expect(isValidSessionLike({ ...base, updatedAt: 'x' })).toBe(false);
  });

  it('messages 非数组 → 拒绝', () => {
    expect(isValidSessionLike({ ...base, messages: 'nope' })).toBe(false);
  });

  it('messages 含 null / 原始值元素 → 拒绝（防渲染器解引用 msg.role 崩溃）', () => {
    expect(isValidSessionLike({ ...base, messages: [null] })).toBe(false);
    expect(isValidSessionLike({ ...base, messages: [{ role: 'user' }, 'oops'] })).toBe(false);
    expect(isValidSessionLike({ ...base, messages: [42] })).toBe(false);
  });

  it('非对象输入 → 拒绝', () => {
    expect(isValidSessionLike(null)).toBe(false);
    expect(isValidSessionLike('x')).toBe(false);
  });
});

describe('toSessionRecord', () => {
  it('完整记录原样保留（messageCount 仍按 messages 重算）', () => {
    const out = toSessionRecord({
      ...base,
      // 下列字段经 cast 进来，模拟备份里带的完整记录。
      ...({
        title: 'Hi',
        model: 'gpt',
        provider: 'openai',
        userInstructions: 'be brief',
        thinkingLevel: 'high',
        messageCount: 999, // 故意错的缓存值
      } as object),
    } as SessionRecordLike);
    expect(out.title).toBe('Hi');
    expect(out.model).toBe('gpt');
    expect(out.provider).toBe('openai');
    expect(out.userInstructions).toBe('be brief');
    expect(out.thinkingLevel).toBe('high');
    // 不信备份的 messageCount，重算 = messages.length。
    expect(out.messageCount).toBe(2);
  });

  it('描述字段缺失 → 补安全默认（thinkingLevel 默认 medium，其余空串）', () => {
    const out = toSessionRecord({ ...base });
    expect(out.title).toBe('');
    expect(out.model).toBe('');
    expect(out.provider).toBe('');
    expect(out.userInstructions).toBe('');
    expect(out.thinkingLevel).toBe('medium');
    expect(out.messageCount).toBe(2);
  });

  it('描述字段类型不对 → 当缺失处理、补默认（不抛错）', () => {
    const out = toSessionRecord({
      ...base,
      ...({ title: 123, model: null, thinkingLevel: {} } as object),
    } as SessionRecordLike);
    expect(out.title).toBe('');
    expect(out.model).toBe('');
    expect(out.thinkingLevel).toBe('medium');
  });

  it('messageCount 永远等于 messages.length（空消息 → 0）', () => {
    const out = toSessionRecord({ ...base, messages: [] });
    expect(out.messageCount).toBe(0);
  });

  it('身份 / 时间字段原样透传，messages 引用不变', () => {
    const out = toSessionRecord({ ...base });
    expect(out.id).toBe(base.id);
    expect(out.createdAt).toBe(1000);
    expect(out.updatedAt).toBe(2000);
    expect(out.messages).toBe(base.messages);
  });
});
