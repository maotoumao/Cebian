import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';

const components: Components = {
  // External links open in new tab
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
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
    <div className={`prose prose-sm dark:prose-invert max-w-none break-words ${className ?? ''}`}>
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
