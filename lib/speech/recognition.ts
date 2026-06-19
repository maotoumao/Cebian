// 语音识别核心（无 React、无 DOM 组件依赖）。
//
// 封装浏览器 Web Speech API 的 `SpeechRecognition`，并**强制走本地
// on-device 识别**（`processLocally = true`）。Cebian 的运行环境拿不到
// Google 云端语音端点（音频上传会失败，典型报 `error: 'network'`），所以
// 云端这条路不可用，只走 Chrome 139+ 的 SODA 本地引擎：首次需要下载语言包
// （`install()`），装好后完全离线、免费、有实时中间结果。
//
// 这一层只做「与浏览器 API 打交道」的纯逻辑：特性检测、locale→BCP-47、
// 语言包可用性查询 / 下载、启动一次识别会话。状态机与 React 绑定在
// `hooks/useSpeechRecognition.ts`，结果文本清洗在 `lib/speech/transcript.ts`。
//
// Web Speech API 的完整类型（含 on-device 静态方法与 `processLocally`）声明
// 在 `lib/speech/speech-recognition.d.ts`，TypeScript lib.dom 未覆盖。

/** on-device 语言包可用性。对应 `SpeechRecognition.available()` 的返回。 */
export type SpeechAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

/** 归一化后的识别错误类型，供上层做文案/降级判断。 */
export type SpeechErrorKind =
  // 麦克风未授权
  | 'not-allowed'
  // 没听到语音
  | 'no-speech'
  // 拿不到音频输入设备
  | 'audio-capture'
  // 走了云端且网络失败（强制本地后理论上不该出现）
  | 'network'
  // 该语言本地不可用
  | 'language-unavailable'
  // 主动 abort，正常停止，非真错误
  | 'aborted'
  | 'unknown';

/** 一次识别会话的回调集合。 */
export interface SpeechSessionCallbacks {
  /** 实时中间结果（临时、会被后续覆盖）。 */
  onInterim: (text: string) => void;
  /** 一段最终结果（原始文本，未清洗）。 */
  onFinal: (text: string) => void;
  /** 归一化后的错误。`aborted` 不会经此上报（视为正常停止）。 */
  onError: (kind: SpeechErrorKind) => void;
  /** 会话结束（无论正常停止、abort 还是出错后）。 */
  onEnd: () => void;
}

/** 控制一次进行中的识别会话。 */
export interface SpeechSessionHandle {
  /** 优雅停止：flush 最后一段结果后结束。 */
  stop: () => void;
  /** 立即终止：丢弃挂起结果。用于切换会话/卸载时兜底。 */
  abort: () => void;
}

// on-device 静态方法挂在构造函数上（`available`/`install`），其完整类型见
// 根目录 `speech-recognition.d.ts` 的 `SpeechRecognitionStatic`。

function getRecognitionCtor(): SpeechRecognitionStatic | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/** 把浏览器 UI 语言（如 "zh-CN" / "en-US"）映射成 SODA 本地引擎认的
 *  BCP-47 完整标签。本地引擎按完整标签注册语言包，简写（"zh" / "cmn"）
 *  会匹配不到，必须用 `cmn-Hans-CN` / `cmn-Hant-TW` / `en-US` 这类全标签。 */
function mapUiLangToRecognitionLang(uiLang: string): string {
  const lang = uiLang.toLowerCase();
  if (lang.startsWith('zh') || lang.startsWith('cmn')) {
    // 繁体（台湾 / 香港 / 显式 Hant）走 Hant-TW，其余中文走 Hans-CN。
    if (lang.includes('tw') || lang.includes('hk') || lang.includes('hant')) {
      return 'cmn-Hant-TW';
    }
    return 'cmn-Hans-CN';
  }
  return 'en-US';
}

function normalizeSpeechError(error: string): SpeechErrorKind {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'language-not-supported':
      return 'language-unavailable';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────

/** 浏览器是否提供 `SpeechRecognition`。不支持时上层应直接隐藏语音按钮。 */
export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== undefined;
}

/** 是否支持 on-device 识别（存在 `available`/`install` 静态方法）。
 *  Cebian 只走本地路径，所以这是语音功能可用的真正前提。 */
export function isOnDeviceSupported(): boolean {
  const Ctor = getRecognitionCtor();
  return typeof Ctor?.available === 'function' && typeof Ctor?.install === 'function';
}

/** 当前应使用的识别语言（BCP-47 全标签）。默认取扩展 UI 语言，可显式覆盖。 */
export function resolveRecognitionLang(uiLang?: string): string {
  const source = uiLang ?? chrome.i18n.getUILanguage?.() ?? 'en-US';
  return mapUiLangToRecognitionLang(source);
}

/** 查询某语言的本地语言包状态。不支持 on-device 时返回 `unavailable`。 */
export async function getLanguageStatus(lang: string): Promise<SpeechAvailability> {
  const Ctor = getRecognitionCtor();
  if (!Ctor?.available) return 'unavailable';
  try {
    return await Ctor.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

/** 下载某语言的本地语言包（首次使用前）。返回是否成功。 */
export async function installLanguage(lang: string): Promise<boolean> {
  const Ctor = getRecognitionCtor();
  if (!Ctor?.install) return false;
  try {
    return await Ctor.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

/** 启动一次识别会话。调用前应确保语言包 `available` 且麦克风已授权。
 *
 *  返回 handle 用 `abort()` 兜底停止（实测 `abort()` 能可靠触发 `onend`，
 *  而 continuous 模式下 `stop()` 有时迟迟不结束）。`stop()` 仍保留用于
 *  「说完这句再停」的优雅路径。
 *
 *  启动失败（无构造函数 / `start()` 抛错）时返回 `null` —— 不会触发任何
 *  回调，由调用方据此判定失败。这样调用方拿到的「成功 handle」一定对应一个
 *  真正在跑的会话，不会出现回调先于返回值到达导致状态错乱。 */
export function startSpeechSession(lang: string, cb: SpeechSessionCallbacks): SpeechSessionHandle | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = true;
  try {
    rec.processLocally = true;
  } catch {
    // 不支持该属性的环境：忽略，靠上层的 on-device 检测拦截。
  }

  rec.onresult = (ev: SpeechRecognitionEvent) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        cb.onFinal(transcript);
      } else {
        interim += transcript;
      }
    }
    if (interim) cb.onInterim(interim);
  };

  rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
    const kind = normalizeSpeechError(ev.error);
    // abort 是主动停止，不当作错误上报（onend 仍会触发做清理）。
    if (kind !== 'aborted') cb.onError(kind);
  };

  rec.onend = () => cb.onEnd();

  try {
    rec.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* 已停止 */
      }
    },
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* 已停止 */
      }
    },
  };
}
