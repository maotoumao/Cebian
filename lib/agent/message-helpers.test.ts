import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { sanitizeAgentMessages } from './message-helpers';

// 用 `as unknown as AgentMessage[]` 构造违反类型契约的运行时数据（这正是本函数要兜的场景）。
const asMessages = (arr: unknown[]) => arr as unknown as AgentMessage[];

describe('sanitizeAgentMessages', () => {
  it('把 assistant text 块的 null text 兜成空串', () => {
    const out = sanitizeAgentMessages(
      asMessages([{ role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 }]),
    );
    expect((out[0] as any).content[0].text).toBe('');
  });

  it('把 assistant thinking 块的 null thinking 兜成空串并保留同级字段', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: null, thinkingSignature: 'reasoning_content' }],
          timestamp: 1,
        },
      ]),
    );
    expect((out[0] as any).content[0].thinking).toBe('');
    expect((out[0] as any).content[0].thinkingSignature).toBe('reasoning_content');
  });

  it('把 toolCall 块的 null name 兜成空串并保留 id / arguments', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: null, arguments: { a: 1 } }], timestamp: 1 },
      ]),
    );
    expect((out[0] as any).content[0].name).toBe('');
    expect((out[0] as any).content[0].id).toBe('x');
    expect((out[0] as any).content[0].arguments).toEqual({ a: 1 });
  });

  it('把标准角色缺失的顶层 content（null / undefined）兜成空数组', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: null, timestamp: 1 },
        { role: 'user', content: undefined, timestamp: 2 },
        { role: 'toolResult', toolCallId: 't', content: null, timestamp: 3 },
      ]),
    );
    expect((out[0] as any).content).toEqual([]);
    expect((out[1] as any).content).toEqual([]);
    expect((out[2] as any).content).toEqual([]);
  });

  it('不给 compactionSummary 这类自定义消息塞 content，原样返回', () => {
    const summary = { role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([summary]));
    expect(out[0]).toBe(summary);
    expect('content' in (out[0] as any)).toBe(false);
  });

  it('字符串形式的 user content 原样返回', () => {
    const m = { role: 'user', content: 'hello', timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([m]));
    expect(out[0]).toBe(m);
  });

  it('全部干净时返回同一数组与同一消息引用（copy-on-write）', () => {
    const msgs = asMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }, { type: 'thinking', thinking: 'hmm' }], timestamp: 2 },
    ]);
    const out = sanitizeAgentMessages(msgs);
    expect(out).toBe(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });

  it('只替换出问题的消息，干净的兄弟消息保持引用', () => {
    const clean = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 };
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 2 };
    const msgs = asMessages([clean, bad]);
    const out = sanitizeAgentMessages(msgs);
    expect(out).not.toBe(msgs);
    expect(out[0]).toBe(clean);
    expect(out[1]).not.toBe(bad);
    expect((out[1] as any).content[0].text).toBe('');
  });

  it('只复制出问题的块，干净的块保持引用', () => {
    const cleanBlock = { type: 'text', text: 'ok' };
    const badBlock = { type: 'thinking', thinking: null };
    const msg = { role: 'assistant', content: [cleanBlock, badBlock], timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([msg]));
    expect((out[0] as any).content[0]).toBe(cleanBlock);
    expect((out[0] as any).content[1]).not.toBe(badBlock);
  });

  it('不改动入参（原始消息 / 块保持原值）', () => {
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 };
    sanitizeAgentMessages(asMessages([bad]));
    expect((bad.content[0] as any).text).toBe(null);
  });

  it('undefined 的 text / thinking / name 同样兜成空串', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text' }, // text 缺失
            { type: 'thinking' }, // thinking 缺失
            { type: 'toolCall', id: 'a', arguments: {} }, // name 缺失
          ],
          timestamp: 1,
        },
      ]),
    );
    expect((out[0] as any).content[0].text).toBe('');
    expect((out[0] as any).content[1].thinking).toBe('');
    expect((out[0] as any).content[2].name).toBe('');
  });

  it('image / 未知类型 / null / 原始值块一律原样保持引用', () => {
    const image = { type: 'image', data: 'd', mimeType: 'image/png' };
    const unknown = { type: 'weird', foo: 1 };
    const msg = { role: 'assistant', content: [image, unknown, null, 42], timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([msg]));
    expect(out[0]).toBe(msg); // 无任何需矫正的块 → 整条消息原样返回
    expect((out[0] as any).content[0]).toBe(image);
    expect((out[0] as any).content[1]).toBe(unknown);
    expect((out[0] as any).content[2]).toBe(null);
    expect((out[0] as any).content[3]).toBe(42);
  });

  it('只矫正 toolCall 的 name，arguments 为 null 时不动', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: null, arguments: null }], timestamp: 1 },
      ]),
    );
    expect((out[0] as any).content[0].name).toBe('');
    expect((out[0] as any).content[0].arguments).toBe(null);
  });

  it('矫正发生在中间时，其后干净的消息仍走透传分支保持引用', () => {
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 };
    const cleanTail = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 2 };
    const out = sanitizeAgentMessages(asMessages([bad, cleanTail]));
    expect(out[0]).not.toBe(bad);
    expect(out[1]).toBe(cleanTail);
  });

  it('空数组原样返回', () => {
    const msgs = asMessages([]);
    expect(sanitizeAgentMessages(msgs)).toBe(msgs);
  });
});
