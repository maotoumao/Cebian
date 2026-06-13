// 备份包的容器格式：内存模型 ↔ zip 字节。
//
// 这一层只懂「容器结构」，不懂 config.json / sessions/{uuid}.json 的语义——那是
// collect / restore 的职责。它消费 / 产出一个与数据来源无关的 BackupBundle：
// manifest（明文）+ 一组 payload 文件（path → bytes）。
//
// 容器结构（见需求文档 §8）：根目录只放容器元信息，备份数据全部落在 `payload/`
// 子目录下，二者物理隔离——这样用户 VFS 里任何文件名（含 `manifest.json` /
// `payload.enc`，例如未来 workspace 跑 React 应用）都因为多了一层 `payload/`
// 前缀而不可能和容器结构撞名。
//   未加密：外层 zip = manifest.json + payload/<各 payload 文件>。
//   加密  ：payload 文件先打成内层 zip（仍带 `payload/` 前缀）→ AES-GCM 加密 →
//           payload.enc；外层 zip = manifest.json + payload.enc。
// manifest.json 始终明文、独占根目录，恢复前可读。

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { isJunkPath, isSafeRelPath } from '@/lib/vfs';
import { encryptPayload, decryptPayload } from './crypto';
import type { BackupManifest } from './types';

/** 外层 zip 中 manifest 文件名（始终明文、独占根目录）。 */
const MANIFEST_NAME = 'manifest.json';
/** 加密形态下密文负载的文件名。 */
const PAYLOAD_ENC_NAME = 'payload.enc';
/** 备份数据在 zip 内的目录前缀。所有 payload 文件都落在这里，与根目录的容器
 *  元信息（manifest.json / payload.enc）物理隔离。 */
const PAYLOAD_DIR = 'payload/';

/**
 * 备份包的内存表示。
 * - `manifest`：明文元信息。
 * - `files`：payload 文件，key 是**裸逻辑路径**（不含 `payload/` 前缀），形如
 *   `config.json` / `sessions/{uuid}.json` / `vfs/home/user/.cebian/skills/foo/SKILL.md`，
 *   value 是原始字节。`payload/` 前缀是容器格式细节，由本模块在打包时添加、
 *   解包时剥离，collect / restore 看不到它。
 */
export interface BackupBundle {
  manifest: BackupManifest;
  files: Record<string, Uint8Array>;
}

/** archive 层的本地化错误码，UI 据此映射文案。 */
export type BackupArchiveErrorCode =
  // 不是合法 zip / 缺 manifest.json / 容器结构被破坏 / 解析失败
  | 'invalid'
  // 加密包但未提供口令
  | 'passwordRequired'
  // 口令错误或密文被篡改（GCM 认证失败）
  | 'wrongPassword'
  // payload 中存在可逃逸的路径（zip-slip）
  | 'unsafePath';

export class BackupArchiveError extends Error {
  constructor(readonly code: BackupArchiveErrorCode, message?: string) {
    super(message ?? `BackupArchiveError(${code})`);
    this.name = 'BackupArchiveError';
  }
}

/** 把 bundle 的裸 payload 文件加上 `payload/` 前缀，得到可直接 zip 的条目表。
 *  打包前对每个裸路径做 zip-slip 校验，保证生成的包能被 unpackArchive 接受。 */
function toPayloadEntries(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [rel, bytes] of Object.entries(files)) {
    if (!isSafeRelPath(rel)) {
      throw new BackupArchiveError('unsafePath', `Unsafe payload path: ${rel}`);
    }
    out[PAYLOAD_DIR + rel] = bytes;
  }
  return out;
}

/** 从一组 zip 条目中取出 payload 文件并剥掉 `payload/` 前缀。
 *
 *  - `payload/` 下的条目一律视为**真实备份数据**：剥前缀、做 zip-slip 校验后保留。
 *    绝不对它们做垃圾文件过滤——用户 VFS 里完全可能有名为 `.DS_Store` /
 *    `Thumbs.db` 的真实文件（`payload/vfs/.../.DS_Store`），过滤会破坏往返。
 *  - 不在 `payload/` 下的条目是根级条目：仅 `allowedRootFiles` 里的容器文件可被
 *    跳过；根级垃圾文件（OS 重新打包引入的 `__MACOSX/` / `.DS_Store`）容忍丢弃；
 *    其余一律视为破坏容器结构 → `invalid`。
 *  - 目录条目（以 `/` 结尾，含 `payload/` 自身）一律跳过。
 */
