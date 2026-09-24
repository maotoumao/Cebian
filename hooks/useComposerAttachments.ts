import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  MAX_ATTACHMENT_COUNT,
  planFileIntake,
  type Attachment, type FileIntakeKind, type ImageAttachment,
} from '@/lib/agent/attachments';
import { recordingToAttachment } from '@/lib/recorder/to-attachment';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { formatBytes } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 文件附件的来源；拖放与点击上传同属「上传」（`ImageAttachment.source` 是持久化字段，不为拖放扩值）。 */
type FileIntakeSource = Exclude<ImageAttachment['source'], 'screenshot'>;

/** FileReader 的 Promise 包装。文本用 `readAsText` 而不是 `file.text()`：前者会按 BOM
 *  识别 UTF-16，后者固定按 UTF-8 解码。 */
function readFile(file: File, as: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

/** 读取文件内容并转成附件。读取失败时 reject，由调用方逐项提示。 */
async function readFileAttachment(file: File, kind: FileIntakeKind, source: FileIntakeSource): Promise<Attachment> {
  if (kind === 'text') {
    return { type: 'file', content: await readFile(file, 'text'), name: file.name, mimeType: file.type || 'text/plain', size: file.size };
  }
  const data = (await readFile(file, 'dataUrl')).split(',', 2)[1] ?? '';
  return { type: 'image', source, data, mimeType: file.type || 'image/png', name: file.name || undefined };
}

/**
 * 输入框的附件列表：附件的唯一事实源、文件接收管线（点击上传 / 粘贴 / 拖放）与录制成品入列。
 * 截图、元素拾取等入口留在调用方，自行用 `freeSlots()` 检查名额、用 `updateAttachments` 写入。
 *
 * - `supportsImage`：当前模型能否接收图片。变为 false 时剥离已有图片并提示；读取期间切过去的，
 *   迟到的图片静默丢弃。
 * - `isLocked`：发送进行中时为 true，此时拒收新文件——那一刻的附件列表马上要被清空，而发送方
 *   只等待上锁前接受的文件（见 `waitForIntake`）。它只挡新文件，不挡录制入列与 `updateAttachments`。
 */
function useComposerAttachments({ supportsImage, isLocked }: { supportsImage: boolean; isLocked: () => boolean }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 附件列表的同步副本，是「当前有哪些附件」的唯一事实源：await 之后（录制 stop、
  // 文件读取、截图）要立刻读到最新列表，不能等 React 下一次渲染。所有改动都必须走
  // updateAttachments，同时写 ref 与 state，二者才不会出现一拍的偏差。
  const attachmentsRef = useRef<Attachment[]>([]);
  const updateAttachments = useCallback((update: (prev: Attachment[]) => Attachment[]) => {
    const next = update(attachmentsRef.current);
    if (next === attachmentsRef.current) return;
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);
  const getAttachments = useCallback(() => attachmentsRef.current, []);

  // 已接受、还在读取中的文件数。读取期间先预占名额，避免同时进来的截图 / 元素 / 另一批
  // 文件把它们挤出上限。录制附件例外：它只看已提交数（录下的内容没法重来），挤占时由
  // 文件批次提交时兜底截断。
  const reservedSlotsRef = useRef(0);
  const freeSlots = useCallback(
    () => MAX_ATTACHMENT_COUNT - attachmentsRef.current.length - reservedSlotsRef.current,
    [],
  );
  // 文件读取批次串成一条队列：批内并行读取、批次按接收顺序提交；发送前 await 队尾即可
  // 等到此前接受的所有文件都已落进附件。
  const intakeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const waitForIntake = useCallback(() => intakeQueueRef.current, []);

  // 每次渲染同步赋值（不走 effect）：迟到的读取结果要读到此刻的能力 / 锁状态
  const supportsImageRef = useRef(supportsImage);
  supportsImageRef.current = supportsImage;
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  // 切换到不支持图片的模型时，自动剥离已有的图片附件（保留文件附件），
  // 避免把图片发给纯文本模型导致请求异常。
  useEffect(() => {
    if (supportsImage) return;
    if (!attachmentsRef.current.some((a) => a.type === 'image')) return;
    toast.info(t('chat.composer.imageStripped'));
    updateAttachments((prev) => prev.filter((a) => a.type !== 'image'));
  }, [supportsImage, updateAttachments]);

  // Subscribe to recorder sessions delivered by the background. Fires for
  // every finished recording (manual stop button, send-time auto-stop,
  // cap-trigger), so this is the single sink for recording attachments.
  //
  // updateAttachments 同步写 ref：`useRecorder.stop()` 的 await 恢复与这里的回调
  // 由同一次 publishSession 触发，发送方恢复时必须已经能从 ref 读到新附件。
  // 名额只看已提交数，不看文件预占（见 reservedSlotsRef）。
  useEffect(() => {
    return recorderChannel.subscribeSession((session) => {
      if (attachmentsRef.current.length >= MAX_ATTACHMENT_COUNT) {
        toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
        return;
      }
      updateAttachments((prev) => [...prev, recordingToAttachment(session)]);
    });
  }, [updateAttachments]);

  /**
   * 点击上传 / 粘贴 / 拖放共用的文件入口：同步判定并预占名额，异步读取后按
   * 接收顺序提交。
   * `duplicateImages`：粘贴专用的同图去重；`'quiet'` 用于同时粘贴了文字的情形（图片多半
   * 是选中富文本时顺带进来的），不再弹提示打扰。
   */
  const ingestFiles = useCallback((
    files: readonly File[],
    source: FileIntakeSource,
    duplicateImages?: 'notify' | 'quiet',
  ) => {
    if (isLockedRef.current() || files.length === 0) return;

    const plan = planFileIntake(files, { remaining: freeSlots(), supportsImage: supportsImageRef.current });
    let warnedNoImage = false;
    for (const rejection of plan.rejected) {
      const name = rejection.file.name || t('chat.attachments.image');
      // 静默模式下，富文本顺带进来的白名单外图片（tiff / heic 等）也不打扰
      if (rejection.reason === 'unsupported' && duplicateImages === 'quiet') continue;
      if (rejection.reason === 'no-image-model') {
        if (!warnedNoImage) toast.warning(t('chat.composer.modelNoImage'));
        warnedNoImage = true;
      } else if (rejection.reason === 'too-large') {
        toast.error(t('chat.composer.fileTooLarge', [name, formatBytes(rejection.maxSize)]));
      } else {
        toast.error(t('chat.composer.unsupportedFileType', [name]));
      }
    }
    if (plan.skipped > 0) {
      toast.warning(plan.accepted.length === 0
        ? t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT])
        : t('chat.composer.skippedAtLimit', plan.skipped));
    }
    const { accepted } = plan;
    if (accepted.length === 0) return;

    reservedSlotsRef.current += accepted.length;
    // 立刻开读（批内并行），提交则排在前面的批次之后
    const reads = Promise.allSettled(accepted.map(({ file, kind }) => readFileAttachment(file, kind, source)));
    const task = intakeQueueRef.current.then(async () => {
      const results = await reads;
      // 释放预占与提交在同一个同步段里完成，其他入口不会看到「两边都算 / 两边都没算」的中间态；
      // 放在最前面，后面的提示即便抛错也不会让名额一直被占着
      reservedSlotsRef.current -= accepted.length;
      const additions: Attachment[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') additions.push(r.value);
        else toast.error(t('chat.composer.readFileFailed', [accepted[i].file.name || t('chat.attachments.image')]));
      });
      let duplicated = 0;
      let overflow = 0;
      updateAttachments((prev) => {
        let next = prev;
        for (const att of additions) {
          // 读取期间切到了纯文本模型：迟到的图片静默丢弃（它从没出现在附件里，已有图片的移除提示由上面的 effect 负责）
          if (att.type === 'image' && !supportsImageRef.current) continue;
          if (duplicateImages && att.type === 'image'
            && next.some((a) => a.type === 'image' && a.data === att.data)) { duplicated++; continue; }
          // 录制不看预占，可能已经占掉了这里预约的名额
          if (next.length >= MAX_ATTACHMENT_COUNT) { overflow++; continue; }
          next = [...next, att];
        }
        return next;
      });
      if (duplicated > 0 && duplicateImages === 'notify') toast.info(t('chat.composer.imageAlreadyAdded'));
      if (overflow > 0) toast.warning(t('chat.composer.skippedAtLimit', overflow));
    });
    // 队列本身不能断：万一某批抛错，后续批次与发送等待照常进行
    intakeQueueRef.current = task.catch((err) => console.error('[Attachments] intake failed:', err));
  }, [freeSlots, updateAttachments]);

  return { attachments, getAttachments, freeSlots, updateAttachments, ingestFiles, waitForIntake };
}

export { useComposerAttachments };
