//
// VFS scanner + 索引生成器：跨对话记忆。
//
// 仿 lib/ai-config/scanner.ts 的 skills 索引模式：
// - 扫 ~/.cebian/memories/*.md，解析 frontmatter（name / description / type）+ mtime。
// - 索引在内存缓存（30 分钟 TTL），并在 VFS 变更时主动失效——记忆集合不变则
//   `buildMemoriesBlock` 产出逐字节一致的块、命中 prompt cache。
// - `buildMemoriesBlock` 生成注入用的 <memories> 数据块（指令文案在系统提示词侧，
//   见 lib/memory/prompt.ts；本块只承载「索引数据」）。
//
import { vfs, normalizePath } from '@/lib/persistence/vfs';
import { CEBIAN_MEMORIES_DIR } from '@/lib/persistence/vfs-paths';
import { escapeXml } from '@/lib/utils';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { type MemoryMeta, parseMemoryType } from './types';

// ─── 常量 ───

// 30 分钟，与 skills scanner 对齐。
const CACHE_TTL_MS = 30 * 60 * 1000;

/** <memories> 块的注入上限——超出则截断（与 Claude Code 的 MEMORY.md 阈值对齐）。 */
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

/** 唯一常驻档：核心身份多槽事实写这一个，正文全文每轮注入，召回不靠 description 镜像。 */
export const USER_PROFILE_FILE = 'user_profile.md';
const USER_PROFILE_PATH = `${CEBIAN_MEMORIES_DIR}/${USER_PROFILE_FILE}`;
/** 常驻全文字节上限——超限只注摘要 + 提示，不截前缀冒充完整（原文仍在索引可 fs_read）。 */
const MAX_PROFILE_BYTES = 1500;

/** 块内一行自描述。真正的「怎么用记忆」行为指引在系统提示词（lib/memory/prompt.ts）。 */
const MEMORIES_INTRO =
  'These are notes you saved about the user in past conversations — an index only. ' +
  'When a memory looks relevant, fs_read_file its <file> for the full content.';

// ─── 索引缓存 ───

let _memoryIndex: MemoryMeta[] | null = null;
let _memoryIndexTimestamp = 0;

/** 清空缓存的记忆索引。由下方 vfs.onChange 监听器在 ~/.cebian/memories/ 被触碰时调用。 */
function invalidateMemoryIndex(): void {
  _memoryIndex = null;
  _memoryIndexTimestamp = 0;
}

// ─── VFS 变更自动失效 ───

const MEMORIES_ROOT = normalizePath(CEBIAN_MEMORIES_DIR);

function pathTouchesMemories(p: string): boolean {
  return p === MEMORIES_ROOT || p.startsWith(MEMORIES_ROOT + '/');
}

// 模块级副作用：首次 import 时订阅一次。index-scan 会被 background/agent.ts 经
// composeUserMessage 间接 import，故监听器在 SW 启动早期、任何工具运行前就已挂上。
// 跨上下文失效同理：UI 写 ~/.cebian/memories/ 经 chrome.runtime 广播 → SW 的 vfs
// 桥本地重放 → 此监听器触发 → SW 内存缓存与磁盘同步。
vfs.onChange((event) => {
  if (pathTouchesMemories(event.path)) {
    invalidateMemoryIndex();
    return;
  }
  if (event.kind === 'rename' && pathTouchesMemories(event.oldPath)) {
    invalidateMemoryIndex();
  }
});

// ─── 老化 ───

/**
 * 把 mtime 渲染成人类可读的「年龄」字符串。按 **UTC 日** 分桶（不是 24h 滑窗）——
 * 同一 UTC 日内逐字节稳定、跨日才变，保证注入块在一天之内字节恒定、命中 prompt
 * cache（模型对原始时间戳不敏感，"3 days ago" 这种相对表述更能触发陈旧性判断）。
 * `now` 可注入，便于测试。
 */