function fromPayloadEntries(
  entries: Record<string, Uint8Array>,
  allowedRootFiles: Set<string>,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    // 跳过目录条目（含 `payload/` 自身）
    if (path.endsWith('/')) continue;

    if (path.startsWith(PAYLOAD_DIR)) {
      // payload/ 下一律是真实数据，不做垃圾过滤。
      const rel = path.slice(PAYLOAD_DIR.length);
      if (!isSafeRelPath(rel)) {
        throw new BackupArchiveError('unsafePath', `Unsafe path in backup: ${path}`);
      }
      files[rel] = bytes;
      continue;
    }

    // 根级条目：放过约定的容器文件与 OS 垃圾，其余视为破坏容器结构。
    if (allowedRootFiles.has(path)) continue;
    if (isJunkPath(path)) continue;
    throw new BackupArchiveError('invalid', `Unexpected entry outside payload/: ${path}`);
  }
  return files;
}

/**
 * 把 bundle 打成 `.zip` 字节。
 *
 * `password` 提供时启用 AES-GCM 加密：带前缀的 payload 文件先打成内层 zip 再整体
 * 加密。无论是否加密，都由本函数最终敲定 manifest 的 `encrypted` / `encryption`
 * 字段（加密状态的单一事实源），调用方传入的 manifest 这两个字段会被覆盖。
 */
export async function packArchive(
  bundle: BackupBundle,
  password?: string,
): Promise<Uint8Array> {
  const payloadEntries = toPayloadEntries(bundle.files);

  if (password) {
    const innerZip = zipSync(payloadEntries);
    const { ciphertext, meta } = await encryptPayload(innerZip, password);
    const manifest: BackupManifest = { ...bundle.manifest, encrypted: true, encryption: meta };
    return zipSync({
      [MANIFEST_NAME]: strToU8(JSON.stringify(manifest, null, 2)),
      [PAYLOAD_ENC_NAME]: ciphertext,
    });
  }

  const manifest: BackupManifest = { ...bundle.manifest, encrypted: false };
  delete manifest.encryption;
  return zipSync({
    ...payloadEntries,
    [MANIFEST_NAME]: strToU8(JSON.stringify(manifest, null, 2)),
  });
}

/** 解析并校验 manifest.json 的运行时结构。manifest 来自外部文件，TS 字面量类型
 *  不约束运行时输入——畸形 manifest 必须在这里被挡住并统一报 `invalid`，避免后续
 *  误把「格式损坏」当成「口令错误」。仅做结构校验，不做版本兼容判断（那是 restore）。 */
function parseManifest(raw: Uint8Array): BackupManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(strFromU8(raw));
  } catch {
    throw new BackupArchiveError('invalid', 'manifest.json is not valid JSON');
  }
  const bad = (why: string): never => {
    throw new BackupArchiveError('invalid', `manifest.json invalid: ${why}`);
  };

  if (!obj || typeof obj !== 'object') bad('not an object');
  const m = obj as Record<string, unknown>;

  if (typeof m.formatVersion !== 'number') bad('formatVersion');
  if (m.app !== 'cebian') bad('app');
  if (typeof m.appVersion !== 'string') bad('appVersion');
  if (typeof m.createdAt !== 'number') bad('createdAt');
  if (typeof m.name !== 'string') bad('name');
  if (typeof m.description !== 'string') bad('description');
  if (typeof m.encrypted !== 'boolean') bad('encrypted');

  // categories：四个分类都必须存在且各带 boolean `included`。
  const cats = m.categories as Record<string, unknown> | undefined;
  if (!cats || typeof cats !== 'object') bad('categories');
  for (const key of ['sessions', 'settings', 'credentials', 'skillsPrompts'] as const) {
    const c = (cats as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object' || typeof c.included !== 'boolean') {
      bad(`categories.${key}`);
    }
  }

  // 加密包必须带结构完整的 encryption 元信息（值的进一步校验在 crypto 解密时做）。
  if (m.encrypted) {
    const e = m.encryption as Record<string, unknown> | undefined;
    if (
      !e ||
      typeof e !== 'object' ||
      e.algo !== 'AES-GCM' ||
      e.kdf !== 'PBKDF2' ||
      e.hash !== 'SHA-256' ||
      typeof e.iterations !== 'number' ||
      typeof e.salt !== 'string' ||
      typeof e.iv !== 'string'
    ) {
      bad('encryption');
    }
  }

  return m as unknown as BackupManifest;
}

