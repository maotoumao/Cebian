import { describe, it, expect } from 'vitest';
import { chatAppearanceStyle } from '@/lib/ui/chat-appearance';
import { resolveChatAppearance, type ChatAppearance } from '@/lib/persistence/storage';

function style(partial: Partial<ChatAppearance>): Record<string, string> {
  return chatAppearanceStyle(resolveChatAppearance(partial)) as Record<string, string>;
}

describe('chatAppearanceStyle', () => {
  it('默认外观 → 倍率 1、字体变量置为 initial（回退继承，且不从外层容器继承已保存的字体）', () => {
    expect(style({})).toEqual({ '--chat-text-scale': '1', '--chat-font-family': 'initial' });
  });

  it('百分比换算成倍率', () => {
    expect(style({ fontScalePercent: 125 })['--chat-text-scale']).toBe('1.25');
    expect(style({ fontScalePercent: 80 })['--chat-text-scale']).toBe('0.8');
  });

  it('预设字体映射到对应字体栈', () => {
    expect(style({ fontPreset: 'mono' })['--chat-font-family']).toBe('var(--font-mono)');
    expect(style({ fontPreset: 'serif' })['--chat-font-family']).toMatch(/serif$/);
  });

  it('自定义字体加引号并回退到界面默认字体', () => {
    expect(style({ fontPreset: 'custom', customFontName: 'LXGW WenKai' })['--chat-font-family']).toBe(
      '"LXGW WenKai", var(--font-sans)',
    );
  });

  it('自定义字体名为空 → 不覆盖字体', () => {
    expect(style({ fontPreset: 'custom', customFontName: '   ' })['--chat-font-family']).toBe('initial');
  });

  it('非自定义预设忽略残留的自定义字体名', () => {
    expect(style({ fontPreset: 'default', customFontName: 'Inter' })['--chat-font-family']).toBe('initial');
  });

  it('按 CSS 字符串规则转义：引号、反斜杠（含结尾反斜杠）、控制字符', () => {
    const family = (name: string) => style({ fontPreset: 'custom', customFontName: name })['--chat-font-family'];
    expect(family('a"b')).toBe('"a\\"b", var(--font-sans)');
    // 结尾反斜杠若不转义会吃掉闭引号，整条声明失效
    expect(family('a\\')).toBe('"a\\\\", var(--font-sans)');
    expect(family('a\nb\u0000c\u007f')).toBe('"abc", var(--font-sans)');
    // 分号 / 花括号在字符串字面量内无害，原样保留
    expect(family('x; color: red }')).toBe('"x; color: red }", var(--font-sans)');
  });
});
