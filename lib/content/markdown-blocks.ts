/**
 * 流式 Markdown 分块。
 *
 * 流式输出时每个增量都会让整篇 Markdown 重新 parse + 重渲染（代码高亮、
 * KaTeX 都要全量重跑）。把源文本按顶层块级节点切开、逐块渲染并按块 memo，
 * 流式期间只有末尾块在变化，前面块的字符串不变即 memo 命中。
 *
 * 边界用**与渲染相同的 remark 解析器**取顶层节点的源码 offset，保证：
 * - fenced code、块级 `$$` 公式（含内部空行）、松散列表、表格等多行构造
 *   整体成一块，单独渲染结果与整篇渲染一致；
 * - 已产出的块边界不随后续内容追加而移动（前缀稳定，按 index 做 key 安全）。
 *
 * 已知取舍：跨块的 reference link / GFM 脚注在流式中途会显示为源码——
 * 调用方应在流结束后切回整篇渲染（MarkdownRenderer 的双模式），恢复完全
 * 正确的语义。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';

/** 与 MarkdownRenderer 流式渲染语义一致的边界解析器。
 *  remark-math 必须在场：块级 `$$...$$` 可以包含空行，缺了它公式块会被
 *  当作多个段落切开。GFM 构造（表格/脚注定义）的边界与默认段落边界重合，
 *  emphasis 类插件不影响块级边界，都无需参与。 */
const boundaryParser = unified().use(remarkParse).use(remarkMath);

/**
 * 把 Markdown 源文本按顶层块级边界切成若干段，`blocks.join('') === markdown`
 * 恒成立（块间空行归属前一块的尾部，不影响各块渲染）。
 * 解析器给不出源码位置时退化为单块（整篇渲染）。
 */
function splitMarkdownBlocks(markdown: string): string[] {
  if (!markdown) return [];
  const children = boundaryParser.parse(markdown).children;
  if (children.length <= 1) return [markdown];
  const blocks: string[] = [];
  let prev = 0;
  for (let i = 1; i < children.length; i++) {
    const start = children[i].position?.start.offset;
    if (start == null || start < prev) return [markdown];
    blocks.push(markdown.slice(prev, start));
    prev = start;
  }
  blocks.push(markdown.slice(prev));
  return blocks;
}

export { splitMarkdownBlocks };
