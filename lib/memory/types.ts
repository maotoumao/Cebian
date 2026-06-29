// ─── 跨对话记忆：领域类型 ───
//
// 这里放「运行时领域类型」（frontmatter 分类、索引元数据）——与持久化形状不同，
// 后者（MemorySettings）按仓库约定住在 lib/persistence/storage.ts。

/** 封闭的记忆分类法。每条记忆文件 frontmatter 的 `type` 取这四类之一。 */
export const MEMORY_TYPES = ['user', 'feedback', 'context', 'reference'] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * 把 frontmatter 里的原始 `type` 值解析成 MemoryType。
 * 非字符串 / 未知值返回 undefined——缺失或非法 type 的记忆仍纳入索引（宽容降级），
 * 只是不带类型标注。
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  return MEMORY_TYPES.find((t) => t === raw);
}

/**
 * 一条记忆在索引里的元数据：扫描 frontmatter（name / description / type）+ `vfs.stat`
 * 的 mtime 得到。正文不在此处——agent 按需 `fs_read_file` 读 `filePath` 全文。
 */
export interface MemoryMeta {
  /** 展示名（frontmatter `name`，缺省回退文件名去扩展名）。 */
  name: string;
  /** 一句话描述，供未来对话判断相关性。 */
  description: string;
  /** 分类；缺失 / 非法时 undefined。 */
  type?: MemoryType;
  /** tilde 形式的绝对路径，如 `~/.cebian/memories/user_role.md`。 */
  filePath: string;
  /** 最后修改时间（用于老化标注）。 */
  mtimeMs: number;
}
