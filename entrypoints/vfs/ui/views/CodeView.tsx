import { useMemo } from 'react';
import { highlightCode } from '../../lib/highlight';

/** 超过这个行数不再渲染行号栏：行号串与正文同数量级，几十万行时白白翻倍内存。 */
const GUTTER_MAX_LINES = 20_000;

interface CodeViewProps {
  content: string;
  /** 由加载器算好的行数（换行符数 + 1），避免再扫一遍内容。 */
  lines: number;
  /** 文件字节数，供高亮阈值判断。 */
  bytes: number;
  /** highlight.js 语言 id；为空或不受支持、或内容超阈值时退回纯文本。 */
  lang?: string;
}

/** 行号栏文本。与正文 `<pre>` 保持完全相同的换行结构：以换行结尾的文件，正文最后那个
 *  空行不会渲染成可见行框，行号栏也必须以同样的尾随换行结束，否则左下角会多挂一个
 *  没有代码对应的行号。 */
function gutterText(lines: number, trailingNewline: boolean): string {
  const count = trailingNewline ? lines - 1 : lines;
  const numbers = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  return trailingNewline ? numbers + '\n' : numbers;
}

/** 源码视图：左侧行号栏 + 右侧代码，两列共用同一行高；不自动换行，由外层主区域横向
 *  滚动，行号栏 sticky 留在左侧。行号 `select-none`，复制选区不会带上它。 */
function CodeView({ content, lines, bytes, lang }: CodeViewProps) {
  const showGutter = lines <= GUTTER_MAX_LINES;
  const gutter = useMemo(
    () => (showGutter ? gutterText(lines, /[\r\n]$/.test(content)) : ''),
    [content, lines, showGutter],
  );
  const html = useMemo(
    () => (lang ? highlightCode(content, lang, { lines, bytes }) : null),
    [content, lang, lines, bytes],
  );

  const codeClass = `flex-1 pr-6 text-foreground/90 selection:bg-primary/20 ${showGutter ? '' : 'pl-5'}`;
  return (
    <div className="flex min-w-max py-4 pb-8 font-mono text-[12.5px] leading-[1.65]">
      {showGutter && (
        <pre
          aria-hidden="true"
          className="sticky left-0 shrink-0 select-none text-right pl-5 pr-3.5 bg-background text-muted-foreground/55 tabular-nums"
        >
          {gutter}
        </pre>
      )}
      {html !== null ? (
        // 用户文本已由 highlight.js 转义，剩余标签与 class 全部由它的 renderer 生成。
        <pre className={codeClass}>
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className={codeClass}>{content}</pre>
      )}
    </div>
  );
}

export { CodeView };
