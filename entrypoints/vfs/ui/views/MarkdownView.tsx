import { useMemo } from 'react';
import { MarkdownRenderer } from '@/components/common/MarkdownRenderer';
import { parseFrontmatter } from '@/lib/content/frontmatter';

/** Markdown 预览态：frontmatter 表 + 正文，限阅读宽度居中。源码态由 CodeView 渲染。 */
function MarkdownView({ content }: { content: string }) {
  // frontmatter 单独渲染成 GitHub 风格的表格。解析会扫整篇文档，故 memo。
  const { frontmatterData, body } = useMemo(() => {
    const { data, body: rest } = parseFrontmatter(content);
    return { frontmatterData: data, body: rest };
  }, [content]);
  const hasFrontmatter = Object.keys(frontmatterData).length > 0;

  // prose 的 code/pre 默认样式会和 MarkdownRenderer 自己的 CodeBlock 打架：prose 给行内
  // code 加反引号、给 pre 深色底。下面把这两处交还给 MarkdownRenderer，标题 / 列表 /
  // 引用 / 表格仍用 typography。
  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div
        className={
          'prose prose-sm dark:prose-invert max-w-none ' +
          'prose-code:before:content-none prose-code:after:content-none prose-code:font-normal ' +
          'prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-0 prose-pre:m-0 prose-pre:rounded-none prose-pre:font-normal'
        }
      >
        {hasFrontmatter && <FrontmatterTable data={frontmatterData} />}
        <MarkdownRenderer content={body} />
      </div>
    </div>
  );
}

/** GitHub 风格的 frontmatter 表：标量直接显示，嵌套值回落为 JSON 文本，
 *  `not-prose` 防止 typography 重写表格的 padding / 边框。 */
function FrontmatterTable({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="not-prose mb-4 overflow-hidden rounded-md border border-border">
      <table className="w-full text-[13px] table-fixed">
        <tbody>
          {Object.entries(data).map(([key, value], i, arr) => (
            <tr key={key} className={i < arr.length - 1 ? 'border-b border-border' : undefined}>
              <th className="w-1/3 px-3 py-2 text-left font-mono text-muted-foreground align-top bg-muted/30">
                {key}
              </th>
              <td className="px-3 py-2 align-top wrap-break-word">
                {renderFrontmatterValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderFrontmatterValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }
  // `front-matter` / js-yaml 会把 ISO-8601 标量解析成 Date，直接显示 ISO 串。
  if (value instanceof Date) {
    return <span>{value.toISOString()}</span>;
  }
  // 对象与数组：JSON 美化后放进 pre；pre-wrap 让超长行换行而不是撑宽表格。
  return (
    <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap wrap-break-word">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export { MarkdownView };
