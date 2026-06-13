// 备份的 storage 分类「唯一事实源」。
//
// 「哪个 storage item 属于哪一类、哪些 key 是密钥」的知识全部收敛在这里，
// collect / restore 不认识具体 key，只按 storageClass 与 split/merge 钩子工作。
// 新增 storage item 时必须在 BACKUP_REGISTRY 登记，否则覆盖性测试会失败
// （见 lib/backup/registry.test.ts）。

import type { WxtStorageItem } from 'wxt/utils/storage';
import type { RestoreStrategy } from './types';
import {
  activeModel,
  customProviders,
  userInstructions,
  maxRounds,
  themePreference,
  thinkingLevel,
  mcpServers,
  providerCredentials,
  webdavConfig,
  settingsFilePanelWidth,
  lastSettingsSection,
  updateNoticeState,
  type MCPServerConfig,
  type ProviderCredentials,
  type WebDavConfig,
  type CustomProviderConfig,
} from '@/lib/storage';

/**
 * 一个 storage item 在备份中的归属：
 * - `settings`：进 config.json（普通设置，保证无密钥）。
 * - `credentials`：进 credentials.json（密钥信息，默认不备份、可加密）。
 * - `exclude`：纯本机 UI 状态，备份无意义，不进任何分类。
 */
export type StorageClass = 'settings' | 'credentials' | 'exclude';

/**
 * 注册表条目。`splitSecret` 把一个「混合 item」（既含设置又含密钥，如 mcpServers）
 * 拆出无密钥的 `safe`（进 settings）与抽离的 `secret`（进 credentials）。
 * `restoreSecret` 在恢复 credentials 分类时，把备份 secret 按策略写进本地完整值。
 * `fillMissing` 是合并模式的「补缺」钩子，与 storageClass 解耦：credentials 类 item 必
 * 须声明；settings 类的列表项（customProviders / mcpServers）可选声明以获得「按 id
 * 补缺」；未声明的标量 settings 项在 merge 下保留本地。
 */
export interface BackupEntry<T> {
  item: WxtStorageItem<T, any>;
  storageClass: StorageClass;
  /** 把值拆成无密钥的 `safe` 与抽离出的 `secret`。仅混合 item 需要。 */
  splitSecret?: (value: T) => { safe: T; secret: unknown };
  /**
   * 把备份 `secret` 按策略写进本地完整值 `local`，返回新值。仅混合 item 需要，随
   * credentials 分类恢复（独立于 settings）。`replace` 覆盖本地同 id 的密钥，
   * `merge` 仅补本地缺失的密钥。
   */
  restoreSecret?: (local: T, secret: unknown, strategy: RestoreStrategy) => T;
  /**
   * 合并模式恢复时如何「补缺」：给定本地现值 `local` 与备份值 `backup`，返回写回
   * 的值。语义是「只增不减」——本地有的全保留，备份里本地没有的补入。与
   * storageClass 解耦：credentials 类必须声明；settings 类的列表项可选声明。
   */
  fillMissing?: (local: T, backup: T) => T;
}

// ─── mcpServers 的密钥拆分 / 重组 ───
//
// 贴着 mcpServers 注册项放在一起：分类、拆分、重组三件事同一处，不漂移。
// 一个 server 的密钥有两处来源，都必须抽到 credentials 分类，绝不能留在
// config.json（普通设置承诺不含敏感值）：
//   1. `auth.token`（bearer token）。
//   2. `transport.headers`——用户可在表单里自定义任意 header，常承载
//      `Authorization` / `X-Api-Key` 等密钥。无法可靠区分敏感与否，保守地
//      把全部用户自定义 header 视为密钥。

/** 一个 server 抽离出的密钥。字段都可选——仅在该 server 确有对应密钥时出现。 */
export interface McpServerSecret {
  /** bearer token。 */
  token?: string;
  /** 用户自定义的 transport headers（整体视为密钥）。 */
  headers?: Record<string, string>;
}

