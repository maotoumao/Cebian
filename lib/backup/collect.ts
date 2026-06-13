// 顶层备份编排：把三个源的采集结果 + manifest 组装成一个备份 zip。
//
// 本文件只做跨源编排与 manifest 组装，不碰任何后端细节——storage / sessions / vfs
// 的具体读取在各自 sources/*.ts 里。最终交给 archive.packArchive 打包（含可选加密）。

import { packArchive, type BackupBundle } from './archive';
import { collectStorage } from './sources/storage';
import { collectSessions } from './sources/sessions';
import { collectVfs } from './sources/vfs';
import {
  PAYLOAD_FILES,
  sessionFileKey,
  SKILLS_PROMPTS_ROOTS,
  workspaceRootForSession,
  vfsKeyToPath,
  isUnderAnyRoot,
} from './payload-format';
import { WORKSPACES_ROOT } from '@/lib/constants';
import {
  BACKUP_FORMAT_VERSION,
  type BackupOptions,
  type BackupManifest,
} from './types';

const encoder = new TextEncoder();

/** 统计落在某个 root 前缀下的 VFS 文件数（key 含 `vfs/` 前缀）。 */
function countUnder(files: Record<string, Uint8Array>, roots: string[]): number {
  let n = 0;
  for (const key of Object.keys(files)) {
    if (isUnderAnyRoot(vfsKeyToPath(key), roots)) n++;
  }
  return n;
}

/**
 * 按用户选项创建一个备份，返回最终 zip 字节。
 *
 * 分类语义：`settings` / `credentials` 控制 storage 两部分；`sessions` 控制会话，其
 * 工作区文件由 `includeWorkspaces` 子选项额外控制；`skillsPrompts` 控制技能/提示词
 * VFS 子树。`packArchive` 负责最终敲定加密状态（传 `password` 即加密）。
 */
export async function createBackup(options: BackupOptions): Promise<Uint8Array> {
  const cats = new Set(options.categories);
  const wantSettings = cats.has('settings');
  const wantCredentials = cats.has('credentials');
  const wantSessions = cats.has('sessions');
  const wantSkillsPrompts = cats.has('skillsPrompts');
  const wantWorkspaces = wantSessions && options.includeWorkspaces;

  const files: Record<string, Uint8Array> = {};

  // ─ storage ─
  const storage = await collectStorage({ settings: wantSettings, credentials: wantCredentials });
  if (storage.config) {
    files[PAYLOAD_FILES.config] = encoder.encode(JSON.stringify(storage.config));
  }
  if (storage.credentials && Object.keys(storage.credentials).length > 0) {
    files[PAYLOAD_FILES.credentials] = encoder.encode(JSON.stringify(storage.credentials));
  }

  // ─ sessions ─
  // 每个会话单独存为 payload/sessions/{id}.json，避免单个大文件。
  let sessionCount = 0;
  const sessionIds: string[] = [];
  if (wantSessions) {
    const records = await collectSessions();
    sessionCount = records.length;
    for (const r of records) {
      sessionIds.push(r.id);
      files[sessionFileKey(r.id)] = encoder.encode(JSON.stringify(r));
    }
  }

  // ─ vfs ─
  // 工作区按已备份会话 id 过滤，只打包这些会话的 /workspaces/{id}/，避免把已删
  // 会话残留的孤儿工作区也带进备份。
  const roots: string[] = [];
  if (wantSkillsPrompts) roots.push(...SKILLS_PROMPTS_ROOTS);
  if (wantWorkspaces) roots.push(...sessionIds.map(workspaceRootForSession));
  let skillsPromptsFileCount = 0;
  let workspacesFileCount = 0;
  if (roots.length > 0) {
    const { files: vfsFiles, index } = await collectVfs(roots);
    Object.assign(files, vfsFiles);
    if (Object.keys(index).length > 0) {
      files[PAYLOAD_FILES.vfsIndex] = encoder.encode(JSON.stringify(index));
    }
    skillsPromptsFileCount = wantSkillsPrompts ? countUnder(vfsFiles, SKILLS_PROMPTS_ROOTS) : 0;
    workspacesFileCount = wantWorkspaces ? countUnder(vfsFiles, [WORKSPACES_ROOT]) : 0;
  }

  // ─ manifest（明文；packArchive 会覆盖 encrypted/encryption） ─
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: 'cebian',
    appVersion: chrome.runtime.getManifest().version,
    createdAt: Date.now(),
    name: options.name,
    description: options.description,
    encrypted: false,
    categories: {
      sessions: { included: wantSessions, count: sessionCount, workspaces: wantWorkspaces },
      settings: { included: wantSettings },
      credentials: { included: wantCredentials },
      skillsPrompts: { included: wantSkillsPrompts, fileCount: skillsPromptsFileCount },
    },
    vfs: {
      ...(wantSkillsPrompts
        ? { skillsPrompts: { roots: SKILLS_PROMPTS_ROOTS, fileCount: skillsPromptsFileCount } }
        : {}),
      ...(wantWorkspaces
        ? { workspaces: { roots: [WORKSPACES_ROOT], fileCount: workspacesFileCount } }
        : {}),
    },
  };

  const bundle: BackupBundle = { manifest, files };
  return packArchive(bundle, options.password);
}
