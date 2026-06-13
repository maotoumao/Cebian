// storage.local 这个备份「源」的采集 / 恢复编排。
//
// 这一层把 BACKUP_REGISTRY 的分类知识翻译成两个 JSON 对象——`config.json`（普通
// 设置，保证无密钥）与 `credentials.json`（密钥信息）——再在恢复时按策略写回。
// 它不认识任何具体 storage key，全部按 registry 的 storageClass 与 splitSecret /
// restoreSecret / fillMissing 钩子工作（registry 是分类知识的单一事实源）。
//
// 混合 item（如 mcpServers）：safe 部分进 config、secret 部分进 credentials。恢复
// 分两步：先按 storageClass 写 safe（settings），再把 secret 写回（credentials），
// 二者解耦，故 credentials-only 恢复也能补回密钥。

import { BACKUP_REGISTRY } from '../registry';
import type { RestoreStrategy } from '../types';

/** 采集结果。`config` / `credentials` 仅在对应分类被选时存在。 */
export interface CollectedStorage {
  /** 普通设置（无密钥）。键是 storage key。 */
  config?: Record<string, unknown>;
  /** 密钥信息。键是 storage key。 */
  credentials?: Record<string, unknown>;
}

/** 判断一个值是否「空」——用于 credentials 补缺时判断本地是否缺该项。 */
function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** 恢复时的策略与已选分类。 */
export interface StorageRestorePlan {
  strategy: RestoreStrategy;
  settings: boolean;
  credentials: boolean;
}

/** 逐分类的恢复结果（写入项数），供 UI 反馈。 */
export interface StorageRestoreResult {
  settingsWritten: number;
  credentialsWritten: number;
}

// ─── 源的公开 API（供顶层 collect / restore 编排调用） ───

/**
 * 采集 storage 分类。`settings` / `credentials` 分别控制是否产出对应对象；未选的
 * 分类返回 undefined（其内容——包括混合 item 拆出的 secret——不会被序列化，杜绝
 * 泄漏）。
 */
export async function collectStorage(opts: {
  settings: boolean;
  credentials: boolean;
}): Promise<CollectedStorage> {
  const config: Record<string, unknown> = {};
  const credentials: Record<string, unknown> = {};

  for (const entry of BACKUP_REGISTRY) {
    if (entry.storageClass === 'exclude') continue;
    const key = entry.item.key;
    const value = await entry.item.getValue();

    if (entry.storageClass === 'settings') {
      if (entry.splitSecret) {
        const { safe, secret } = entry.splitSecret(value);
        config[key] = safe;
        if (!isEmptyValue(secret)) credentials[key] = secret;
      } else {
        config[key] = value;
      }
    } else {
      // credentials-class item
      credentials[key] = value;
    }
  }

  return {
    config: opts.settings ? config : undefined,
    credentials: opts.credentials ? credentials : undefined,
  };
}

/**
 * 把采集到的 storage 数据按策略写回。分两步处理，把「写 safe 配置」与「写密钥」
 * 解耦，使混合 item 的密钥能独立随 credentials 分类恢复：
 *
 * 1. 普通设置（settings-class，含混合 item 的 safe 配置）：
 *    - `replace`：用备份 safe 覆盖（config 视为不可信输入，混合 item 先重新剥一次，
 *      丢弃任何残留密钥，只写 safe，token 留空）。
 *    - `merge`：仅对声明了 `fillMissing` 的 item（列表型，如 customProviders /
 *      mcpServers）按 id 补缺；未声明的标量项保留本地、不写（§6）。
 * 2. 密钥（随 credentials 分类，独立于 settings）：
 *    - credentials-class item：`replace` 覆盖；`merge` 调 `fillMissing` 补缺。
 *    - 混合 item（settings-class 但 secret 在 credentials.json）：调 `restoreSecret`
 *      把 secret 按策略写进本地完整值（在步骤 1 之后，故能叠加到刚写入的 safe 上）。
 */
export async function restoreStorage(
  data: CollectedStorage,
  plan: StorageRestorePlan,
): Promise<StorageRestoreResult> {
  let settingsWritten = 0;
  let credentialsWritten = 0;

  const config = data.config ?? {};
  const credentials = data.credentials ?? {};

  // ── 步骤 1：写 settings 的 safe 配置 ──
  // replace：用备份 safe 覆盖。
  // merge：仅对声明了 `fillMissing` 的 item 做「按 id 补缺」（如 customProviders /
  //        mcpServers 列表）；未声明的标量（theme / maxRounds 等）保留本地、不写。
  if (plan.settings) {
    for (const entry of BACKUP_REGISTRY) {
      if (entry.storageClass !== 'settings') continue;
      const key = entry.item.key;
      if (!(key in config)) continue;
      // config 视为不可信输入：混合 item 先重新剥一次，丢弃残留密钥，只保留 safe。
      let backupSafe = config[key];
      if (entry.splitSecret) backupSafe = entry.splitSecret(backupSafe).safe;

      if (plan.strategy === 'replace') {
        await entry.item.setValue(backupSafe);
        settingsWritten++;
      } else if (entry.fillMissing) {
        // 合并：本地优先、按 id 补缺备份里多出来的。
        const local = await entry.item.getValue();
        await entry.item.setValue(entry.fillMissing(local, backupSafe));
        settingsWritten++;
      }
    }
  }

  // ── 步骤 2：写密钥（随 credentials 分类） ──
  if (plan.credentials) {
    for (const entry of BACKUP_REGISTRY) {
      if (entry.storageClass === 'exclude') continue;
      const key = entry.item.key;

      if (entry.storageClass === 'settings') {
        // 混合 item 的密钥：把 secret 按策略写进本地完整值（步骤 1 已写好 safe）。
        if (!entry.restoreSecret) continue;
        if (!(key in credentials)) continue;
        const local = await entry.item.getValue();
        await entry.item.setValue(entry.restoreSecret(local, credentials[key], plan.strategy));
        credentialsWritten++;
        continue;
      }

      // credentials-class item。
      if (!(key in credentials)) continue;
      const backup = credentials[key];
      if (plan.strategy === 'replace') {
        await entry.item.setValue(backup);
      } else {
        // merge = 补缺。credentials-class entry 必须声明 fillMissing
        // （registry.test.ts 覆盖性测试强制），故此处直接调用，无静默兜底。
        const local = await entry.item.getValue();
        await entry.item.setValue(entry.fillMissing!(local, backup));
      }
      credentialsWritten++;
    }
  }

  return { settingsWritten, credentialsWritten };
}
