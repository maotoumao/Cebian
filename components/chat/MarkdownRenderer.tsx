import { memo, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { showDialog } from '@/lib/dialog';
import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';
import { CEBIAN_SKILLS_DIR, CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import { encodeRelPath } from '@/components/settings/sections/FileWorkspace';

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
    <div className="my-2 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center justify-between pl-3 pr-1 py-0.5 text-xs text-muted-foreground border-b border-border/40">
        <span className="font-mono">{lang || t('common.code')}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto px-3 pb-3 text-[0.8rem]">
        {children}
      </pre>
    </div>
  );
}

/**
 * URL transform — extends react-markdown's default safelist to allow
 * `chrome-extension:` URLs (used for VFS browser links rendered in chat).
 * The default transform strips them entirely, leaving a bare `#fragment`
 * that would resolve relative to the current page (sidepanel.html).
 */
function urlTransform(url: string): string | null | undefined {
  if (/^chrome-extension:/i.test(url)) return url;
  return defaultUrlTransform(url);
}

/**
 * Normalize a VFS-pointing href so it always resolves through the current
 * extension origin. Handles two cases:
 *
 *   1. Bare hash (e.g. `#/workspaces/abc/file.md`) — prepend
 *      `chrome-extension://<our id>/vfs.html`. Without this the browser
 *      would resolve the hash relative to sidepanel.html.
 *
 *   2. `chrome-extension://<any id>/vfs.html(#…)` — the LLM occasionally
 *      hallucinates the extension id (it's a long random string it can't
 *      reproduce). We strip the model-supplied origin+path and re-attach
 *      the hash to our own URL, guaranteeing the link works.
 *
 * Returns the original href unchanged if it doesn't match either pattern.
 */
function resolveVfsHref(href: string | undefined): string | undefined {
  if (!href) return href;

  // Case 1: bare absolute VFS hash.
  if (href.startsWith('#/') && /^#\/(workspaces|home)\b/.test(href)) {
    try {
      return chrome.runtime.getURL('vfs.html') + href;
    } catch {
      return href;
    }
  }

  // Case 2: any chrome-extension://<id>/vfs.html(?…)(#…) — force our extension id.
  const m = href.match(/^chrome-extension:\/\/[^/]+\/vfs\.html\/?(?:\?[^#]*)?(#.*)?$/i);
  if (m) {
    try {
      return chrome.runtime.getURL('vfs.html') + (m[1] ?? '');
    } catch {
      return href;
    }
  }

  // Case 3: bare hash pointing at a settings-managed VFS dir, e.g.
  //   #~/.cebian/skills/baidu-search/SKILL.md
  //   #~/.cebian/prompts/web-summary.md
  // The LLM emits these because the system prompt advertises tilde paths.
  // Re-route to the Settings tab page (HashRouter) so the file opens in the
  // skills/prompts editor instead of being treated as a same-page anchor.
  for (const [tildeDir, section] of [
    [CEBIAN_SKILLS_DIR, 'skills'],
    [CEBIAN_PROMPTS_DIR, 'prompts'],
  ] as const) {
    const prefix = `#${tildeDir}/`;
    if (href.startsWith(prefix)) {
      const rel = href.slice(prefix.length);
      if (!rel) continue;
      try {
        return `${chrome.runtime.getURL('settings.html')}#/${section}/${encodeRelPath(rel)}`;
      } catch {
        return href;
      }
    }
  }

  // Case 4: hallucinated full URL chrome-extension://<any-id>/settings.html#…
  const sm = href.match(/^chrome-extension:\/\/[^/]+\/settings\.html\/?(?:\?[^#]*)?(#.*)?$/i);
  if (sm) {
    try {
      return chrome.runtime.getURL('settings.html') + (sm[1] ?? '');
    } catch {
      return href;
    }
  }

  return href;
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
    <a href={resolveVfsHref(href)} target="_blank" rel="noopener noreferrer" className="text-info underline underline-offset-2 hover:text-info/80" {...props}>
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
        urlTransform={urlTransform}
      >
        {content}
      </Markdown>
    </div>
  );
});