/** mcpServers 抽离出的密钥部分：serverId → 该 server 的密钥。 */
export type McpSecretMap = Record<string, McpServerSecret>;

/**
 * 把每个 server 的 bearer token 与自定义 headers 抽到 secret，`safe` 中：
 * - 保留 bearer 类型但清空 token（空串）——这样恢复设置但未恢复密钥时，UI 仍
 *   显示该 server 需要 bearer 鉴权、只是 token 待填，而不是被误判为「无需鉴权」。
 * - 移除 `transport.headers`——避免任意 header 里的密钥泄进 config.json。
 *
 * 返回全新对象（含 transport / auth 的浅拷贝），不与入参共享引用、不修改入参。
 */
export function splitMcpTokens(
  servers: MCPServerConfig[],
): { safe: MCPServerConfig[]; secret: McpSecretMap } {
  const secret: McpSecretMap = {};
  const safe = servers.map((s) => {
    const entrySecret: McpServerSecret = {};

    // transport.headers 整体视为密钥。
    const { headers, ...transportRest } = s.transport;
    if (headers && Object.keys(headers).length > 0) {
      entrySecret.headers = headers;
    }
    const safeTransport = { ...transportRest };

    // auth.token（bearer）视为密钥。
    let safeAuth: MCPServerConfig['auth'];
    switch (s.auth.type) {
      case 'none':
        safeAuth = { type: 'none' };
        break;
      case 'bearer':
        entrySecret.token = s.auth.token;
        safeAuth = { type: 'bearer', token: '' };
        break;
      default: {
        // 穷尽检查：未来给 MCPAuthConfig 加新 type（如 oauth2）而未更新此处，
        // TS 编译不过，强制同步密钥拆分逻辑。
        const _exhaustive: never = s.auth;
        return _exhaustive;
      }
    }

    if (Object.keys(entrySecret).length > 0) {
      secret[s.id] = entrySecret;
    }
    return { ...s, transport: safeTransport, auth: safeAuth };
  });
  return { safe, secret };
}

/**
 * 把备份 secret 按策略写进本地完整的 mcpServers 值。只作用于本地已存在的同 id
 * server——备份 secret 里有它的 token / headers 就应用。返回全新对象，不改入参。
 *
 * - `replace`：覆盖本地该 server 的 token / headers。
 * - `merge`：仅补本地缺失的部分（本地 token 非空 / 已有 headers 则保留本地）。
 *
 * 注意：本函数不新增本地不存在的 server——secret 只携带密钥，没有重建一个完整
 * server 配置所需的 name / transport.url 等。新增 server 属于 settings 分类的职责。
 */
export function restoreMcpSecrets(
  local: MCPServerConfig[],
  secret: McpSecretMap,
  strategy: RestoreStrategy,
): MCPServerConfig[] {
  return local.map((s) => {
    const sec = secret[s.id];
    if (!sec) return { ...s };

    // headers：replace 覆盖；merge 仅本地无 headers 时补。
    let headers = s.transport.headers;
    if (sec.headers) {
      headers = strategy === 'replace' ? sec.headers : headers ?? sec.headers;
    }
    const transport = headers ? { ...s.transport, headers } : { ...s.transport };

    // token：replace 覆盖；merge 仅本地 token 为空时补。
    let auth = s.auth;
    if (sec.token != null && s.auth.type === 'bearer') {
      const token = strategy === 'replace' ? sec.token : s.auth.token || sec.token;
      auth = { type: 'bearer', token };
    }

    return { ...s, transport, auth };
  });
}

// ─── 合并模式的「按 id 补缺」通用助手 ───
//
// 合并（merge）恢复对集合型 item 的语义是「只增不减」：本地元素全保留，备份里 id
// 不在本地的元素追加进来。粒度按元素 id，避免对整个数组判空（本地非空就丢掉备份
// 的不同元素）。数组的 id 字段名由 `idOf` 参数化，故同一助手可用于 customProviders
// 与 mcpServers 等不同形态。

