import { File, FileCode, FileText, type LucideIcon } from 'lucide-react';
import { normalizePath } from '@/lib/persistence/vfs';
import { WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';
import { isValidSessionId } from '@/lib/utils';
import type { DualViewType, FileMedia } from '../types';

// ─── 文件分类表 ───

/** 加载器按二进制处理（不内联预览、不按 utf8 读）的扩展名。部分媒体扩展名（png / mp4）
 *  也在这里兜底——`classifyFile` 先路由专门的 image/video/audio 桶，所以本表实际只命中
 *  「不渲染的二进制块」：压缩包、字体等（PDF 有自己的类别，不在此表）。 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'zip', 'gz', 'tar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg',
]);

/** 源码扩展名 → highlight.js 语言 id（`lib/highlight.ts` 只注册 common 语言包，这里只列
 *  其中有的，由 `highlight.test.ts` 守护同步）。命中即归入 `code` 类：带行号、高亮、不换行；
 *  `txt / csv / log` 之类不在表里，仍按纯文本渲染。 */
const CODE_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', xhtml: 'xml',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', swift: 'swift', php: 'php', sql: 'sql', lua: 'lua', r: 'r', pl: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
};

/** 可内联渲染的媒体扩展名。 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);

/** 浏览器内预览的体积上限。超过的文件显示「太大」占位并提示下载。50 MB 足以容纳常见的
 *  截图、短视频和源码树，同时让浏览器内存有界。 */
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

// ─── 路径 / 名称 ───

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 扩展名对应的 highlight.js 语言 id；不是源码扩展名返回 null。
 *  用 `Object.hasOwn` 而不是 `in`：`foo.constructor` 这类文件名不能命中原型链。 */
function codeLanguageOf(ext: string): string | null {
  return Object.hasOwn(CODE_LANG, ext) ? CODE_LANG[ext] : null;
}

/** 纯按扩展名给文件分类。顺序即优先级：双视图类别（markdown / html / svg）与媒体桶
 *  （image / video / audio）先于源码，再先于通用的 binary 兜底——BINARY_EXTS 为安全起见与
 *  部分媒体扩展名有重叠。 */
function classifyFile(name: string): 'text' | 'markdown' | 'html' | 'svg' | 'pdf' | 'code' | 'image' | 'video' | 'audio' | 'binary' {
  const ext = fileExtension(name);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  // html / svg 有自己的双视图类别，要排在 code 之前（svg 不在 IMAGE_EXTS 里，这里是唯一事实源）。
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (codeLanguageOf(ext) !== null) return 'code';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}

/** 该文件是否同时拥有渲染态与源码态（预览 / 源码切换的唯一判定处）。 */
function dualViewTypeOf(media: FileMedia): DualViewType | null {
  return media.type === 'markdown' || media.type === 'html' || media.type === 'svg' ? media.type : null;
}

function getHashPath(): string {
  // 去掉开头的 `#`
  const raw = window.location.hash.slice(1);
  try {
    return normalizePath(decodeURIComponent(raw) || '/');
  } catch {
    // 畸形的 % 编码会让 decodeURIComponent 抛 URIError；首屏渲染期间抛出会整页白屏，回落到根目录。
    return '/';
  }
}

function navigateTo(path: string) {
  window.location.hash = '#' + encodeURIComponent(path);
}

function parentOf(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** 当前路径是否正好是工作区根 `/workspaces`——此时目录列表的子项都是会话 UUID，
 *  需要翻译成「会话标题 · 日期」。 */
function isWorkspacesRoot(p: string): boolean {
  return p === WORKSPACES_ROOT;
}

/** 若 `p` 正好是某个会话工作区目录（`/workspaces/<uuid>`，父目录正好是工作区根），
 *  返回该 `<uuid>` 段，用于渲染目录顶部信息条；否则返回 null（更深的子目录不算）。 */
function workspaceUuidOf(p: string): string | null {
  return parentOf(p) === WORKSPACES_ROOT ? (p.split('/').pop() ?? null) : null;
}

/** 若 `p` 位于某个会话工作区之下（`/workspaces/<uuid>` 或其任意深度的子路径），返回
 *  该 `<uuid>` 段，用于面包屑把 UUID 翻译成会话标题。工作区根本身、其他路径、以及
 *  `/workspaces/` 下第一段不是合法会话 ID 的路径（如直接放在那里的文件）都返回 null。 */
function sessionUuidOf(p: string): string | null {
  if (!p.startsWith(WORKSPACES_ROOT + '/')) return null;
  const first = p.slice(WORKSPACES_ROOT.length + 1).split('/')[0];
  return isValidSessionId(first) ? first : null;
}

// ─── 展示 ───

/** 按扩展名选 lucide 图标。DirView 与面包屑共用，同一个 `.md` 在列表和路径里是同一个图形。 */
function pickFileIcon(ext: string): LucideIcon {
  if (codeLanguageOf(ext) !== null) return FileCode;
  if (ext === 'md') return FileText;
  return File;
}

export {
  CODE_LANG,
  MAX_PREVIEW_BYTES,
  classifyFile,
  codeLanguageOf,
  dualViewTypeOf,
  fileExtension,
  getHashPath,
  isWorkspacesRoot,
  navigateTo,
  parentOf,
  pickFileIcon,
  sessionUuidOf,
  workspaceUuidOf,
};
