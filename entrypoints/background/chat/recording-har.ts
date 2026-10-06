// 录制附件里的 HAR（完整网络记录）在发送时写进会话工作目录 `recordings/`，发给模型的内容里
// 只带相对路径；模型需要细节时用文件工具读。写失败时标记 harFailed，不阻止这一轮发送。
// 这一轮最终没有发出去（被取消 / 被拒绝 / 出错）时由 discardRecordingHars 删掉这次写下的文件。

import type { Attachment, RecordingAttachment } from '@/lib/agent/attachments';
import { RECORDING_HAR_DIR } from '@/lib/recorder/constants';
import { vfs } from '@/lib/persistence/vfs';
import { workspaceRootForSession } from '@/lib/persistence/vfs-paths';
import { isValidSessionId, randomId } from '@/lib/utils';
import { sessionStore } from './session-store';

/** 一次发送写 HAR 的结果：替换后的附件，与这次实际写下的文件（VFS 绝对路径）。 */
interface SavedRecordingHars {
  attachments: Attachment[];
  written: string[];
}

/**
 * 正在写的 HAR 路径（同步占位）。同一份录制被重复提交（重放的 IPC 等）时，后一次换个名字，
 * 不覆盖、更不会在被拒绝后删掉前一条消息指向的文件。
 */
const reservedPaths = new Set<string>();

/** 文件名只保留安全字符（名字由侧边栏生成，这里再守一道，不让它跳出目录）。 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '') || 'recording.har';
}

/** 给文件名加一段随机后缀（放在扩展名前）。 */
function withSuffix(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const suffix = `-${randomId(6, 16)}`;
  return dot > 0 ? `${fileName.slice(0, dot)}${suffix}${fileName.slice(dot)}` : `${fileName}${suffix}`;
}

/** 换名的尝试上限（随机后缀几乎不会撞，到上限说明有异常，按写入失败处理）。 */
const RESERVE_ATTEMPTS = 20;

/**
 * 选一个没被占用、也不存在的相对路径并占位：先试原名，再试随机后缀，每个候选都在 await
 * 之前同步占位、再查 VFS，冲突就放掉自己的占位换下一个。
 */
async function reserveHarPath(root: string, fileName: string): Promise<string> {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const relative = `${RECORDING_HAR_DIR}/${attempt === 0 ? fileName : withSuffix(fileName)}`;
    const full = `${root}/${relative}`;
    if (reservedPaths.has(full)) continue;
    reservedPaths.add(full);
    let taken: boolean;
    try {
      taken = await vfs.exists(full);
    } catch (err) {
      reservedPaths.delete(full);
      throw err;
    }
    if (!taken) return relative;
    reservedPaths.delete(full);
  }
  throw new Error(`no free HAR file name for ${fileName}`);
}

async function saveHar(sessionId: string, attachment: RecordingAttachment, written: string[]): Promise<RecordingAttachment> {
  // harPath / harFailed 只由这里决定，不信任传进来的值
  const { har, harPath: _harPath, harFailed: _harFailed, ...rest } = attachment;
  if (!har) return rest;
  // 会话 id 拼进路径，不合法（不是 UUID）就不写，免得跳出 /workspaces/
  if (!isValidSessionId(sessionId)) {
    console.warn('[recording] invalid session id, HAR not saved:', sessionId);
    return { ...rest, harFailed: true };
  }
  const root = workspaceRootForSession(sessionId);
  let harPath: string | undefined;
  try {
    harPath = await reserveHarPath(root, safeFileName(har.name));
    await vfs.writeFile(`${root}/${harPath}`, har.json);
    written.push(`${root}/${harPath}`);
    return { ...rest, harPath };
  } catch (err) {
    console.warn('[recording] failed to save HAR:', err);
    return { ...rest, harFailed: true };
  } finally {
    if (harPath) reservedPaths.delete(`${root}/${harPath}`);
  }
}

/**
 * 把附件里录制的 HAR 写进会话工作目录，返回替换后的附件（HAR 内容换成相对路径，不再
 * 携带）与这次写下的文件。没有 HAR 的附件原样返回。
 */
async function saveRecordingHars(sessionId: string, attachments: Attachment[]): Promise<SavedRecordingHars> {
  const written: string[] = [];
  if (!attachments.some((a) => a.type === 'recording')) return { attachments, written };
  const saved = await Promise.all(attachments.map((a) => (a.type === 'recording' ? saveHar(sessionId, a, written) : a)));
  return { attachments: saved, written };
}

/**
 * 这一轮没有发出去时删掉 saveRecordingHars 这次写下的 HAR（只认它返回的路径，且必须在该
 * 会话的 recordings/ 下）。写入期间会话被删除的话，删除流程清掉的工作目录可能又被这次写入
 * 建了回来，这时整个工作目录一并删掉。尽力而为，不抛错。
 */
async function discardRecordingHars(sessionId: string, written: string[]): Promise<void> {
  if (written.length === 0 || !isValidSessionId(sessionId)) return;
  const root = workspaceRootForSession(sessionId);
  const dir = `${root}/${RECORDING_HAR_DIR}/`;
  const paths = written.filter((path) => path.startsWith(dir) && !path.slice(dir.length).includes('/'));
  try {
    await Promise.all(paths.map((path) => vfs.rm(path, { force: true })));
    if (!(await sessionStore.loadMeta(sessionId))) await vfs.rm(root, { recursive: true, force: true });
  } catch (err) {
    console.warn('[recording] failed to discard HAR:', err);
  }
}

// ─── 公开 API ───

export { saveRecordingHars, discardRecordingHars };
