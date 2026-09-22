import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateContextTokens, estimateMessageTokens } from '@/lib/agent/context-tokens';

const user = (text: string, timestamp = 1): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp }) as AgentMessage;

const assistant = (
  text: string,
  opts: { timestamp?: number; totalTokens?: number; stopReason?: string } = {},
): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: opts.timestamp ?? 2,
    stopReason: opts.stopReason ?? 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: opts.totalTokens ?? 0,
    },
  }) as AgentMessage;

const summary = (text: string, timestamp: number): AgentMessage =>
  ({ role: 'compactionSummary', summary: text, tokensBefore: 0, timestamp }) as unknown as AgentMessage;

/** 文本估算没有单独导出，经 user 消息这条最短的公开路径验证。 */
const textTokens = (text: string) => estimateMessageTokens(user(text));

describe('宽字符分类', () => {
  it('中文按 1 字 1 token，不再按 chars/4 低估', () => {
    // 13 个汉字。pi 的 chars/4 只估出 ceil(13/4) = 4 —— 低估 3 倍多，正是 issue #72 的失真来源。
    expect(textTokens('用户让助手逐页收集内容汇总')).toBe(13);
  });

  it('英文仍按 chars/4，与 pi 同口径', () => {
    expect(textTokens('abcdefgh')).toBe(2);
  });

  it('中英混排分别计数后相加', () => {
    // 4 个汉字 = 4，'abcd' = 1。
    expect(textTokens('中文混排abcd')).toBe(5);
  });

  it('容易被漏判的 CJK 区段同样算宽字符', () => {
    // 每个都重复 4 次：只放 1 个的话，误判成窄字符后 ceil(1/4) 仍是 1，测不出来。
    const cases: Array<[string, number]> = [
      ['注音', 0x3105],
      ['注音扩展', 0x31a0],
      ['CJK 笔画', 0x31c0],
      ['康熙部首', 0x2f00],
      ['部首补充', 0x2e80],
      ['谚文字母', 0x1100],
      ['谚文兼容字母', 0x3130],
      ['谚文字母扩展 B', 0xd7b0],
      ['片假名语音扩展', 0x31f0],
      ['CJK 兼容（㎡ ℃ 一类）', 0x3300],
      ['带圈 CJK', 0x3200],
      ['竖排形式', 0xfe10],
      ['CJK 兼容形式', 0xfe30],
    ];
    for (const [name, cp] of cases) {
      expect(textTokens(String.fromCodePoint(cp).repeat(4)), name).toBe(4);
    }
  });

  it('星光平面一律算宽：emoji 与扩展 B 汉字都不再被 4 倍低估', () => {
    // pi 数 UTF-16 单元，4 个 emoji = 8 单元 = 2 token；按码点算宽后是 4，方向保守。
    expect(textTokens('😀😀😀😀')).toBe(4);
    expect(textTokens('\u{20000}\u{20001}')).toBe(2);
  });

  it('全角标点算宽，纯 ASCII 标点不算', () => {
    expect(textTokens('，。！')).toBe(3);
    expect(textTokens(',.!,')).toBe(1);
  });

  it('孤立代理项不抛，按窄字符计一个 UTF-16 单元', () => {
    expect(textTokens('\ud800\ud800\ud800\ud800')).toBe(1);
  });

  it('空串为 0', () => {
    expect(textTokens('')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  it('content 为纯字符串的形态（类型上允许）同样计入', () => {
    const msg = { role: 'user', content: '中文四字', timestamp: 1 } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it('toolResult 按内容估算 —— issue #72 的上下文膨胀主要来自它', () => {
    const msg = {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'read',
      content: [{ type: 'text', text: '抓下来的页面正文' }],
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(8);
  });

  it('图片块按固定折算计入', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(1200);
  });

  it('坏数据不抛：text 非字符串按 0 计，null 块跳过而不是当成图片', () => {
    // 历史数据里出现过 text 为 null 的消息（issue #43）。
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: null }, { type: 'text', text: 42 }, null],
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(0);
  });

  it('assistant 的 thinking 与 toolCall 参数都计入', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '思考四字' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/a' } },
      ],
      timestamp: 1,
      stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } as unknown as AgentMessage;
    // thinking 4 字 = 4；'read' = 1；'{"path":"/a"}' 13 字符 = 4。
    expect(estimateMessageTokens(msg)).toBe(9);
  });

  it('循环引用的 toolCall 参数落回 [unserializable]，不抛', () => {
    const args: Record<string, unknown> = {};
    args.self = args;
    const msg = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'x', arguments: args }],
      timestamp: 1,
      stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    } as unknown as AgentMessage;
    // 'x' = 1；'[unserializable]' 16 字符 = 4。
    expect(estimateMessageTokens(msg)).toBe(5);
  });

  it('bashExecution / branchSummary / compactionSummary 各按其正文估算', () => {
    const bash = {
      role: 'bashExecution',
      command: 'ls',
      output: '输出两字',
      timestamp: 1,
    } as unknown as AgentMessage;
    // 'ls' = 1，'输出两字' = 4。
    expect(estimateMessageTokens(bash)).toBe(5);
    expect(estimateMessageTokens(summary('摘要正文', 1))).toBe(4);
    const branch = {
      role: 'branchSummary',
      summary: '分支摘要',
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(branch)).toBe(4);
  });

  it('permissionRequest 估 0 —— 它被 convertToLlm 白名单滤掉，根本不进 LLM 视图', () => {
    const msg = {
      role: 'permissionRequest',
      toolName: 'fs_write',
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(msg)).toBe(0);
  });
});

