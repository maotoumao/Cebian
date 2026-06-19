// useSpeechRecognition — sidepanel 语音输入 hook。
//
// 把 `lib/speech/recognition.ts` 的纯逻辑包成 React 状态机，供 MicButton
// 使用。职责边界：
//  - 本 hook 只管「识别会话生命周期 + 状态」。麦克风授权的探测与引导由
//    调用方（MicButton）用 `lib/speech/mic-permission.ts` 处理，再调用
//    `start()`——所以 `start()` 假定已授权。
//  - 语言包未就绪时，`start()` 会先进入 `preparing` 态后台 `install()`，
//    下载完自动接着听写（无需用户再点）。
//  - 中间结果通过 `onInterim` 回调实时交给上层（ChatInput 把它作为 value
//    末尾的「未定稿后缀」直接写入输入框，因此输入框始终可编辑）；每段最终
//    结果经清洗 + `correctTranscript` 后由 `onFinal` 回调交给上层定稿。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isSpeechRecognitionSupported,
  isOnDeviceSupported,
  resolveRecognitionLang,
  getLanguageStatus,
  installLanguage,
  startSpeechSession,
  type SpeechErrorKind,
  type SpeechSessionHandle,
} from '@/lib/speech/recognition';
import { cleanTranscript } from '@/lib/speech/transcript';
import { correctTranscript } from '@/lib/speech/correction-channel';

/** 语音输入状态机：
 *  - idle：空闲
 *  - preparing：下载语言包中（loading）
 *  - listening：正在听写
 *  - error：上一次出错（短暂态，下次 start 会清除） */
export type SpeechState = 'idle' | 'preparing' | 'listening' | 'error';

export interface UseSpeechRecognitionOptions {
  /** 实时中间结果回调（原始、未清洗）。上层用它做末尾预览。 */
  onInterim: (text: string) => void;
  /** 每段最终结果（已清洗 + 经 correctTranscript）落地回调，用于写入输入框。 */
  onFinal: (text: string) => void;
  /** 归一化错误回调，用于 toast/降级（如 not-allowed、language-unavailable）。 */
  onError?: (kind: SpeechErrorKind) => void;
}

export interface UseSpeechRecognitionResult {
  /** 浏览器是否支持本地语音识别。为 false 时上层应隐藏整个按钮。 */
  supported: boolean;
  state: SpeechState;
  /** 开始语音输入（假定麦克风已授权）。必要时先下载语言包再听写。 */
  start: () => Promise<void>;
  /** 停止语音输入。 */
  stop: () => void;
}

export function useSpeechRecognition(options: UseSpeechRecognitionOptions): UseSpeechRecognitionResult {
  const { onInterim, onFinal, onError } = options;

  // 仅在挂载时判定一次能力：构造函数 + on-device 静态方法都在才算支持。
  const [supported] = useState(() => isSpeechRecognitionSupported() && isOnDeviceSupported());
  const [state, setState] = useState<SpeechState>('idle');

  const handleRef = useRef<SpeechSessionHandle | null>(null);
  // 会话序号：每次 start() 自增一格并被本次会话的所有异步/回调捕获。stop()、
  // 重新 start()、卸载都会让序号前进，从而让「上一会话」的 install 续跑、识别
  // 回调、correctTranscript 续跑全部失效——避免迟到回调污染当前状态或泄漏会话。
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  // 用 ref 镜像最新回调，避免把 start 的 useCallback 依赖绑到每次渲染的新函数上。
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // 卸载时让序号前进并中止进行中的会话，避免组件销毁后识别仍在跑或回调仍 setState。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current++;
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    // 让序号前进，作废当前会话的所有后续回调；立即翻转 UI 状态，不等 onend
    // ——避免引擎延迟导致按钮卡在 listening。
    seqRef.current++;
    handleRef.current?.stop();
    handleRef.current = null;
    setState('idle');
  }, []);

  const start = useCallback(async () => {
    // 已在进行中（preparing/listening 或已有 handle）则忽略重复触发。
    if (handleRef.current || state === 'preparing') return;

    // 占用一个新序号；本次 start 的所有异步续跑/回调都以它为准。
    const seq = ++seqRef.current;
    const isCurrent = () => mountedRef.current && seqRef.current === seq;

    const lang = resolveRecognitionLang();

    // 语言包就绪检查；downloadable/downloading 时进入 preparing 后台下载。
    let status = await getLanguageStatus(lang);
    if (!isCurrent()) return; // 期间被 stop / 重启 / 卸载，放弃。
    if (status === 'downloadable' || status === 'downloading') {
      setState('preparing');
      const ok = await installLanguage(lang);
      if (!isCurrent()) return;
      status = ok ? await getLanguageStatus(lang) : 'unavailable';
      if (!isCurrent()) return;
    }
    if (status !== 'available') {
      setState('error');
      onErrorRef.current?.('language-unavailable');
      return;
    }

    // 顺序闸：interim 即时、final 需 await correctTranscript（异步）。若不串行，
    // 同一事件里「final + 更新的 interim」会因 final 落在微任务里而被后到的
    // interim 抢先，导致 commit 误删该 interim。把两类回调都挂到本会话的 promise
    // 链上，保证按到达顺序应用（v1 correctTranscript 直通，串行开销仅一个微任务）。
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (work: () => void | Promise<void>) => {
      chain = chain.then(work).catch((err) => {
        console.warn('[speech] 回调链执行失败：', err);
      });
    };

    const handle = startSpeechSession(lang, {
      onInterim: (text) => {
        enqueue(() => {
          if (isCurrent()) onInterimRef.current(text);
        });
      },
      onFinal: (raw) => {
        enqueue(async () => {
          if (!isCurrent()) return;
          const corrected = await correctTranscript(cleanTranscript(raw));
          if (isCurrent() && corrected) onFinalRef.current(corrected);
        });
      },
      onError: (kind) => {
        if (!isCurrent()) return;
        setState('error');
        onErrorRef.current?.(kind);
      },
      onEnd: () => {
        if (!isCurrent()) return;
        handleRef.current = null;
        // 出错路径已置 error；正常结束回到 idle。
        setState((s) => (s === 'error' ? s : 'idle'));
      },
    });

    // 启动失败（无构造函数 / start 抛错）：handle 为 null，不会有任何回调。
    if (!handle) {
      if (isCurrent()) {
        setState('error');
        onErrorRef.current?.('unknown');
      }
      return;
    }

    // 启动成功，但若期间已被 stop/卸载，立即中止这个刚建的会话。
    if (!isCurrent()) {
      handle.abort();
      return;
    }

    handleRef.current = handle;
    setState('listening');
  }, [state]);

  return { supported, state, start, stop };
}
