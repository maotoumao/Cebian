// 网络录制的中间数据结构：后台采集时就地打码、过滤后写入，定稿时随录制会话交给界面，
// 再由界面转成内联时间线条目（network-summary）与完整 HAR 文件（har）。

/** 录下来的请求类型。其它类型（图片 / 样式 / 字体 / 媒体 / 脚本 / sendBeacon 等）不录。 */
type NetworkResourceType = 'document' | 'fetch' | 'xhr' | 'eventsource' | 'websocket';

interface NetworkHeader {
  name: string;
  value: string;
}

/**
 * 请求体或响应体为何没有内容：
 * - `binary`：非文本类型（图片、文件等），不读取；
 * - `too_large`：超过单个响应体上限，读之前就跳过；
 * - `evicted`：浏览器缓冲区已经丢掉（多见于页面跳转后），取不到了；
 * - `unavailable`：没有读取（Firefox 下不读取响应体）或读取失败；
 * - `unsupported`：格式无法可靠打码（HTML、XML、脚本、无结构文本等），为免漏出敏感信息不记。
 */
type NetworkBodyOmission = 'binary' | 'too_large' | 'evicted' | 'unavailable' | 'unsupported';

interface NetworkBody {
  mimeType?: string;
  /** 已打码的文本内容；省略时见 `omitted`。 */
  text?: string;
  omitted?: NetworkBodyOmission;
  /** 内容大小（字节，解压后），未知时省略。 */
  size?: number;
  /** 实际传输的字节数（压缩后），未知时省略。 */
  transferSize?: number;
}

/** WebSocket 帧或 EventSource 消息的预览。 */
interface NetworkStreamMessage {
  direction: 'sent' | 'received';
  /** 相对录制开始的毫秒数。 */
  t: number;
  /** 已打码、截断的内容；二进制帧为占位文字。 */
  data: string;
  /** 二进制帧（WebSocket opcode 2）。 */
  binary?: true;
}

interface NetworkEntry {
  /** 短 id：内联时间线条目与 HAR 里的 `_cebianId` 共用，供模型在 HAR 里定位。 */
  id: string;
  /** 请求发出时刻，相对录制开始的毫秒数。 */
  t: number;
  tabId: number;
  type: NetworkResourceType;
  method: string;
  /** 已打码的最终请求地址（重定向后的地址）。 */
  url: string;
  requestHeaders: NetworkHeader[];
  requestBody?: NetworkBody;
  /** 依次经过的重定向（已打码的原地址与状态码）。 */
  redirects?: { url: string; status: number }[];
  status?: number;
  statusText?: string;
  responseHeaders?: NetworkHeader[];
  responseBody?: NetworkBody;
  /** 请求发出到完成的毫秒数；未完成时省略。 */
  durationMs?: number;
  /** 失败原因（网络错误、被取消等）。 */
  error?: string;
  /** WebSocket / EventSource 的前若干条消息。 */
  messages?: NetworkStreamMessage[];
  /** 消息超过预览条数，后面的已省略。 */
  messagesTruncated?: boolean;
}

/**
 * 网络录制的整体状态：
 * - `active`：正常录制；
 * - `unavailable`：当前浏览器或页面无法录制网络（Firefox 未授权、被其它调试器占用等）；
 * - `aborted`：用户中途取消了（Chrome 点了调试提示条上的「取消」、Firefox 撤销了权限），
 *   之后的请求没有录到。
 */
type NetworkCaptureState = 'active' | 'unavailable' | 'aborted';

interface NetworkLog {
  state: NetworkCaptureState;
  /** `aborted` 时为中止时刻，相对录制开始的毫秒数。 */
  abortedAt?: number;
  /** `unavailable` 时的原因（给模型与界面的说明）。 */
  unavailableReason?: string;
  /** 录制期间无法录制网络的标签页（如被其它调试器占用），其余标签页照常录制。 */
  unavailableTabs?: { tabId: number; reason: string }[];
  /** 按请求发出时刻排序。 */
  entries: NetworkEntry[];
  /** 被过滤掉的埋点 / 监控请求数。 */
  filteredCount: number;
  /** 到达条目数或总量上限后停止录制网络。 */
  truncated?: 'entry_limit' | 'size_limit';
}

// ─── 公开 API ───

export type {
  NetworkBody,
  NetworkBodyOmission,
  NetworkCaptureState,
  NetworkEntry,
  NetworkHeader,
  NetworkLog,
  NetworkResourceType,
  NetworkStreamMessage,
};
