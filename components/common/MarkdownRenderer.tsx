import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { showDialog } from '@/lib/dialog';
import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';
import { CEBIAN_SKILLS_DIR, CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import { encodeRelPath, vfs } from '@/lib/vfs';
import { isImageMime, mimeFromPath } from '@/lib/mime';

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

// ─── Inline VFS image rendering ───
//
// markdown `![alt](#/workspaces/<uuid>/<skill>/cat.png)` 这种 src 在普通 <img>
// 里无法直接加载（hash 不是 URL），需要把 VFS 字节读出来转成 blob URL。
//
// 支持的 src 形态：
// - `#/workspaces/<...>/<image>`
// - `#/home/<...>/<image>`（用户/skill 自带资源）
// 不匹配上述形态的 src 直接走原生 <img>，行为不变。
//
// 大小阈值（默认 30 MB）以上不内联，回退成 "在 VFS 浏览器中打开" 的链接，
// 防止聊天里一张超大图把整个 sidepanel 卡住。

/** 内联渲染上限。超过该值的图片改为渲染链接而非 <img>。 */
const VFS_INLINE_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/** 人类可读的文件大小，跟 lib/tools/fs-helpers 的实现保持一致。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 判断 markdown 给出的 src 是不是我们要接管的 VFS 路径形态。 */
const VFS_HASH_PATH_RE = /^#\/(workspaces|home)\b\//;

/**
 * 从 `#/workspaces/...` 形态的 src 抽出真正的 VFS 路径。
 * markdown 渲染前 src 通常带 URL 编码（空格 → `%20`、中文等），这里统一
 * `decodeURIComponent` 后再交给 VFS —— `vfs.readFile` 接的是字面路径。
 * 解码失败时退回原始 slice 结果，让 VFS 自己抛 ENOENT。
 */
function extractVfsPath(src: string): string | null {
  if (!VFS_HASH_PATH_RE.test(src)) return null;
  const raw = src.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 异步加载状态机 —— 用 discriminated union 保证状态/字段对齐；每个状态都
 *  带 path 一起记录，避免 vfsPath 在父级 rerender 时切换、effect 还没跑完
 *  上一帧用旧 url 渲染新 path 的过渡帧。 */
type VfsImageState =
  | { kind: 'idle'; path: null }
  | { kind: 'loading'; path: string }
  | { kind: 'ready'; path: string; url: string }
  | { kind: 'too-large'; path: string; bytes: number }
  | { kind: 'error'; path: string; message: string };

/**
 * 渲染一张可能来自 VFS 的图片。
 * - 非 VFS src → 透传给原生 <img>，跟之前行为一致
 * - VFS src → 读字节、生成 blob URL、内联渲染；超大文件 / 非图片 MIME 降级
 */
function VfsImage({ src, alt, ...rest }: { src?: string; alt?: string } & Record<string, unknown>) {
  const vfsPath = src ? extractVfsPath(src) : null;
  const [state, setState] = useState<VfsImageState>(
    vfsPath ? { kind: 'loading', path: vfsPath } : { kind: 'idle', path: null },
  );
  // 当前正在渲染的 blob URL；effect cleanup 时 revoke，避免内存泄漏。
  const currentUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!vfsPath) {
      setState({ kind: 'idle', path: null });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading', path: vfsPath });
    (async () => {
      try {
        const mime = mimeFromPath(vfsPath);
        if (!isImageMime(mime)) {
          if (!cancelled) {
            setState({
              kind: 'error',
              path: vfsPath,
              message: t('vfs.inlineUnsupportedMime', [mime]),
            });
          }
          return;
        }
        const stat = await vfs.stat(vfsPath);
        if (cancelled) return;
        if (stat.size > VFS_INLINE_IMAGE_MAX_BYTES) {
          setState({ kind: 'too-large', path: vfsPath, bytes: stat.size });
          return;
        }
        const bytes = (await vfs.readFile(vfsPath)) as Uint8Array;
        if (cancelled) return;
        const blob = new Blob([bytes as BlobPart], { type: mime });
        const url = URL.createObjectURL(blob);
        currentUrlRef.current = url;
        setState({ kind: 'ready', path: vfsPath, url });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            path: vfsPath,
            message: (err as Error).message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, [vfsPath]);

  // 非 VFS：直接走原生 <img>，保持原有行为
  if (!vfsPath) {
    return (
      <img
        src={src}
        alt={alt}
        role="button"
        tabIndex={0}
        onClick={() => src && showDialog('image-preview', { src, alt })}
        onKeyDown={(e) => e.key === 'Enter' && src && showDialog('image-preview', { src, alt })}
        {...rest}
        className="max-w-full rounded cursor-pointer hover:opacity-90 transition-opacity my-2"
      />
    );
  }

  // 上一帧 state 还停留在旧 path（effect 还没跑完）→ 强制按 loading 渲染，
  // 避免短暂闪现旧 blob URL。
  const effective: VfsImageState =
    state.path === vfsPath ? state : { kind: 'loading', path: vfsPath };

  // VFS：根据状态机分支渲染
  if (effective.kind === 'loading') {
    return (
      <span
        role="status"
        aria-busy="true"
        aria-label={alt || vfsPath}
        className="inline-block align-middle px-3 py-2 my-2 rounded border border-dashed border-border bg-muted/30 text-xs text-muted-foreground"
        title={vfsPath}
      >
        {alt || t('common.loading')}
      </span>
    );
  }
  if (effective.kind === 'too-large') {
    const sizeStr = formatBytes(effective.bytes);
    const limitStr = formatBytes(VFS_INLINE_IMAGE_MAX_BYTES);
    return (
      <a
        href={resolveVfsHref('#' + vfsPath)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block align-middle px-3 py-2 my-2 rounded border border-border bg-muted/40 text-xs text-info underline-offset-2 hover:underline"
        title={t('vfs.inlineTooLarge', [vfsPath, sizeStr, limitStr])}
      >
        📎 {alt || vfsPath} ({sizeStr})
      </a>
    );
  }
  if (effective.kind === 'error') {
    return (
      <span
        role="img"
        aria-label={alt || vfsPath}
        className="inline-block align-middle px-3 py-2 my-2 rounded border border-dashed border-destructive/40 bg-destructive/5 text-xs text-destructive"
        title={t('vfs.inlineLoadFailed', [vfsPath, effective.message])}
      >
        ⚠ {alt || vfsPath}
      </span>
    );
  }
  // effective.kind === 'ready'
  return (
    <img
      src={effective.url}
      alt={alt}
      role="button"
      tabIndex={0}
      onClick={() => openVfsImagePreview(vfsPath, alt)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openVfsImagePreview(vfsPath, alt);
        }
      }}
      {...rest}
      className="max-w-full rounded cursor-pointer hover:opacity-90 transition-opacity my-2"
    />
  );
}

/**
 * 点击预览：单独读取并生成一次性 blob URL 交给 dialog 自己回收。
 * dialog 标记 `revokeSrcOnUnmount` 后会在 unmount 时 revoke，因此这条 URL
 * 跟 VfsImage 自身的渲染 URL 解耦——VfsImage 卸载/重渲染不会让 modal 里的
 * 图片变破图。
 */
async function openVfsImagePreview(vfsPath: string, alt?: string): Promise<void> {
  try {
    const bytes = (await vfs.readFile(vfsPath)) as Uint8Array;
    const mime = mimeFromPath(vfsPath);
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    showDialog('image-preview', { src: url, alt, revokeSrcOnUnmount: true });
  } catch (err) {
    console.warn('[VfsImage] preview failed:', err);
  }
}

const components: Components = {
  // Images — click to preview
  img: ({ src, alt, ...props }) => (
    <VfsImage src={src} alt={alt} {...props} />
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
