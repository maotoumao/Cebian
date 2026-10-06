// 录制附件卡片（输入框与已发送消息共用）上的说明文字：操作数、请求数、过滤数、时长，
// 以及网络录制没有正常进行时的标注。

import type { NetworkCaptureState } from '@/lib/recorder/network-types';
import { t } from '@/lib/i18n';
import { formatCompactCount, formatDuration } from '@/lib/utils';

/** 卡片说明需要的字段（输入框里的附件与从消息解析出的录制都满足）。 */
interface RecordingMetaFields {
  eventCount: number;
  durationMs: number;
  networkCount?: number;
  filteredCount?: number;
  networkState?: NetworkCaptureState;
  harFailed?: boolean;
  json: string;
}

function recordingMetaText(r: RecordingMetaFields): string {
  const duration = formatDuration(r.durationMs);
  // 没开网络录制：沿用原来的「N 个事件 · 时长」
  if (r.networkCount == null) return t('chat.attachments.recordingMeta', [String(r.eventCount), duration]);
  const parts = [t('chat.attachments.recordingMetaNetwork', [String(r.eventCount), String(r.networkCount)])];
  if (r.filteredCount) parts.push(t('chat.attachments.recordingFiltered', [String(r.filteredCount)]));
  parts.push(duration);
  if (r.networkState === 'aborted') parts.push(t('chat.attachments.recordingNetworkAborted'));
  else if (r.networkState === 'unavailable') parts.push(t('chat.attachments.recordingNetworkUnavailable'));
  if (r.harFailed) parts.push(t('chat.attachments.recordingHarFailed'));
  return parts.join(' · ');
}

/** 卡片悬停提示：点击动作、完整说明（卡片上放不下时也能看全）与内联 JSON 的大小。 */
function recordingTitle(r: RecordingMetaFields): string {
  return [
    t('chat.attachments.recordingDownload'),
    recordingMetaText(r),
    t('chat.attachments.recordingChars', [formatCompactCount(r.json.length)]),
  ].join('\n');
}

// ─── 公开 API ───

export { recordingMetaText, recordingTitle };
