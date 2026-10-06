// Centralized tunables for the user-action recorder. Values are chosen to be
// safe for typical pages and for the heavy-SPA case (Notion / 飞书 / GitHub);
// see docs/plans/2026-04-22-recording-button.md for rationale.

import type { RecorderOptions } from './types';

/** Hard cap on the total number of events in one recording session. */
export const RECORDER_MAX_EVENTS = 1000;

/** Hard cap on recording wall-clock duration. */
export const RECORDER_MAX_DURATION_MS = 10 * 60 * 1000;

/** Idle period after the last raw mutation before flushing. */
export const MUTATION_FLUSH_IDLE_MS = 500;

/** Maximum delay between first push and a forced flush, even if mutations keep arriving. */
export const MUTATION_FLUSH_FORCE_MS = 2000;

/** Per-flush hard cap on raw mutation records before the window is dropped. */
export const MUTATION_RAW_BUFFER_MAX = 5000;

/** Debounce window for `input` events on the same target. Tuned long
 *  enough that bursts of typing collapse into a single emission carrying
 *  the final text, while still flushing within a normal pause between
 *  thoughts. Lowering this re-introduces noisy intermediate snapshots. */
export const INPUT_DEBOUNCE_MS = 800;

/** Throttle window for `scroll` aggregation. */
export const SCROLL_THROTTLE_MS = 1000;

/** Truncation length for any user-visible text (labels, previews, values). */
export const TEXT_PREVIEW_MAX = 200;

/** Truncation length specifically for input values. */
export const INPUT_VALUE_MAX = 500;

/** A node's bounding rect must cover at least this fraction of the viewport
 *  to qualify as a mutation candidate via the "large module" rule. */
export const MUTATION_AREA_RATIO = 0.05;

/** ARIA roles that flag a node as a semantic container. */
export const SEMANTIC_ROLES: ReadonlySet<string> = new Set([
  'dialog', 'alertdialog', 'menu', 'listbox', 'tooltip',
  'alert', 'status', 'region', 'main', 'navigation',
  'banner', 'complementary',
]);

/** HTML tags that flag a node as a semantic container. */
export const SEMANTIC_TAGS: ReadonlySet<string> = new Set([
  'dialog', 'form', 'main', 'nav', 'aside', 'article', 'section',
]);

/** Url prefixes where content scripts cannot be injected; we silently skip
 *  interaction/mutation capture but still record tab/navigation events. */
export const RESTRICTED_URL_PREFIXES: readonly string[] = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

/** 录制选项的默认值：只录操作。 */
export const DEFAULT_RECORDER_OPTIONS: RecorderOptions = { interactions: true, network: false };

// ─── 网络录制 ───

/** 单个请求体 / 响应体最多记录的字节数；超过的在读取之前就跳过（记为 too_large）。 */
export const NETWORK_BODY_MAX = 64 * 1024;

/** 一次录制里网络数据（请求体 + 响应体 + 消息预览）的总量上限，到达后停止录制网络。 */
export const NETWORK_TOTAL_MAX = 5 * 1024 * 1024;

/** 一次录制最多记录的网络请求数，到达后停止录制网络（不影响操作录制）。 */
export const NETWORK_MAX_ENTRIES = 500;

/** 每个 WebSocket / EventSource 连接最多记录的消息条数。 */
export const NETWORK_STREAM_MESSAGES_MAX = 20;

/** 每条 WebSocket / EventSource 消息最多记录的字符数。 */
export const NETWORK_STREAM_MESSAGE_CHARS = 500;

/** 内联时间线里请求体预览的字符数。 */
export const NETWORK_REQUEST_PREVIEW_MAX = 200;

/** 内联时间线里响应体预览的字符数。 */
export const NETWORK_RESPONSE_PREVIEW_MAX = 300;

/** 内联时间线里 JSON 响应结构概要的字符数。 */
export const NETWORK_SHAPE_MAX = 300;

/** 录制的 HAR 存放在会话工作目录下的这个子目录（信封里的 har 属性以它开头）。 */
export const RECORDING_HAR_DIR = 'recordings';
