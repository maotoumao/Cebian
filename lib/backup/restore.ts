// 顶层恢复编排：把一个备份 zip 拆开，按用户计划分发给三个源的恢复。
//
// 本文件只做版本校验 + 跨源分发，不碰后端细节。先 unpackArchive（含解密），再据
// RestorePlan 的策略与已选分类，调各 sources/*.ts 的 restore。

import { unpackArchive, readManifest, type BackupBundle } from './archive';
import { restoreStorage, type StorageRestoreResult } from './sources/storage';
import { restoreSessions, type ApplySessionsResult } from './sources/sessions';
import { restoreVfs, type VfsRestoreResult } from './sources/vfs';
import { PAYLOAD_FILES, sessionIdFromFileKey, SKILLS_PROMPTS_ROOTS } from './payload-format';
import { WORKSPACES_ROOT } from '@/lib/constants';
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type RestorePlan,
} from './types';
import { isValidSessionLike, type SessionRecord as DbSessionRecord } from '@/lib/db';

const decoder = new TextDecoder();

/** 逐源恢复结果（仅恢复了的源有值），供 UI 反馈。 */
export interface RestoreResult {
  storage?: StorageRestoreResult;
  sessions?: ApplySessionsResult;
  vfs?: VfsRestoreResult;
}

/** 恢复失败的本地化错误码。 */
export type RestoreErrorCode = 'incompatibleVersion' | 'corruptBackup';

export class RestoreError extends Error {
  constructor(readonly code: RestoreErrorCode, message?: string) {
    super(message ?? `RestoreError(${code})`);
    this.name = 'RestoreError';
  }
}

/** 解析一段 JSON 字节；失败统一翻成 `corruptBackup`，避免原始 SyntaxError 冒到 UI。
 *  `name` 仅用于错误信息定位，不展示给用户。 */
function parseJsonBytes<T>(bytes: Uint8Array, name: string): T {
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    throw new RestoreError('corruptBackup', `Backup file ${name} is not valid JSON`);
  }
}

/** 解析 payload 里的一个 JSON 文件；不存在则返回 undefined，损坏则抛 corruptBackup。 */
function parseJson<T>(bundle: BackupBundle, name: string): T | undefined {
  const bytes = bundle.files[name];
  if (!bytes) return undefined;
  return parseJsonBytes<T>(bytes, name);
}

/** 读取 manifest 声明「包含」的分类必有的 payload 文件；缺失视为损坏包并抛错，避免
 *  在替换模式下把「缺失」误当成「空」而破坏性清空本地数据。 */
function requirePayload(bundle: BackupBundle, name: string): Uint8Array {
  const bytes = bundle.files[name];
  if (!bytes) {
    throw new RestoreError('corruptBackup', `Backup marks data present but ${name} is missing`);
  }
  return bytes;
}

/** 校验备份格式版本是否可读。比当前更高的 formatVersion 是未来格式，拒绝。 */
function assertCompatible(manifest: BackupManifest): void {
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new RestoreError(
      'incompatibleVersion',
      `Backup format v${manifest.formatVersion} is newer than supported v${BACKUP_FORMAT_VERSION}`,
    );
  }
}

/**
 * 只读取并校验 manifest，供恢复前预览（不解密、不需要口令）。
 */
export function inspectBackup(zipBytes: Uint8Array): BackupManifest {
  const manifest = readManifest(zipBytes);
  assertCompatible(manifest);
  return manifest;
}

/**
 * 按计划恢复一个备份。`password` 仅加密包需要。`plan.categories` 是用户选择恢复的
 * 分类（应已与备份实际含有的分类取交集）。
 *
 * 工作区文件的恢复绑定到 `sessions` 分类——当用户恢复会话且备份含工作区时一并还原
 * （路径里带 sessionId，天然跟随对应会话）。
 */
export async function restoreBackup(
  zipBytes: Uint8Array,
  password: string | undefined,
  plan: RestorePlan,
): Promise<RestoreResult> {
  const bundle = await unpackArchive(zipBytes, password);
  assertCompatible(bundle.manifest);

  // 只恢复「用户勾选」且「备份确实包含」的分类——交集。挡掉「备份没有该分类、但
  // plan 仍点了它」时被破坏性清空本地数据（替换模式）的风险。
  const summaries = bundle.manifest.categories;
  const cats = new Set(
    plan.categories.filter((c) => summaries[c]?.included),
  );
  const result: RestoreResult = {};

  // ─ storage ─
  if (cats.has('settings') || cats.has('credentials')) {
    // settings 包含则 config.json 必在（collect 总会写）；缺失视为损坏。credentials
    // 可能为空而合法缺省，故用可选解析。
    const config = cats.has('settings')
      ? parseJsonBytes<Record<string, unknown>>(requirePayload(bundle, PAYLOAD_FILES.config), PAYLOAD_FILES.config)
      : undefined;
    result.storage = await restoreStorage(
      {
        config,
        credentials: parseJson(bundle, PAYLOAD_FILES.credentials),
      },
      { strategy: plan.strategy, settings: cats.has('settings'), credentials: cats.has('credentials') },
    );
  }

  // ─ sessions ─
  if (cats.has('sessions')) {
    // 会话拆成 payload/sessions/{id}.json 多个文件；逐个解析聚合成数组。文件名 id
    // 必须是合法 UUID 且与内容 record.id 一致，挡住畸形 id 写进 Dexie。
    const records: DbSessionRecord[] = [];
    for (const key of Object.keys(bundle.files)) {
      const fileId = sessionIdFromFileKey(key);
      if (fileId === null) continue;
      const rec = parseJsonBytes<DbSessionRecord>(bundle.files[key], key);
      if (rec.id !== fileId) {
        throw new RestoreError('corruptBackup', `Session file ${key} id mismatch`);
      }
      // 关键字段校验放在 page 侧、写库之前：畸形记录归为 corruptBackup 并本地化展示，
      // 不必等到 background IPC 拒绝时才抛出未翻译的技术错误（background 仍保留同一守卫
      // 作纵深防御）。
      if (!isValidSessionLike(rec)) {
        throw new RestoreError('corruptBackup', `Session file ${key} has invalid fields`);
      }
      records.push(rec);
    }
    // manifest 声明的会话数与实际文件数不符（截断 / 损坏）→ 报错，避免替换模式下
    // 清空本地后只还原出部分会话。
    const declared = summaries.sessions.count;
    if (declared !== undefined && records.length !== declared) {
      throw new RestoreError(
        'corruptBackup',
        `Backup declares ${declared} sessions but contains ${records.length}`,
      );
    }
    result.sessions = await restoreSessions(records, plan.strategy);
  }

  // ─ vfs ─
  const roots: string[] = [];
  if (cats.has('skillsPrompts')) roots.push(...SKILLS_PROMPTS_ROOTS);
  if (cats.has('sessions') && summaries.sessions.workspaces) {
    roots.push(WORKSPACES_ROOT);
  }
  if (roots.length > 0) {
    const index = parseJson<Record<string, number>>(bundle, PAYLOAD_FILES.vfsIndex) ?? {};
    result.vfs = await restoreVfs(bundle.files, index, roots, plan.strategy);
  }

  return result;
}
