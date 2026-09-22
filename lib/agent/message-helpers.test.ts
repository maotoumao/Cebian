import { describe, it, expect } from 'vitest';
import { assertJsonSerializable, type AgentMessage } from '@earendil-works/pi-agent-core';
import {
  extractSlashPrompt,
  extractUserText,
  replaceUserText,
  sanitizeAgentMessages,
  truncateForRetry,
} from './message-helpers';

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

  it('移除标准消息顶层值为 undefined 的可选字段，使其满足 durable payload 契约', () => {
    const toolResult = {
      role: 'toolResult',
      toolCallId: 't',
      toolName: 'demo',
      content: [],
      details: undefined,
      usage: undefined,
      isError: false,
      timestamp: 1,
    };
    const assistant = {
      role: 'assistant',
      content: [],
      api: 'demo-api',
      provider: 'demo',
      model: 'demo-model',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      errorMessage: undefined,
      timestamp: 2,
    };
    const out = sanitizeAgentMessages(asMessages([toolResult, assistant]));

    expect(() => assertJsonSerializable(out)).not.toThrow();
    expect(Object.hasOwn(out[0], 'details')).toBe(false);
    expect(Object.hasOwn(out[0], 'usage')).toBe(false);
    expect(Object.hasOwn(out[1], 'errorMessage')).toBe(false);
    expect(Object.hasOwn(toolResult, 'usage')).toBe(true);
    expect(Object.hasOwn(assistant, 'errorMessage')).toBe(true);
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

describe('replaceUserText', () => {
  const wrap = (text: string) => `<user-request>\n${text}\n</user-request>`;

  it('字符串 content：有 <user-request> 包裹时只换内文，兄弟块保留', () => {
    const msg = {
      role: 'user',
      content: `<attachments><attached-file name="a.txt" type="text/plain"></attached-file></attachments>\n${wrap('旧文案')}`,
      timestamp: 1,
    } as any;
    const out = replaceUserText(msg, '新文案');
    expect(out.content).toContain('<attachments>');
    expect(out.content).toContain(wrap('新文案'));
    expect(out.content).not.toContain('旧文案');
    expect(msg.content).toContain('旧文案'); // 纯函数，不改入参
  });

  it('字符串 content：无包裹（裸文本）时整体替换', () => {
    const out = replaceUserText({ role: 'user', content: '裸文本', timestamp: 1 } as any, '新');
    expect(out.content).toBe('新');
  });

  it('块数组 content：替换含 <user-request> 的 text 块，image 块原样保留', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: wrap('旧') },
        { type: 'image', data: 'xxx', mimeType: 'image/png' },
      ],
      timestamp: 1,
    } as any;
    const out = replaceUserText(msg, '新');
    expect(out.content[0].text).toBe(wrap('新'));
    expect(out.content[1]).toBe(msg.content[1]);
  });

  it('新文案含 $& / $1 等 replace 特殊模式时按字面写入', () => {
    const out = replaceUserText(
      { role: 'user', content: wrap('旧'), timestamp: 1 } as any,
      '价格是 $1，匹配 $& 保留',
    );
    expect(out.content).toContain('价格是 $1，匹配 $& 保留');
  });

  it('块数组无 text 块时追加一个', () => {
    const out = replaceUserText(
      { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], timestamp: 1 } as any,
      '新',
    );
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: 'text', text: '新' });
  });
});

// ─── 斜杠提示词块（issue #53）───

const envelope = (slashBody: string | null, request: string) =>
  [
    '<context>\nd\n</context>',
    ...(slashBody === null ? [] : [`<slash-prompt name="demo">\n${slashBody}\n</slash-prompt>`]),
    `<user-request>\n${request}\n</user-request>`,
  ].join('\n\n');

/** 这些 helper 吃的是 pi-ai 的 `Message`（与 AgentMessage 不同源），从函数签名取类型
 *  比再 import 一个类型更稳。 */
type HelperMessage = Parameters<typeof extractUserText>[0];

const userMsg = (raw: string) =>
  ({ role: 'user', content: raw, timestamp: 1 }) as unknown as HelperMessage;