describe('estimateContextTokens', () => {
  it('无 usage 锚点时全量估算，并计入 systemPrompt 与工具 schema', () => {
    // systemPrompt 'abcd' = 1；JSON.stringify 丢掉 execute 后是 '[{"name":"read"}]' 17 字符 = 5。
    const est = estimateContextTokens({
      messages: [user('你好')],
      systemPrompt: 'abcd',
      tools: [{ name: 'read', execute: () => {} }],
    });
    expect(est.lastUsageIndex).toBeNull();
    expect(est.tokens).toBe(8);
    expect(est.trailingTokens).toBe(8);
  });

  it('省略 systemPrompt / tools 时前缀量为 0', () => {
    expect(estimateContextTokens({ messages: [user('你好')] }).tokens).toBe(2);
  });

  it('有锚点时以真实 usage 为准，只估算锚点之后的尾巴；前缀量不再叠加', () => {
    const est = estimateContextTokens({
      messages: [user('问题', 1), assistant('回答', { timestamp: 2, totalTokens: 9_000 }), user('追问', 3)],
      systemPrompt: '很长的系统提示词'.repeat(100),
      tools: [{ name: 'read' }],
    });
    expect(est.usageTokens).toBe(9_000);
    expect(est.trailingTokens).toBe(2);
    expect(est.tokens).toBe(9_002);
    expect(est.lastUsageIndex).toBe(1);
  });

  it('跳过 aborted / error 的 assistant —— 失败的请求描述不了真实发出去的前缀', () => {
    const est = estimateContextTokens({
      messages: [
        user('问题', 1),
        assistant('回答', { timestamp: 2, totalTokens: 9_000 }),
        assistant('炸了', { timestamp: 3, totalTokens: 999_999, stopReason: 'error' }),
        assistant('停了', { timestamp: 4, totalTokens: 888_888, stopReason: 'aborted' }),
      ],
    });
    expect(est.usageTokens).toBe(9_000);
    // 失败消息本身仍计入尾部字符：'炸了' + '停了' = 4。
    expect(est.trailingTokens).toBe(4);
  });

  it('缺 usage 字段的历史消息不抛，按无锚点处理', () => {
    const broken = { role: 'assistant', content: [{ type: 'text', text: '旧数据' }], timestamp: 2, stopReason: 'stop' } as unknown as AgentMessage;
    const est = estimateContextTokens({ messages: [user('问题', 1), broken] });
    expect(est.lastUsageIndex).toBeNull();
    expect(est.tokens).toBe(5);
  });

  it('多个合法锚点取最后一个', () => {
    const est = estimateContextTokens({
      messages: [
        assistant('一', { timestamp: 1, totalTokens: 100 }),
        assistant('二', { timestamp: 2, totalTokens: 200 }),
      ],
    });
    expect(est.usageTokens).toBe(200);
    expect(est.lastUsageIndex).toBe(1);
  });

  it('totalTokens 为 0 但分项和大于零时仍是合法锚点', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: 2,
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 0 },
    } as unknown as AgentMessage;
    expect(estimateContextTokens({ messages: [msg] }).usageTokens).toBe(20);
  });

  it('时间戳相等时仍算合法锚点（判据是「不早于」）', () => {
    const est = estimateContextTokens({
      messages: [user('问题', 5), assistant('回答', { timestamp: 5, totalTokens: 777 })],
    });
    expect(est.usageTokens).toBe(777);
  });

  it('时间戳更早的 assistant 不能给「摘要之后」的前缀当锚点', () => {
    // 压缩摘要是尾部追加、时间戳最新，其 retainedTail 里的旧 assistant 带着压缩前的
    // 巨大 usage。若照搬 pi-agent-core 的「从尾部找第一条 assistant」，刚压完就会
    // 读到那条旧 usage、误判仍然超阈值而立刻再压一次。
    const est = estimateContextTokens({
      messages: [
        summary('摘要', 100),
        assistant('压缩前的回答', { timestamp: 20, totalTokens: 900_000 }),
        user('新问题', 101),
      ],
    });
    expect(est.lastUsageIndex).toBeNull();
    expect(est.usageTokens).toBe(0);
    // '摘要' 2 + '压缩前的回答' 6 + '新问题' 3。
    expect(est.tokens).toBe(11);
  });

  it('摘要之后新产生的 assistant 仍是合法锚点', () => {
    const est = estimateContextTokens({
      messages: [
        summary('摘要', 100),
        assistant('压缩前的回答', { timestamp: 20, totalTokens: 900_000 }),
        user('新问题', 101),
        assistant('新回答', { timestamp: 102, totalTokens: 12_000 }),
      ],
    });
    expect(est.usageTokens).toBe(12_000);
    expect(est.lastUsageIndex).toBe(3);
  });

  it('usage 全为 0 的 assistant 不当锚点', () => {
    const est = estimateContextTokens({ messages: [user('问题', 1), assistant('回答', { timestamp: 2 })] });
    expect(est.lastUsageIndex).toBeNull();
  });

  it('空消息列表只剩前缀量', () => {
    expect(estimateContextTokens({ messages: [] })).toEqual({
      tokens: 0,
      usageTokens: 0,
      trailingTokens: 0,
      lastUsageIndex: null,
    });
    expect(estimateContextTokens({ messages: [], systemPrompt: 'abcd' }).tokens).toBe(1);
  });
});
