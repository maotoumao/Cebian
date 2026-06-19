// Web Speech API（SpeechRecognition）的环境类型补充。
//
// 当前 TypeScript lib.dom.d.ts 只收录了 `SpeechRecognitionResult` /
// `SpeechRecognitionAlternative` / `SpeechRecognitionResultList` 这些子类型，
// 却没有 `SpeechRecognition` 主接口、事件类型，也没有实验性的 on-device
// 静态方法（`available`/`install`）与 `processLocally` 属性。这里按 W3C
// Web Speech API spec + Chrome 139+ on-device 扩展做完整声明，供
// `lib/speech/*` 使用。

/** `SpeechRecognitionErrorEvent.error` 的取值。 */
type SpeechRecognitionErrorCode =
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'bad-grammar'
  | 'language-not-supported';

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

declare var SpeechRecognitionEvent: {
  prototype: SpeechRecognitionEvent;
  new (type: string, eventInitDict: { resultIndex?: number; results: SpeechRecognitionResultList }): SpeechRecognitionEvent;
};

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  readonly message: string;
}

declare var SpeechRecognitionErrorEvent: {
  prototype: SpeechRecognitionErrorEvent;
  new (type: string, eventInitDict: { error: SpeechRecognitionErrorCode; message?: string }): SpeechRecognitionErrorEvent;
};

interface SpeechRecognitionEventMap {
  audioend: Event;
  audiostart: Event;
  end: Event;
  error: SpeechRecognitionErrorEvent;
  nomatch: SpeechRecognitionEvent;
  result: SpeechRecognitionEvent;
  soundend: Event;
  soundstart: Event;
  speechend: Event;
  speechstart: Event;
  start: Event;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome 139+ on-device：设为 true 强制本地识别。 */
  processLocally: boolean;

  onaudioend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null;
  onnomatch: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
  onsoundend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onsoundstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;

  abort(): void;
  start(): void;
  stop(): void;

  addEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** on-device 可用性查询/安装的参数与返回。 */
interface SpeechRecognitionAvailabilityOptions {
  langs: string[];
  processLocally?: boolean;
}

type SpeechRecognitionAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface SpeechRecognitionStatic {
  prototype: SpeechRecognition;
  new (): SpeechRecognition;
  /** Chrome 139+ on-device：查询语言包可用性。 */
  available?(options: SpeechRecognitionAvailabilityOptions): Promise<SpeechRecognitionAvailability>;
  /** Chrome 139+ on-device：下载语言包。 */
  install?(options: SpeechRecognitionAvailabilityOptions): Promise<boolean>;
}

declare var SpeechRecognition: SpeechRecognitionStatic;
declare var webkitSpeechRecognition: SpeechRecognitionStatic;

interface Window {
  // 运行时可能缺失（旧 Chromium / 非 Chromium）。声明为可选，强制调用方做
  // feature-detect，与 `lib/speech/recognition.ts` 的探测逻辑一致。
  SpeechRecognition?: SpeechRecognitionStatic;
  webkitSpeechRecognition?: SpeechRecognitionStatic;
}
