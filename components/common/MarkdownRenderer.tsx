import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import rehypeHighlight from 'rehype-highlight';
import type { Components, Options as MarkdownOptions } from 'react-markdown';
import { showDialog } from '@/lib/ui/dialog';
import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';
import { CEBIAN_SKILLS_DIR, CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import { encodeRelPath, vfs } from '@/lib/persistence/vfs';
import { isImageMime, mimeFromPath } from '@/lib/content/mime';
import { formatBytes } from '@/lib/utils';
import { extensionSettingsUrl } from '@/lib/browser/file-access';
import { normalizeMathDelimiters } from '@/lib/content/math-delimiters';
import { splitMarkdownBlocks } from '@/lib/content/markdown-blocks';

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

/** 深度优先找 KaTeX 输出里的 <annotation encoding="application/x-tex">（LaTeX 源码）。 */
function katexSourceOf(node: HastElement | undefined): string {
  if (!node) return '';
  const stack: HastChild[] = [...node.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== 'element') continue;
    const el = n as HastElement;
    if (
      el.tagName === 'annotation' &&
      (el.properties as { encoding?: string } | undefined)?.encoding === 'application/x-tex'
    ) {
      return hastToText(el.children);
    }
    stack.push(...el.children);
  }
  return '';
}

/** 该 .katex 元素是否为块级公式（MathML 输出下块级判定只能看 math 的 display 属性）。 */
function isDisplayMath(node: HastElement | undefined): boolean {
  return !!node?.children.some(
    (c) =>
      c.type === 'element' &&
      (c as HastElement).tagName === 'math' &&
      ((c as HastElement).properties as { display?: string } | undefined)?.display === 'block',
  );
}

/**
 * 块级公式容器：悬浮显示「复制 LaTeX 源码」按钮（照 CodeBlock 的复制模式，
 * 但公式不用常驻头部栏，悬浮更轻）。行内公式不加按钮——整条消息复制本就
 * 保留原始 Markdown 源码。
 */
