// Toolbar button that toggles the user-action recorder.
//
// Icon-only. The state difference is expressed purely through icon
// color + a subtle pulse when actively recording — no inline counters
// or elapsed time (the attachment chip carries that info once the
// session finalizes).
//
// Idle (and "foreign" — another instance is recording, but from this
//   sidepanel's POV the button is just inert/idle): neutral `CircleDot`
//   icon, tooltip "Start recording". Clicking while another instance
//   owns the recording posts a `recorder_start` that the BG rejects;
//   the rejection toast lives in `useRecorder`, not here.
// Owned-recording: same `CircleDot` icon in rose with a gentle pulse,
//   tooltip "Stop recording". Auto-stops (`truncated` set in status)
//   emit a one-shot toast so the user knows why recording ended.
//
// 旁边的小下拉（RecorderOptionsMenu）选择录哪几项（两项都不勾时开始按钮
// 置灰），选项状态由这里持有：改动立即反映在界面上，后台排队保存；开始录制
// 时先等本窗口的保存写完，再读最新保存的选项。网络录制被中止（用户取消了调试提示条 / Firefox 撤销了
// 权限）或录不了时，每轮各提示一次。

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleDot } from 'lucide-react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { RecorderOptionsMenu } from '@/components/chat/RecorderOptionsMenu';
import { useRecorder } from '@/hooks/useRecorder';
import { t } from '@/lib/i18n';
import { recorderOptions } from '@/lib/persistence/storage';
import { DEFAULT_RECORDER_OPTIONS } from '@/lib/recorder/constants';
import type { RecorderOptions } from '@/lib/recorder/types';

export interface RecordButtonProps {
  /** Disable the start button (e.g. while the agent is running). Has no
   *  effect on the stop affordance — losing the recording because of an
   *  unrelated agent run would be worse than letting the user free up the
   *  tab observer. */
  disabled?: boolean;
}

/**
 * 已提示过的网络状态（`startedAt:state`）。放在模块级：输入框重新挂载（如切到设置页再回来）
 * 时不重复提示同一轮的同一状态。
 */
const toastedNetworkStates = new Set<string>();

/** 本窗口内排队写入选项，前一次写完再读下一次的最新值。队列本身从不 reject。 */
let optionsWrite: Promise<unknown> = Promise.resolve();

/**
 * 写入一部分录制选项：合并到最新保存的值上（不用手里那份，免得覆盖别处刚做的修改）。
 * 返回是否写成功。
 */
function updateRecorderOptions(patch: Partial<RecorderOptions>): Promise<boolean> {
  const write = optionsWrite.then(async () => {
    const merged = { ...(await recorderOptions.getValue()), ...patch };
    await recorderOptions.setValue(merged);
    return true;
  }).catch((err: unknown) => {
    console.warn('[recorder] failed to save recording options:', err);
    return false;
  });
  optionsWrite = write;
  return write;
}

function sameOptions(a: RecorderOptions, b: RecorderOptions): boolean {
  return a.interactions === b.interactions && a.network === b.network;
}

