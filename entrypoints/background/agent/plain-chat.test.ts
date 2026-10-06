import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { toPlainChat } from './plain-chat';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'toolUse',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'custom:x',
    model: 'm',
    usage,
    stopReason,
    timestamp: 1,
  };
}

function toolResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'fs_list',
    content: [{ type: 'text', text: 'a.txt' }],
    isError: false,
    timestamp: 2,
    ...overrides,
  };
}

const user = (text: string, timestamp = 3): Message => ({ role: 'user', content: text, timestamp });

describe('toPlainChat', () => {
  it('没有工具调用时原样返回同一个数组', () => {
    const messages: Message[] = [user('hi'), assistant([{ type: 'text', text: 'hello' }], 'stop')];
    expect(toPlainChat(messages)).toBe(messages);
  });

  it('toolCall 块改成文字，thinking / text 块原样保留，原消息不被修改', () => {
    const message = assistant([
      { type: 'thinking', thinking: 'let me look' },
      { type: 'text', text: 'Checking.' },
      { type: 'toolCall', id: 'call-1', name: 'fs_list', arguments: { path: '/' } },
    ]);
    const [plain] = toPlainChat([message]) as AssistantMessage[];
    expect(plain.content).toEqual([
      { type: 'thinking', thinking: 'let me look' },
      { type: 'text', text: 'Checking.' },
      { type: 'text', text: '[Tool call: fs_list({"path":"/"})]' },
    ]);
    expect(message.content[2].type).toBe('toolCall');
  });

  it('工具结果改成 user 消息，标注工具名与是否出错，图片保留', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    expect(toPlainChat([toolResult({ content: [{ type: 'text', text: 'a.txt' }, image] })])).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[Tool result: fs_list]' }, { type: 'text', text: 'a.txt' }, image],
        timestamp: 2,
      },
    ]);
    expect(toPlainChat([toolResult({ isError: true, content: [{ type: 'text', text: 'ENOENT' }] })])).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[Tool error: fs_list]' }, { type: 'text', text: 'ENOENT' }],
        timestamp: 2,
      },
    ]);
  });

  it('并行调用的多个工具结果与随后的 user 消息合并成一条', () => {
    const plain = toPlainChat([
      assistant([
        { type: 'toolCall', id: 'call-1', name: 'fs_list', arguments: {} },
        { type: 'toolCall', id: 'call-2', name: 'fs_read', arguments: {} },
      ]),
      toolResult(),
      toolResult({ toolCallId: 'call-2', toolName: 'fs_read', content: [{ type: 'text', text: 'body' }] }),
      user('next'),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(plain[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Tool result: fs_list]' },
        { type: 'text', text: 'a.txt' },
        { type: 'text', text: '[Tool result: fs_read]' },
        { type: 'text', text: 'body' },
        { type: 'text', text: 'next' },
      ],
      timestamp: 2,
    });
  });

  it('丢掉没有可见文字的 assistant（只有思考 / 空内容），两侧的 user 消息随之合并', () => {
    const plain = toPlainChat([
      user('list', 0),
      assistant([{ type: 'toolCall', id: 'call-1', name: 'fs_list', arguments: {} }]),
      toolResult(),
      assistant([{ type: 'thinking', thinking: 'still thinking' }], 'length'),
      user('again'),
      assistant([{ type: 'text', text: '  ' }], 'stop'),
      user('once more', 4),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('空 user 消息换成占位文字而不是丢掉，两侧的 assistant 不会相邻', () => {
    const plain = toPlainChat([
      { role: 'user', content: [], timestamp: 0 },
      assistant([{ type: 'text', text: 'hi' }], 'stop'),
      { role: 'user', content: [{ type: 'text', text: '' }], timestamp: 1 },
      assistant([{ type: 'text', text: 'again' }], 'stop'),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(plain[0]).toMatchObject({ content: [{ type: 'text', text: '(empty message)' }] });
    expect(plain[2]).toMatchObject({ content: [{ type: 'text', text: '(empty message)' }] });
  });

  it('两条空字符串 user 合并后变空，也换成占位文字', () => {
    const plain = toPlainChat([
      user('', 0),
      assistant([{ type: 'text', text: 'partial' }], 'aborted'),
      user(''),
      assistant([{ type: 'text', text: 'answer' }], 'stop'),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(plain[0]).toMatchObject({ content: [{ type: 'text', text: '(empty message)' }] });
  });

  it('正文只剩未配对代理字符的 assistant 按 pi-ai 的清洗规则视为空，一并丢掉', () => {
    const plain = toPlainChat([
      user('first', 0),
      assistant([{ type: 'text', text: '\uD800' }], 'stop'),
      user('next'),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['user']);
  });

  it('丢掉中断 / 出错的 assistant，两侧的 user 消息随之合并，角色严格交替', () => {
    const plain = toPlainChat([
      { role: 'system', content: 'base', timestamp: 0 },
      user('list', 0),
      assistant([{ type: 'toolCall', id: 'call-1', name: 'fs_list', arguments: {} }]),
      toolResult(),
      assistant([{ type: 'text', text: 'partial' }], 'aborted'),
      user('again'),
      assistant([{ type: 'text', text: 'oops' }], 'error'),
      user('once more', 4),
    ]);
    expect(plain.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(plain)).not.toContain('partial');
    expect(JSON.stringify(plain[3])).toContain('once more');
  });
});
