import { memo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { showDialog } from '@/lib/dialog';
import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';

/**
 * Minimal structural types for the hast (HTML AST) nodes react-markdown passes
 * via the `node` prop. We avoid importing `hast` directly because it isn't a
 * direct dependency under pnpm's strict resolution.
 */
type HastText = { type: 'text'; value: string };
type HastElement = {
  type: 'element';
  tagName: string;
  properties?: { className?: string | string[] | unknown };
  children: HastChild[];
};
type HastChild = HastElement | HastText | { type: string; [k: string]: unknown };

/** Recursively concatenate all text nodes under a hast element. */
function hastToText(nodes: HastChild[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += (n as HastText).value;
    else if (n.type === 'element') out += hastToText((n as HastElement).children);
  }
  return out;
}

/** Read the first `language-xxx` token from a hast element's className list. */
function languageOf(props: HastElement['properties']): string {
  const cls = props?.className;
  const list = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(/\s+/) : [];
  for (const c of list) {
    if (typeof c === 'string' && c.startsWith('language-')) return c.slice('language-'.length);
  }
  return '';
}

/**
 * Code-block container with header (language label + copy button).
 * Sources language and copy text from the hast `node` (independent of the
 * `components` map's `code` renderer, which would obscure the AST).
 */
function CodeBlock({ node, children }: { node?: HastElement; children?: ReactNode }) {
  const codeNode = node?.children.find(
    (c): c is HastElement => c.type === 'element' && (c as HastElement).tagName === 'code',
  );
  const lang = languageOf(codeNode?.properties);
  const text = hastToText(codeNode?.children);

  return (
    <div className="my-2 overflow-hidden rounded-md bg-accent/50">
      <div className="flex items-center justify-between pl-3 pr-1 py-0.5 text-xs text-muted-foreground">
        <span className="font-mono">{lang || t('common.code')}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto px-3 pb-3 text-[0.8rem]">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  // Images — click to preview
  img: ({ src, alt, ...props }) => (
    <img
      src={src}
      alt={alt}
      role="button"
      tabIndex={0}
      onClick={() => src && showDialog('image-preview', { src, alt })}
      onKeyDown={(e) => e.key === 'Enter' && src && showDialog('image-preview', { src, alt })}
      {...props}
      className="max-w-full rounded cursor-pointer hover:opacity-90 transition-opacity my-2"
    />
  ),

  // External links open in new tab
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-info underline underline-offset-2 hover:text-info/80" {...props}>
      {children}
    </a>
  ),

  // Horizontal rule with proper spacing
  hr: (props) => (
    <hr className="my-2 border-border" {...props} />
  ),

  // Paragraph — detect image-only paragraphs for gallery layout
  p: ({ children, node, ...props }) => {
    const nonWs = node?.children?.filter(
      (c) => c.type !== 'text' || (c as any).value?.trim(),
    );
    if (nonWs && nonWs.length > 1 && nonWs.every((c) => c.type === 'element' && (c as any).tagName === 'img')) {
      return (
        <div className="flex flex-wrap gap-2 my-2 [&>img]:my-0 [&>img]:max-w-[calc(50%-0.25rem)]" {...props}>
          {children}
        </div>
      );
    }
    return <p className="my-1.5" {...props}>{children}</p>;
  },

  // Unordered list
  ul: ({ children, ...props }) => (
    <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props}>{children}</ul>
  ),

  // Ordered list
  ol: ({ children, ...props }) => (
    <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props}>{children}</ol>
  ),

  // List item
  li: ({ children, ...props }) => (
    <li className="text-foreground" {...props}>{children}</li>
  ),

  // Blockquote
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic" {...props}>{children}</blockquote>
  ),

  // Code blocks with header (language + copy button).
  pre: ({ node, children }) => <CodeBlock node={node as unknown as HastElement | undefined}>{children}</CodeBlock>,

  // Inline code (block code is rendered inside `pre`/`CodeBlock` above).
  // NOTE: rehype-highlight rewrites block code's className to `"hljs language-xxx ..."`,
  // so we test for the `language-` token anywhere in the class list — checking only
  // `startsWith('language-')` would misclassify highlighted blocks as inline and apply
  // inline-code styling per text fragment (causing per-character "shadows").
  code: ({ className, children, ...props }) => {
    const isBlock = !!className && /(?:^|\s)(?:hljs|language-)/.test(className);
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
    <div className={`max-w-none wrap-break-word ${className ?? ''}`}>
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
