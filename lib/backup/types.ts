// 备份与恢复的共享类型词汇。
//
// 这里只放跨任务复用的契约：manifest 结构、备份分类、恢复策略 / 计划。
// 具体的 config.json / credentials.json / sessions/{uuid}.json 负载形状由 collect /
// restore 阶段定义，不在此处提前固化。

/** 备份包格式版本。bump 意味着 unpack 需要迁移或拒绝旧包。 */
export const BACKUP_FORMAT_VERSION = 1;

/** 用户可见的四个备份分类（见需求文档 §2）。 */
export type BackupCategory = 'sessions' | 'settings' | 'skillsPrompts' | 'credentials';

/** 恢复语义：merge = 只增不减；replace = 清空后照搬。 */
export type RestoreStrategy = 'merge' | 'replace';

// ─── manifest（始终明文，恢复前可读） ───

/** 加密元信息。salt / iv 随机且非敏感，放明文是密码学标准做法。 */
export interface BackupEncryptionMeta {
  algo: 'AES-GCM';
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  /** base64 编码的随机 salt。 */
  salt: string;
  /** base64 编码的随机 IV。 */
  iv: string;
}

/** 「会话记录」分类在 manifest 中的摘要。 */
export interface SessionsCategorySummary {
  included: boolean;
  /** 会话条目数。 */
  count?: number;
  /** 是否一并备份了工作区文件。 */
  workspaces?: boolean;
}

/** 「普通设置」分类摘要。 */
export interface SettingsCategorySummary {
  included: boolean;
}

/** 「密钥信息」分类摘要。 */
export interface CredentialsCategorySummary {
  included: boolean;
  // 不带条目数：密钥按不同存储项（provider / mcp / webdav）形状各异，没有统一且
  // 解耦的「条数」口径，故 UI 不展示数字（只展示是否包含）。
}

/** 「技能与提示词」分类摘要。 */
export interface SkillsPromptsCategorySummary {
  included: boolean;
  fileCount?: number;
}

/** manifest 的 categories 块：各分类是否包含 + 条目数（无敏感值）。 */
export interface BackupCategorySummaries {
  sessions: SessionsCategorySummary;
  settings: SettingsCategorySummary;
  credentials: CredentialsCategorySummary;
  skillsPrompts: SkillsPromptsCategorySummary;
}

/** 一个 VFS 分类的归属：一组根目录前缀 + 该分类下的文件数。单根分类（如
 *  工作区）写成只含一个根的 `roots`。 */
export interface VfsRootGroup {
  roots: string[];
  fileCount: number;
}

/**
 * VFS 分类归属：不靠目录划分类，而是声明每类对应的「路径前缀」，恢复时按前缀
 * 过滤 vfs/ 内容决定哪些写回。分类与目录解耦。
 */
export interface BackupVfsManifest {
  skillsPrompts?: VfsRootGroup;
  workspaces?: VfsRootGroup;
}

/** 备份包的明文 manifest（见需求文档 §8.3）。 */
export interface BackupManifest {
  formatVersion: number;
  app: 'cebian';
  /** 来源扩展版本。 */
  appVersion: string;
  createdAt: number;
  name: string;
  description: string;
  encrypted: boolean;
  /** 仅当 encrypted=true 时存在；不含口令、不含明文数据。 */
  encryption?: BackupEncryptionMeta;
  categories: BackupCategorySummaries;
  vfs?: BackupVfsManifest;
}

// ─── 创建 / 恢复时的用户选择 ───

/** 创建备份时的用户选择。 */
export interface BackupOptions {
  name: string;
  description: string;
  /** 勾选的分类。 */
  categories: BackupCategory[];
  /** 「会话记录」下的子选项：是否一并备份工作区文件。 */
  includeWorkspaces: boolean;
  /** 设置则启用口令加密；不设则明文。 */
  password?: string;
}

/** 恢复时的用户选择。 */
export interface RestorePlan {
  strategy: RestoreStrategy;
  /** 要恢复的分类（取备份含有的与用户勾选的交集）。 */
  categories: BackupCategory[];
}