/** 数组按 id 补缺：本地全保留，备份里 id 不在本地、且备份内部首次出现的元素追加。
 *  备份内部重复 id 只取首个（损坏 / 手改包可能有重复），不把重复灌进本地。不改入参。 */
function fillMissingById<T>(local: T[], backup: T[], idOf: (item: T) => string): T[] {
  const seen = new Set(local.map(idOf));
  const out = [...local];
  for (const b of backup) {
    const id = idOf(b);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(b);
  }
  return out;
}

// ─── 注册表 ───

/**
 * 类型化构造一个注册表条目：保持 `item` 的 value 类型与 split/merge 钩子的参数
 * 类型联动，同时把异质条目收进 `BackupEntry<any>[]`。新增混合 item 时若 hook
 * 的类型与 item 不匹配，会在此处编译失败。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function entry<T>(e: BackupEntry<T>): BackupEntry<any> {
  return e;
}

/**
 * 全部参与备份分类的 storage item。新增 item 必须在此登记（含 `exclude`），
 * 否则 lib/backup/registry.test.ts 会失败。
 */
export const BACKUP_REGISTRY: BackupEntry<any>[] = [
  entry({ item: activeModel, storageClass: 'settings' }),
  entry({
    item: customProviders,
    storageClass: 'settings',
    // 合并：按 provider id 补缺——本地已配置的 provider 保留本地，备份里本地没有
    // 的 provider 补入（其 API key 由 providerCredentials 的补缺一并恢复）。
    fillMissing: (local: CustomProviderConfig[], backup: CustomProviderConfig[]) =>
      fillMissingById(local, backup, (p) => p.id),
  }),
  entry({ item: userInstructions, storageClass: 'settings' }),
  entry({ item: maxRounds, storageClass: 'settings' }),
  entry({ item: themePreference, storageClass: 'settings' }),
  entry({ item: thinkingLevel, storageClass: 'settings' }),
  entry({
    item: mcpServers,
    storageClass: 'settings',
    splitSecret: (v: MCPServerConfig[]) => splitMcpTokens(v),
    restoreSecret: (local: MCPServerConfig[], secret: unknown, strategy) =>
      restoreMcpSecrets(local, (secret ?? {}) as McpSecretMap, strategy),
    // 合并：按 server id 补缺本地缺失的 server（safe 配置）；其密钥由 restoreSecret
    // 一并恢复。备份里的 safe server 已被 splitSecret 清空 token，补入后 token 待
    // restoreSecret 填（credentials 分类也选时）。
    fillMissing: (local: MCPServerConfig[], backup: MCPServerConfig[]) =>
      fillMissingById(local, backup, (s) => s.id),
  }),
  entry({
    item: providerCredentials,
    storageClass: 'credentials',
    // 补缺：逐 provider 填缺。展开 backup 打底、local 覆盖 → 本地已有的
    // provider 保留本地，本地缺的从备份补入。
    fillMissing: (local: ProviderCredentials, backup: ProviderCredentials) => ({
      ...backup,
      ...local,
    }),
  }),
  entry({
    item: webdavConfig,
    storageClass: 'credentials',
    // 补缺：本地已配置则保留本地，仅在本地为 null 时从备份补入。
    fillMissing: (local: WebDavConfig | null, backup: WebDavConfig | null) =>
      local ?? backup,
  }),
  entry({ item: settingsFilePanelWidth, storageClass: 'exclude' }),
  entry({ item: lastSettingsSection, storageClass: 'exclude' }),
  entry({ item: updateNoticeState, storageClass: 'exclude' }),
];

/** BACKUP_REGISTRY 中所有已登记的 storage key 集合（供覆盖性测试比对）。 */
export function registeredStorageKeys(): Set<string> {
  return new Set(BACKUP_REGISTRY.map((e) => e.item.key));
}
