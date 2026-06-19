import { describe, it, expect } from 'vitest';
import { cleanTranscript, appendTranscript } from '@/lib/speech/transcript';

describe('cleanTranscript', () => {
  it('去除汉字之间的空格', () => {
    expect(cleanTranscript('今 天 天 气 不 错')).toBe('今天天气不错');
  });

  it('合并多个汉字间的连续空格', () => {
    expect(cleanTranscript('你  好   世 界')).toBe('你好世界');
  });

  it('保留英文单词之间的空格', () => {
    expect(cleanTranscript('hello world today')).toBe('hello world today');
  });

  it('中英混排：去汉字间空格、留英文间空格', () => {
    expect(cleanTranscript('打开 GitHub 主 页')).toBe('打开 GitHub 主页');
  });

  it('裁剪首尾空白', () => {
    expect(cleanTranscript('  今天  ')).toBe('今天');
  });

  it('空串返回空串', () => {
    expect(cleanTranscript('')).toBe('');
  });

  it('不破坏汉字与英文边界的单个空格', () => {
    // 汉字后接英文单词，空格应保留（不是 CJK-CJK 间隙）。
    expect(cleanTranscript('搜索 apple')).toBe('搜索 apple');
  });
});

describe('appendTranscript', () => {
  it('base 为空时直接返回新段', () => {
    expect(appendTranscript('', '今天天气')).toBe('今天天气');
  });

  it('addition 为空时返回原 base', () => {
    expect(appendTranscript('今天天气', '')).toBe('今天天气');
  });

  it('中文段之间不加空格', () => {
    expect(appendTranscript('今天天气不错', '我很开心')).toBe('今天天气不错我很开心');
  });

  it('英文段之间补一个空格', () => {
    expect(appendTranscript('hello', 'world')).toBe('hello world');
  });

  it('中英边界不加空格（任一侧为 CJK）', () => {
    expect(appendTranscript('打开', 'GitHub')).toBe('打开GitHub');
  });

  it('base 尾部已有空白则不再补', () => {
    expect(appendTranscript('hello ', 'world')).toBe('hello world');
  });

  it('addition 前导空白被归一化，不产生双空格', () => {
    expect(appendTranscript('hello', ' world')).toBe('hello world');
  });

  it('base 尾部空白 + addition 前导空白只保留一个空格', () => {
    expect(appendTranscript('hello ', ' world')).toBe('hello world');
  });

  it('base 为空且 addition 带前导空白时去掉前导空白', () => {
    expect(appendTranscript('', ' hello')).toBe('hello');
  });
});