describe('extractUserText / replaceUserText 与 <slash-prompt> 块共存', () => {
  it('只取用户自己敲的字，不受提示词块影响', () => {
    expect(extractUserText(userMsg(envelope('总结这页', '再翻成英文')))).toBe('再翻成英文');
  });

  // 提示词正文里已不可能出现字面量信封标签——buildSlashPromptBlock 在序列化时就剥掉了
  // （见 slash-prompt.test.ts）。因此剩下唯一可能打出这些标签的地方是用户自己敲进请求
  // 块内部的文字，外层开标签必然在它之前 —— 取「最靠前」的开标签才对。
  it('用户在请求块里打了字面量 <user-request> → 取外层，拿到完整文本', () => {
    const raw = envelope('总结这页', '解释一下 <user-request>x</user-request> 是什么');
    expect(extractUserText(userMsg(raw))).toBe('解释一下 <user-request>x</user-request> 是什么');
  });

  it('编辑这类消息只改外层请求块，不留悬空的开标签', () => {
    const raw = envelope('总结这页', '解释一下 <user-request>x</user-request> 是什么');
    const out = replaceUserText(userMsg(raw), '新请求');
    const content = out.content as unknown as string;
    expect(extractUserText(out)).toBe('新请求');
    expect(content.endsWith('<user-request>\n新请求\n</user-request>')).toBe(true);
    expect(content).toContain('<slash-prompt name="demo">');
  });

  it('编辑消息只改末尾的请求块，提示词块原样保留', () => {
    const raw = envelope('总结这页', '旧请求');
    const out = replaceUserText(userMsg(raw), '新请求');
    const content = out.content as unknown as string;
    expect(extractUserText(out)).toBe('新请求');
    expect(content).toContain('<slash-prompt name="demo">\n总结这页\n</slash-prompt>');
    expect(content).not.toContain('旧请求');
  });

  // 只挂提示词、一个字没打：请求块里那句话是写给模型的，不该出现在气泡和 ↑ 历史里。
  it('请求块只放占位句时，用户文本按空处理', () => {
    const raw = envelope('做这件事', 'Follow the instructions in the slash-prompt block above.');
    expect(extractUserText(userMsg(raw))).toBe('');
  });

  // 划词动作「在侧边栏继续」固化下来的是**没有信封包裹**的页面文本，整段都是用户的话，
  // 一个字都不能吞。
  it('裸文本原样返回，不做任何结构剥离', () => {
    const raw = '文档里写：<slash-prompt name="demo">\nbody\n</slash-prompt>，就是这样。';
    expect(extractUserText(userMsg(raw))).toBe(raw);
  });

  it('没有提示词块时，同样的句子照常当普通文本（不误伤）', () => {
    const raw = envelope(null, 'Follow the instructions in the slash-prompt block above.');
    expect(extractUserText(userMsg(raw))).toBe('Follow the instructions in the slash-prompt block above.');
  });
});

describe('extractSlashPrompt', () => {
  it('取出名字与正文；名字还原 XML 转义', () => {
    const raw = `<slash-prompt name="a&amp;b">\nline1\nline2\n</slash-prompt>\n\n<user-request>\nx\n</user-request>`;
    expect(extractSlashPrompt(userMsg(raw))).toEqual({ name: 'a&b', body: 'line1\nline2' });
  });

  it('没有块 → null', () => {
    expect(extractSlashPrompt(userMsg(envelope(null, 'x')))).toBeNull();
  });

  it('非 user 消息 → null', () => {
    const assistant = { role: 'assistant', content: '<slash-prompt name="x">y</slash-prompt>', timestamp: 1 };
    expect(extractSlashPrompt(assistant as unknown as HelperMessage)).toBeNull();
  });
});

describe('replaceUserText — 块数组形态定位末尾请求块', () => {
  it('改的是最后那个带末尾请求块的 text 块，前面的块不动', () => {
    const msg = {
      role: 'user',
      timestamp: 1,
      content: [
        { type: 'text', text: '<slash-prompt name="d">\n正文\n</slash-prompt>' },
        { type: 'text', text: '<user-request>\n旧请求\n</user-request>' },
      ],
    } as unknown as HelperMessage;
    const out = replaceUserText(msg, '新请求');
    const blocks = out.content as unknown as { text: string }[];
    expect(blocks[0].text).toBe('<slash-prompt name="d">\n正文\n</slash-prompt>');
    expect(blocks[1].text).toBe('<user-request>\n新请求\n</user-request>');
  });
});

describe('sanitizeAgentMessages · 深度', () => {
  it('保持浅层：嵌套在 details 里的 undefined 不在热路径上处理（落树边界另行 omitUndefinedDeep）', () => {
    const toolResult = {
      role: 'toolResult', toolCallId: 't', toolName: 'demo', content: [],
      details: { structured: undefined }, isError: false, timestamp: 1,
    };
    const [out] = sanitizeAgentMessages(asMessages([toolResult]));
    expect(Object.hasOwn((out as any).details, 'structured')).toBe(true);
  });
});

describe('truncateForRetry', () => {
  const user = (text: string) => ({ role: 'user', content: text });
  const assistant = (text: string) => ({ role: 'assistant', content: text });
  const summary = () => ({ role: 'compactionSummary', summary: 's' });

  it('截到最后一条 user（含），丢掉其后的 assistant / toolResult', () => {
    const messages = [user('a'), assistant('b'), user('c'), assistant('d')];
    expect(truncateForRetry(messages)).toEqual([user('a'), assistant('b'), user('c')]);
  });

  it('没有 user 消息时返回 null', () => {
    expect(truncateForRetry([assistant('a')])).toBeNull();
  });

  it('返回值必须是连续前缀：轮内压缩追加在末尾的摘要一并切掉，不做特判', () => {
    // 调用方拿 truncated.length 当树上保留的前缀长度用（回卷 lane / 裁 entryIds /
    // 压水位线），塞一条位置对不上的摘要进来会让内存转录与树彻底错位。语义上也该切：
    // retry 丢弃的是整轮，摘要摘的正是这一轮的内容。
    const messages = [user('a'), assistant('b'), summary(), assistant('c')];
    const truncated = truncateForRetry(messages);
    expect(truncated).toEqual([user('a')]);
    expect(truncated).toEqual(messages.slice(0, truncated!.length));
  });
});
