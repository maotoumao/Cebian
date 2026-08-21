import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '@/lib/content/markdown-blocks';

describe('splitMarkdownBlocks', () => {
  it('普通段落按空行切块，拼接恒等于原文', () => {
    const src = '第一段\n\n第二段\n\n第三段';
    const blocks = splitMarkdownBlocks(src);
    expect(blocks).toEqual(['第一段\n\n', '第二段\n\n', '第三段']);
    expect(blocks.join('')).toBe(src);
  });

  it('单块内容不切', () => {
    expect(splitMarkdownBlocks('只有一段')).toEqual(['只有一段']);
  });

  it('空字符串返回空数组', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
  });

  it('含空行的 fenced code 是一个整块', () => {
    const src = '前文\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后文';
    const blocks = splitMarkdownBlocks(src);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n');
    expect(blocks.join('')).toBe(src);
  });

  it('含空行的块级 $$ 公式是一个整块（remark-math 参与边界解析）', () => {
    const src = '推导：\n\n$$\na = b\n\nc = d\n$$\n\n结论';
    const blocks = splitMarkdownBlocks(src);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('$$\na = b\n\nc = d\n$$\n\n');
    expect(blocks.join('')).toBe(src);
  });

  it('松散列表（项间有空行）整体是一块', () => {
    const src = '1. 甲\n\n2. 乙\n\n3. 丙';
    expect(splitMarkdownBlocks(src)).toEqual([src]);
  });

  it('表格整体是一块', () => {
    const src = '| a | b |\n| - | - |\n| 1 | 2 |\n\n后文';
    const blocks = splitMarkdownBlocks(src);
    expect(blocks).toHaveLength(2);
    expect(blocks.join('')).toBe(src);
  });

  it('流式前缀稳定：追加内容不改变已产出块的边界', () => {
    const prefix = '第一段\n\n第二段\n\n';
    const before = splitMarkdownBlocks(prefix + '第三');
    const after = splitMarkdownBlocks(prefix + '第三段继续\n\n第四段');
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });

  it('末尾未闭合的 fence 归入最后一块', () => {
    const src = '前文\n\n```js\nconst a =';
    const blocks = splitMarkdownBlocks(src);
    expect(blocks).toEqual(['前文\n\n', '```js\nconst a =']);
  });
});