/** 读取外层 zip 并取出 manifest 字节（不解密 payload）。当 manifest 标记加密时，
 *  强制外层只含 manifest.json + payload.enc（外加可忽略的目录/垃圾条目），否则
 *  视为破坏了容器不变量（§8.2）的非法包。 */
function openOuter(zipBytes: Uint8Array): {
  entries: Record<string, Uint8Array>;
  manifest: BackupManifest;
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new BackupArchiveError('invalid', 'Not a valid zip archive');
  }
  const manifestRaw = entries[MANIFEST_NAME];
  if (!manifestRaw) {
    throw new BackupArchiveError('invalid', 'Backup is missing manifest.json');
  }
  const manifest = parseManifest(manifestRaw);

  if (manifest.encrypted) {
    for (const path of Object.keys(entries)) {
      if (path.endsWith('/') || isJunkPath(path)) continue;
      if (path !== MANIFEST_NAME && path !== PAYLOAD_ENC_NAME) {
        throw new BackupArchiveError(
          'invalid',
          `Encrypted backup must contain only ${MANIFEST_NAME} + ${PAYLOAD_ENC_NAME}, found: ${path}`,
        );
      }
    }
  }

  return { entries, manifest };
}

/**
 * 只读取 manifest，用于恢复前预览（展示名称 / 时间 / 各分类条目数 / 是否加密）。
 * 不解密、不需要口令——这正是 manifest 始终明文的意义。
 */
export function readManifest(zipBytes: Uint8Array): BackupManifest {
  return openOuter(zipBytes).manifest;
}

/**
 * 完整解包成 BackupBundle。
 *
 * 加密包需提供正确 `password`：缺口令抛 `passwordRequired`，口令错误 / 密文被
 * 篡改抛 `wrongPassword`（且不会返回任何半解密数据）。所有 payload 路径都经过
 * zip-slip 安全校验。
 */
export async function unpackArchive(
  zipBytes: Uint8Array,
  password?: string,
): Promise<BackupBundle> {
  const { entries, manifest } = openOuter(zipBytes);

  if (!manifest.encrypted) {
    // 未加密外层：根目录只允许 manifest.json（不应出现 payload.enc）。
    const files = fromPayloadEntries(entries, new Set([MANIFEST_NAME]));
    return { manifest, files };
  }

  if (!password) {
    throw new BackupArchiveError('passwordRequired', 'This backup is encrypted');
  }
  const ciphertext = entries[PAYLOAD_ENC_NAME];
  if (!ciphertext) {
    throw new BackupArchiveError('invalid', 'Encrypted backup is missing payload.enc');
  }

  let innerZip: Uint8Array;
  try {
    innerZip = await decryptPayload(ciphertext, password, manifest.encryption!);
  } catch {
    // GCM 认证失败（口令错误或密文被篡改）。crypto 已保证不返回半解密数据。
    throw new BackupArchiveError('wrongPassword', 'Wrong password or corrupted backup');
  }

  let innerEntries: Record<string, Uint8Array>;
  try {
    innerEntries = unzipSync(innerZip);
  } catch {
    throw new BackupArchiveError('invalid', 'Decrypted payload is not a valid zip');
  }
  // 解密后的内层 zip 全部是 payload/ 前缀条目，根级不应有任何容器文件。
  const files = fromPayloadEntries(innerEntries, new Set());
  return { manifest, files };
}