export function RecordButton({ disabled }: RecordButtonProps) {
  const { isOwner, isRecording, truncated, startedAt, networkState, start, stop } = useRecorder();
  // 保存的选项；null = 还没读到。读出来之前不能开始：Firefox 要按真实选项决定这次点击里是否申请权限
  const [saved, setSaved] = useState<RecorderOptions | null>(null);
  // 刚改、还在保存的选项：界面以它为准，保存的值跟上后（或没有在途的保存时收到新值）撤掉
  const [draft, setDraft] = useState<RecorderOptions | null>(null);
  const pendingWrites = useRef(0);
  // 收到过几次存储变化：读回的值若在读的期间又有变化，以变化事件为准
  const watchSeq = useRef(0);
  // 正在开始录制（等权限 / 等保存）：期间下拉与按钮都禁用，开始用的选项不会再被改
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let mounted = true;
    const unwatch = recorderOptions.watch((value) => {
      watchSeq.current += 1;
      setSaved(value ?? DEFAULT_RECORDER_OPTIONS);
      // 别处改了选项、本窗口又没有在途的保存：以保存的值为准
      if (pendingWrites.current === 0) setDraft(null);
    });
    recorderOptions.getValue().then(
      (value) => { if (mounted && watchSeq.current === 0) setSaved(value); },
      (err: unknown) => {
        // 读不到就按默认值（不录网络）处理，不会多录用户没选的内容
        console.warn('[recorder] failed to read recording options:', err);
        if (mounted && watchSeq.current === 0) setSaved(DEFAULT_RECORDER_OPTIONS);
      },
    );
    return () => {
      mounted = false;
      unwatch();
    };
  }, []);
  const options = draft ?? saved ?? DEFAULT_RECORDER_OPTIONS;
  useEffect(() => {
    if (draft && saved && sameOptions(draft, saved)) setDraft(null);
  }, [draft, saved]);

  // Toast on auto-stop. Latch on (startedAt, truncated) tuple so each
  // recording session that ends with a truncation reason fires exactly
  // once, regardless of broadcast ordering or whether the BG sends a
  // clean intermediate status.
  const lastToastedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!truncated || startedAt == null) return;
    // Only the owning instance's sidepanel toasts auto-stop.
    if (!isOwner) return;
    const key = `${startedAt}:${truncated}`;
    if (lastToastedRef.current === key) return;
    lastToastedRef.current = key;
    const i18nKey = truncated === 'event_limit'
      ? 'chat.recorder.autoStoppedEvents'
      : 'chat.recorder.autoStoppedTime';
    toast.info(t(i18nKey));
  }, [truncated, startedAt, isOwner]);

  // 网络录制中止 / 录不了：每轮每种状态提示一次
  useEffect(() => {
    if (!isOwner || startedAt == null) return;
    if (networkState !== 'aborted' && networkState !== 'unavailable') return;
    const key = `${startedAt}:${networkState}`;
    if (toastedNetworkStates.has(key)) return;
    toastedNetworkStates.add(key);
    if (networkState === 'aborted') {
      toast.warning(t(import.meta.env.FIREFOX ? 'chat.recorder.networkAbortedFirefox' : 'chat.recorder.networkAborted'));
    } else {
      toast.warning(t(import.meta.env.FIREFOX ? 'errors.recorder.networkUnavailableFirefox' : 'errors.recorder.networkUnavailable'));
    }
  }, [networkState, startedAt, isOwner]);

  const handleStart = useCallback(() => {
    // 用户点开始时看到的选项；保存的值最终与它不一致（保存失败 / 别处刚改过）就不开始
    const intended = options;
    setStarting(true);
    // Firefox：要录网络时在这次点击里同步申请权限（已授予则不弹窗）。权限被撤销、或选项是从
    // 备份恢复来的，都在这里补上
    const requested = import.meta.env.FIREFOX && intended.network
      ? browser.permissions.request({ permissions: ['webRequest'] }).catch((err: unknown) => {
        console.warn('[recorder] webRequest permission request failed:', err);
        return false;
      })
      : undefined;
    void (async () => {
      // 权限结果回来、本窗口刚改的选项也保存完之后再读：刚取消的一项不能因为还没写完（或没写
      // 成功）而被录进去，弹窗期间别的窗口改过也要重新确认
      const requestedGrant = requested ? await requested : undefined;
      await optionsWrite;
      const latest = await recorderOptions.getValue();
      if (!sameOptions(latest, intended)) {
        toast.warning(t('errors.recorder.optionsChanged'));
        return;
      }
      // 两项都没勾：按钮本已置灰，这里再守一道
      if (!latest.interactions && !latest.network) return;
      const granted = !import.meta.env.FIREFOX || !latest.network || requestedGrant === true;
      if (!granted) {
        // 未授予：只录其余部分；其余都没勾就不开始（不能替用户打开没选的操作录制）
        if (!latest.interactions) {
          toast.warning(t('errors.recorder.networkPermissionDeniedNotStarted'));
          return;
        }
        toast.warning(t('errors.recorder.networkPermissionDenied'));
        start({ ...latest, network: false });
        return;
      }
      start(latest);
    })()
      .catch((err: unknown) => console.warn('[recorder] failed to start recording:', err))
      .finally(() => setStarting(false));
  }, [options, start]);

  const changeOptions = useCallback((patch: Partial<RecorderOptions>) => {
    const next = { ...options, ...patch };
    setDraft(next);
    pendingWrites.current += 1;
    void updateRecorderOptions(patch).then(async (ok) => {
      pendingWrites.current -= 1;
      // 还有更新的改动在保存：交给它收尾
      if (pendingWrites.current > 0) return;
      // 最后一次保存结束：读回保存的值（读的期间又有变化事件就以事件为准）再撤掉 draft，不等
      // 下一个变化事件——别处在保存途中改过选项时，那个事件已经来过了
      if (ok) {
        const seq = watchSeq.current;
        const value = await recorderOptions.getValue().catch(() => null);
        if (value && watchSeq.current === seq) setSaved(value);
      }
      if (pendingWrites.current === 0) setDraft(null);
    });
  }, [options]);

  // 录制中选项已定：下拉保留位置但禁用，工具栏不跳动
  if (isOwner) {
    return (
      <span className="inline-flex items-center">
        <Button
          variant="ghost"
          size="icon-xs"
          title={t('chat.recorder.stop')}
          onClick={() => { void stop(); }}
          // Always allow stopping, even while the agent is running — losing
          // the recording because of an unrelated agent run is worse than
          // letting the user free up the tab observer.
          className="size-7 text-rose-500 hover:text-rose-400 hover:bg-rose-500/10"
        >
          <CircleDot className="size-3.5 animate-pulse" />
        </Button>
        <RecorderOptionsMenu options={options} onChange={changeOptions} disabled />
      </span>
    );
  }

  // Idle from this instance's perspective. If another instance is recording,
  // clicking still posts `recorder_start` — the BG replies with
  // `recorder_start_rejected: { reason: 'busy' }` and useRecorder toasts.
  // 别的实例正在录制时下拉同样禁用（改了也不影响那一轮）；选项读出来之前也禁用。
  // 两项都没勾时开始按钮置灰，提示放在外层（禁用的按钮本身不一定显示 title）
  const noneSelected = !options.interactions && !options.network;
  return (
    <span className="inline-flex items-center">
      <span className="inline-flex" title={noneSelected ? t('chat.recorder.noneSelected') : undefined}>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t('chat.recorder.start')}
          onClick={handleStart}
          disabled={disabled || saved == null || starting || noneSelected}
          className="size-7"
        >
          <CircleDot className="size-3.5" />
        </Button>
      </span>
      <RecorderOptionsMenu options={options} onChange={changeOptions} disabled={disabled || isRecording || saved == null || starting} />
    </span>
  );
}