function MathBlock({
  node,
  className,
  children,
  ...rest
}: {
  node?: HastElement;
  className?: string;
  children?: ReactNode;
} & Record<string, unknown>) {
  const source = katexSourceOf(node);
  return (
    <span className="relative block group/math">
      <span className={className} {...rest}>
        {children}
      </span>
      {source && (
        // focus-within：键盘 Tab 到按钮时同样显形，避免不可见的可聚焦目标
        <span className="absolute right-0 top-0 opacity-0 group-hover/math:opacity-100 group-focus-within/math:opacity-100 transition-opacity">
          <CopyButton text={source} />
        </span>
      )}
    </span>
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
  // 额外仅放行本扩展详情页这一个 chrome:// 地址（LLM 引导用户开启
  // 「允许访问文件网址」时给出的链接），点击由下方 anchor 组件接管；
  // 其余 chrome:// 地址仍被默认消毒器剥除
  if (url === extensionSettingsUrl()) return url;
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

// ─── KaTeX 数学公式（按需加载）───
//
// katex（rehype-katex 的传递依赖）压缩后约 260KB，而含公式的对话是少数，
// 照 lib/content/pdf-loader.ts 的先例做模块级单例的动态 import：首次检测到
// 数学定界符才加载；加载完成前该消息按普通 Markdown 渲染（公式暂显源码，
// 加载完成后一次性替换）。

type MathPlugins = {
  remarkMath: typeof import('remark-math').default;
  rehypeKatex: typeof import('rehype-katex').default;
};

let mathPlugins: MathPlugins | null = null;
let mathPluginsPromise: Promise<MathPlugins> | null = null;
// 加载完成时通知所有挂载中的 MarkdownRenderer——任何一个实例触发的加载
// （包括失败后由后来实例重试成功）都要让全部实例重渲染出公式
const mathListeners = new Set<() => void>();

function subscribeMathPlugins(onChange: () => void): () => void {
  mathListeners.add(onChange);
  return () => {
    mathListeners.delete(onChange);
  };
}

function loadMathPlugins(): Promise<MathPlugins> {
  mathPluginsPromise ??= Promise.all([import('remark-math'), import('rehype-katex')])
    .then(([rm, rk]) => {
      mathPlugins = { remarkMath: rm.default, rehypeKatex: rk.default };
      for (const notify of mathListeners) notify();
      return mathPlugins;
    })
    .catch((err) => {
      // 失败后清空单例允许下次重试（照 lib/content/pdf-loader.ts 的先例），
      // 避免一次瞬时的 chunk 加载失败让本会话永远渲染不了公式
      mathPluginsPromise = null;
      throw err;
    });
  return mathPluginsPromise;
}

/** 粗筛：内容里是否可能出现数学定界符（$...$ / $$...$$ / \(...\) / \[...\]）。
 *  只用来决定要不要加载 KaTeX，误报（如 shell 变量里的 $）只是多加载一次，无渲染影响。 */
const MATH_HINT_RE = /\$|\\[([]/;

/** rehype-katex 选项。
 *  - output 'mathml'：交给浏览器原生 MathML Core 渲染（Chromium 109+ / Firefox
 *    均支持），免去 ~1MB KaTeX 字体和 katex.min.css；
 *  - throwOnError false：流式中的半截公式渲染为源码而不是抛错；
 *  - strict false：容忍公式里的 CJK 等非严格 LaTeX 用法（LLM 输出常见）。 */
const KATEX_OPTIONS = { output: 'mathml', throwOnError: false, strict: false } as const;

/** 未加载/无公式时的基础插件表；含公式时在其上追加数学插件。 */
const BASE_REMARK_PLUGINS: NonNullable<MarkdownOptions['remarkPlugins']> = [
  remarkGfm,
  remarkCjkFriendly,
];
const BASE_REHYPE_PLUGINS: NonNullable<MarkdownOptions['rehypePlugins']> = [rehypeHighlight];

/** 订阅数学插件加载：内容含数学定界符时触发加载，完成后重渲染。
 *  用 useSyncExternalStore 订阅模块级单例而不是各自持有 state——加载可能由
 *  任何实例在任何时刻完成（含 render 与 effect 之间、失败后由后来实例重试
 *  成功），订阅保证所有挂载中的实例都被通知，不会有实例停留在源码态。 */
function useMathPlugins(content: string): MathPlugins | null {
  const wantsMath = MATH_HINT_RE.test(content);
  const plugins = useSyncExternalStore(subscribeMathPlugins, () => mathPlugins);
  useEffect(() => {
    if (!wantsMath || mathPlugins) return;
    loadMathPlugins().catch((err) => {
      console.warn('[MarkdownRenderer] failed to load math plugins:', err);
    });
  }, [wantsMath]);
  return wantsMath ? plugins : null;
}

const components: Components = {
  // Images — click to preview
  img: ({ src, alt, ...props }) => (
    <VfsImage src={src} alt={alt} {...props} />
  ),

  // External links open in new tab
  a: ({ href, children, ...props }) => {
    const resolved = resolveVfsHref(href);
    // chrome:// 无法从页面内容点击导航。仅白名单本扩展详情页这一个精确地址
    // （「允许访问文件网址」开关所在页，LLM 引导用户开启时会给出该链接），
    // 拦截点击改经 chrome.tabs.create 打开；不放开任意 chrome:// 地址
    const isOwnSettingsPage = resolved === extensionSettingsUrl();
    return (
      <a
        href={resolved}
        target="_blank"
        rel="noopener noreferrer"
        className="text-info underline underline-offset-2 hover:text-info/80"
        {...props}
        onClick={isOwnSettingsPage
          ? e => {
              e.preventDefault();
              void chrome.tabs.create({ url: resolved, active: true });
            }
          : props.onClick}
      >
        {children}
      </a>
    );
  },

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

  // 块级 KaTeX 公式加悬浮复制按钮；其余 span（含 hljs 高亮片段、行内公式）原样透传
  span: ({ node, className, children, ...props }) => {
    const el = node as unknown as HastElement | undefined;
    if (className && /(?:^|\s)katex(?:\s|$)/.test(className) && isDisplayMath(el)) {
      return (
        <MathBlock node={el} className={className} {...props}>
          {children}
        </MathBlock>
      );
    }
    return (
      <span className={className} {...props}>
        {children}
      </span>
    );
  },

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

/** 单篇/单块 Markdown 的实际渲染。按 (content, math) memo——流式分块时
 *  稳定前缀块的 content 字符串不变，parse/高亮/KaTeX 全部跳过。 */
const MarkdownDoc = memo(function MarkdownDoc({
  content,
  math,
}: {
  content: string;
  math: MathPlugins | null;
}) {
  return (
    <Markdown
      remarkPlugins={math ? [...BASE_REMARK_PLUGINS, math.remarkMath] : BASE_REMARK_PLUGINS}
      rehypePlugins={
        math ? [...BASE_REHYPE_PLUGINS, [math.rehypeKatex, KATEX_OPTIONS]] : BASE_REHYPE_PLUGINS
      }
      components={components}
      urlTransform={urlTransform}
    >
      {content}
    </Markdown>
  );
});

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** 归一化 LLM 风格的数学定界符（\(...\) → $...$ 等，见 lib/content/math-delimiters.ts）。
   *  只对聊天等「LLM 产出的内容」开启；任意 Markdown 文件（VFS 预览）里的
   *  \( 是 CommonMark 转义括号，不能当数学定界符转换。 */
  normalizeMath?: boolean;
  /** 流式输出中。开启两件事：
   *  1. 按顶层块级边界分块渲染并逐块 memo——每个增量只有末尾块重渲染
   *     （见 lib/content/markdown-blocks.ts；跨块引用/脚注在流式中途暂显
   *     源码，流结束后切回整篇渲染即恢复）；
   *  2. 归一化时启用末尾未闭合 $$ 的防闪烁保护。 */
  streaming?: boolean;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content: rawContent,
  className,
  normalizeMath = false,
  streaming = false,
}: MarkdownRendererProps) {
  const content = normalizeMath
    ? normalizeMathDelimiters(rawContent, { streaming })
    : rawContent;
  const math = useMathPlugins(content);
  return (
    <div className={`max-w-none wrap-break-word ${className ?? ''}`}>
      {streaming ? (
        splitMarkdownBlocks(content).map((block, idx) => (
          // 前缀稳定（块边界不随追加移动），index 作 key 安全
          <MarkdownDoc key={idx} content={block} math={math} />
        ))
      ) : (
        <MarkdownDoc content={content} math={math} />
      )}
    </div>
  );
});
