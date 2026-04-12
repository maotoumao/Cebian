import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';

const components: Components = {
  // External links open in new tab
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" {...props}>
      {children}
    </a>
  ),

  // Horizontal rule with proper spacing
  hr: (props) => (
    <hr className="my-2 border-border" {...props} />
  ),

  // Code blocks with language label
  pre: ({ children, ...props }) => (
    <pre className="overflow-x-auto rounded-md bg-accent/50 p-3 text-[0.8rem]" {...props}>
      {children}
    </pre>
  ),

  // Inline code
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-accent/50 px-1.5 py-0.5 text-[0.8rem] font-mono" {...props}>
        {children}
      </code>
    );
  },

  // Table — horizontal-scroll wrapper with subtle container border
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto border border-border/50 rounded-md my-3">
      <table className="w-full text-xs border-collapse" {...props}>
        {children}
      </table>
    </div>
  ),

  thead: ({ children, ...props }) => (
    <thead className="bg-secondary/40" {...props}>
      {children}
    </thead>
  ),

  th: ({ children, ...props }) => (
    <th
      className="border-b border-border px-3 py-2.5 text-left font-semibold text-foreground"
      scope="col"
      {...props}
    >
      {children}
    </th>
  ),

  tbody: ({ children, ...props }) => (
    <tbody className="[&_tr:hover]:bg-secondary/20" {...props}>
      {children}
    </tbody>
  ),

  tr: ({ children, ...props }) => (
    <tr
      className="border-b border-border/50 last:border-b-0 transition-colors"
      {...props}
    >
      {children}
    </tr>
  ),

  td: ({ children, ...props }) => (
    <td className="px-3 py-2.5 text-foreground" {...props}>
      {children}
    </td>
  ),
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none wrap-break-word ${className ?? ''}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
});