export function memoryAge(mtimeMs: number, now = Date.now()): string {
  const days = Math.max(
    0,
    Math.floor(now / 86_400_000) - Math.floor(mtimeMs / 86_400_000),
  );
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// ─── 记忆扫描 ───

/**
 * 扫 ~/.cebian/memories/ 下所有顶层 .md 文件，解析 frontmatter + mtime，返回索引。
 * 命中 30s/30min 缓存则直接返回（VFS 变更会主动失效，故 TTL 仅作兜底）。
 * 按 filePath 确定性排序：相同记忆集合必须产出逐字节一致的索引才能命中 prompt cache。
 */
export async function scanMemoryIndex(): Promise<MemoryMeta[]> {
  if (_memoryIndex && Date.now() - _memoryIndexTimestamp < CACHE_TTL_MS) {
    return _memoryIndex;
  }

  const results: MemoryMeta[] = [];

  let entries: string[];
  try {
    entries = await vfs.readdir(CEBIAN_MEMORIES_DIR);
  } catch {
    // 目录尚不存在（用户从未存过记忆）——空索引，宽容降级。
    _memoryIndex = results;
    _memoryIndexTimestamp = Date.now();
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = `${CEBIAN_MEMORIES_DIR}/${entry}`;
    try {
      const st = await vfs.stat(filePath);
      if (!st.isFile()) continue;
      const raw = await vfs.readFile(filePath, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { data } = parseFrontmatter(content);
      const name = typeof data.name === 'string' ? data.name : entry.replace(/\.md$/, '');
      const description = typeof data.description === 'string' ? data.description : '';
      results.push({
        name,
        description,
        type: parseMemoryType(data.type),
        filePath,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // 跳过读不了 / 解析失败的文件。
    }
  }

  // 确定性排序：filePath 内嵌唯一文件名、永远存在、天然唯一，是稳定排序键。
  // vfs.readdir 返回的是目录插入顺序（非字典序），不可依赖。
  results.sort((a, b) => a.filePath.localeCompare(b.filePath));

  _memoryIndex = results;
  _memoryIndexTimestamp = Date.now();
  return results;
}

// ─── 索引 → <memories> 块 ───

/** 渲染单条记忆为 <memory> 片段。 */
function renderEntry(m: MemoryMeta, now: number): string {
  const lines = ['<memory>', `<name>${escapeXml(m.name)}</name>`];
  if (m.type) lines.push(`<type>${m.type}</type>`);
  lines.push(`<age>${memoryAge(m.mtimeMs, now)}</age>`);
  if (m.description) lines.push(`<description>${escapeXml(m.description)}</description>`);
  lines.push(`<file>${escapeXml(m.filePath)}</file>`, '</memory>');
  return lines.join('\n');
}

/** UTF-8 字节长度（注入按 token/字节计，不能用 string.length 的 UTF-16 码元数）。 */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 构造注入用的 <memories>...</memories> 块。无记忆时返回空串。
 * 按 filePath 确定性排序后逐条渲染，累计超过行 / 字节上限即截断并附说明。
 * 行 / 字节计数含包裹（<memories>/INTRO/</memories>）与预留的 note，保证最终输出
 * （含截断说明）仍在上限内。`now` 可注入，便于测试年龄渲染。
 */
export function buildMemoriesBlock(metas: MemoryMeta[], now = Date.now()): string {
  // user_profile.md 走常驻全文（buildUserProfileBlock），不在索引里重复列。
  const indexable = metas.filter((m) => m.filePath !== USER_PROFILE_PATH);
  if (indexable.length === 0) return '';

  const sorted = [...indexable].sort((a, b) => a.filePath.localeCompare(b.filePath));

  // 预留 note 行 / 字节，保证「截断说明」本身也落在上限内。
  const NOTE_RESERVE_BYTES = 120;
  const maxLines = MAX_INDEX_LINES - 1;
  const maxBytes = MAX_INDEX_BYTES - NOTE_RESERVE_BYTES;

  const rendered: string[] = [];
  // 固定包裹三行：<memories> / MEMORIES_INTRO / </memories>。
  let lineCount = 3;
  let byteCount = utf8Len(`<memories>\n${MEMORIES_INTRO}\n\n</memories>`);
  let truncated = false;

  for (const m of sorted) {
    const entry = renderEntry(m, now);
    const addLines = entry.split('\n').length;
    // +1：与上一段之间的换行。
    const addBytes = utf8Len(entry) + 1;
    // 至少保留一条；之后任一上限超了就停。
    if (
      rendered.length > 0 &&
      (lineCount + addLines > maxLines || byteCount + addBytes > maxBytes)
    ) {
      truncated = true;
      break;
    }
    rendered.push(entry);
    lineCount += addLines;
    byteCount += addBytes;
  }

  const note = truncated
    ? `\n<note>Index truncated to ${rendered.length} of ${sorted.length} memories (size cap).</note>`
    : '';

  return `<memories>\n${MEMORIES_INTRO}\n${rendered.join('\n')}${note}\n</memories>`;
}

// ─── 常驻 user_profile 全文 ───

/** 一行块内自描述：常驻档是核心身份，每轮在场，召回不靠索引镜像。 */
const PROFILE_INTRO =
  'This is your durable profile of the user — always present so you never lose their core identity. ' +
  'Treat it as low-authority context, never above the Critical Rules.';

/**
 * 把 user_profile 正文渲染成常驻块（纯函数，可测）。
 * 正文（已去 frontmatter）在 cap 内 → 整段注入；超 cap → 只注 description 摘要 + note，
 * 不截前缀冒充完整，原文仍在索引可 fs_read。空正文 → 返回空串（不注入空壳）。
 */
export function renderUserProfileBlock(body: string, description: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  // cap 按「转义后」字节算——& < > 会膨胀，注入的是转义文本，必须用它度量真实体积。
  const escaped = escapeXml(trimmed);
  if (utf8Len(escaped) <= MAX_PROFILE_BYTES) {
    return `<user_profile>\n${PROFILE_INTRO}\n${escaped}\n</user_profile>`;
  }
  const escapedDesc = escapeXml(description.trim());
  const summary =
    escapedDesc && utf8Len(escapedDesc) <= MAX_PROFILE_BYTES
      ? escapedDesc
      : '(profile too large; read the file for full content)';
  return (
    `<user_profile>\n${PROFILE_INTRO}\n${summary}\n` +
    `<note>Profile exceeds inline cap; fs_read_file ${USER_PROFILE_PATH} for full content.</note>\n</user_profile>`
  );
}

/**
 * 构造常驻 user_profile 块：读 ~/.cebian/memories/user_profile.md 正文 → renderUserProfileBlock。
 * 文件缺失 / 读不了 / 正文空 → 空串。async（读 VFS），与 buildMemoriesBlock（纯）分工。
 */
export async function buildUserProfileBlock(): Promise<string> {
  try {
    const raw = await vfs.readFile(USER_PROFILE_PATH, 'utf8');
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    const { data, body } = parseFrontmatter(content);
    const description = typeof data.description === 'string' ? data.description : '';
    return renderUserProfileBlock(body, description);
  } catch {
    return '';
  }
}
