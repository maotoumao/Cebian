import { describe, it, expect, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  MAX_SESSION_TITLE_LENGTH,
  buildTitleGenerationPrompt,
  collectTitleSource,
  defaultSessionTitle,
  normalizeSessionTitle,
  parseGeneratedTitle,
} from './session-title';

// fakeBrowser 不实现 chrome.i18n.getMessage，回落文案直接用 key 断言。
vi.mock('@/lib/i18n', () => ({ t: (key: string) => key }));

describe('defaultSessionTitle', () => {
  it('压成一行并截到 50 字，超长以 … 结尾', () => {
    expect(defaultSessionTitle('  hello\n\nworld  ')).toBe('hello world');
    const long = 'a'.repeat(60);
    expect(defaultSessionTitle(long)).toBe(`${'a'.repeat(50)}…`);
    expect(defaultSessionTitle('a'.repeat(50))).toBe('a'.repeat(50));
  });

  it('全空白回落「新对话」', () => {
    expect(defaultSessionTitle('')).toBe('common.newChat');
    expect(defaultSessionTitle('  \n\t ')).toBe('common.newChat');
  });
});

describe('normalizeSessionTitle', () => {
  it('去首尾空白、折叠换行；空 → null', () => {
    expect(normalizeSessionTitle('  a\n b  ')).toBe('a b');
    expect(normalizeSessionTitle('')).toBeNull();
    expect(normalizeSessionTitle('   ')).toBeNull();
  });

  it('超长硬截到上限、不加省略号', () => {
    const out = normalizeSessionTitle('x'.repeat(MAX_SESSION_TITLE_LENGTH + 20));
    expect(out).toHaveLength(MAX_SESSION_TITLE_LENGTH);
    expect(out?.endsWith('x')).toBe(true);
  });

  it('截断点落在代理对中间时不留半个字符', () => {
    const out = normalizeSessionTitle('a' + '😀'.repeat(60));
    expect(out).toHaveLength(MAX_SESSION_TITLE_LENGTH - 1);
    expect(out?.endsWith('😀')).toBe(true);
  });
});

describe('parseGeneratedTitle', () => {
  it.each([
    ['"Weather in Paris"', 'Weather in Paris'],
    ['「巴黎天气」', '巴黎天气'],
    ['Title: Fix login bug.', 'Fix login bug'],
    ['标题：修复登录问题。', '修复登录问题'],
    ['\n\n  Plain title  \nsecond line ignored', 'Plain title'],
    ['`code title`!!', 'code title'],
    ['"Fix bug."', 'Fix bug'],
    ['**Bold title**', 'Bold title'],
    ['標題：修復登入問題', '修復登入問題'],
    ['"Title."', 'Title'],
  ])('%j → %j', (raw, expected) => {
    expect(parseGeneratedTitle(raw)).toBe(expected);
  });

  it('清洗后为空 → null', () => {
    expect(parseGeneratedTitle('')).toBeNull();
    expect(parseGeneratedTitle('""')).toBeNull();
    expect(parseGeneratedTitle('。。。')).toBeNull();
  });

  it('不对称 / 内部含同款符号的引号不剥（避免误删正文）', () => {
    expect(parseGeneratedTitle('"Quote at start only')).toBe('"Quote at start only');
    expect(parseGeneratedTitle('"Hello" and "World"')).toBe('"Hello" and "World"');
  });

  it('超长输出仍受标题上限约束', () => {
    expect(parseGeneratedTitle('x'.repeat(300))).toHaveLength(MAX_SESSION_TITLE_LENGTH);
  });
});

describe('collectTitleSource', () => {
  const msgs = (arr: unknown[]) => arr as unknown as AgentMessage[];
  const user = (text: string) => ({ role: 'user', content: `<user-request>\n${text}\n</user-request>`, timestamp: 1 });
  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 });

  it('首轮：一条 user + 有正文的 assistant → 拆出原文与正文', () => {
    expect(collectTitleSource(msgs([user('hello'), assistant('world')]))).toEqual({
      userText: 'hello',
      assistantText: 'world',
    });
  });

  it('工具轮的多条 assistant 正文拼接；toolResult / permissionRequest 不算 user', () => {
    const out = collectTitleSource(msgs([
      user('q'),
      assistant('step 1'),
      { role: 'toolResult', toolName: 'x', content: [], timestamp: 3 },
      { role: 'permissionRequest', toolCallId: 'c', timestamp: 4 },
      assistant('step 2'),
    ]));
    expect(out?.assistantText).toBe('step 1\nstep 2');
  });

  it('不是首轮（两条 user）→ null', () => {
    expect(collectTitleSource(msgs([user('a'), assistant('b'), user('c'), assistant('d')]))).toBeNull();
  });

  it('assistant 无正文（error / abort 收尾）或 user 无原文（仅附件）→ null', () => {
    expect(collectTitleSource(msgs([user('a'), assistant('')]))).toBeNull();
    expect(collectTitleSource(msgs([{ role: 'user', content: [{ type: 'image' }], timestamp: 1 }, assistant('b')]))).toBeNull();
  });
});

describe('buildTitleGenerationPrompt', () => {
  it('摘录各截到 1500 字并带 … 标记，结构带 user / assistant 标签', () => {
    const { systemPrompt, userContent } = buildTitleGenerationPrompt('u'.repeat(2000), 'a'.repeat(10));
    expect(systemPrompt).toContain('same language');
    expect(userContent).toContain(`<user>\n${'u'.repeat(1500)}…\n</user>`);
    expect(userContent).toContain('<assistant>\naaaaaaaaaa\n</assistant>');
  });
});
