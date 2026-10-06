// 网络录制 → HAR 1.2 文件。模型用 fs_read_file 按行读、用 fs_search 按 `_cebianId` 定位，
// 所以输出多行缩进格式；用户也可以把它拖进 Chrome DevTools 的 Network 面板查看。

import { headerValue } from './network-headers';
import type { NetworkBodyOmission, NetworkEntry, NetworkHeader, NetworkLog } from './network-types';

const OMISSION_COMMENTS: Record<NetworkBodyOmission, string> = {
  binary: 'Body not recorded: binary content.',
  too_large: 'Body not recorded: larger than the recording limit.',
  evicted: 'Body not recorded: the browser had already discarded it.',
  unavailable: 'Body not recorded: not read in this browser, or could not be read.',
  unsupported: 'Body not recorded: its format cannot be reliably redacted.',
};

function queryString(url: string): NetworkHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function entryComment(entry: NetworkEntry): string | undefined {
  const finished = entry.status != null || entry.error != null || entry.durationMs != null;
  const comments = [
    entry.error ? `Failed: ${entry.error}` : '',
    finished ? '' : 'No response before the recording ended.',
    entry.requestBody?.omitted ? `Request ${OMISSION_COMMENTS[entry.requestBody.omitted].toLowerCase()}` : '',
    entry.responseBody?.omitted ? OMISSION_COMMENTS[entry.responseBody.omitted] : '',
    entry.messagesTruncated ? 'Only the first messages of this stream were recorded.' : '',
  ].filter(Boolean);
  return comments.length ? comments.join(' ') : undefined;
}

function harEntry(entry: NetworkEntry, startedAt: number) {
  const response = entry.responseBody;
  const comment = entryComment(entry);
  return {
    _cebianId: entry.id,
    _resourceType: entry.type,
    ...(entry.redirects?.length ? { _redirects: entry.redirects } : {}),
    startedDateTime: new Date(startedAt + entry.t).toISOString(),
    time: entry.durationMs ?? 0,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion: '',
      cookies: [],
      headers: entry.requestHeaders,
      queryString: queryString(entry.url),
      ...(entry.requestBody
        ? {
            postData: {
              mimeType: entry.requestBody.mimeType ?? headerValue(entry.requestHeaders, 'content-type') ?? '',
              text: entry.requestBody.text ?? '',
            },
          }
        : {}),
      headersSize: -1,
      bodySize: entry.requestBody?.transferSize ?? -1,
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? '',
      httpVersion: '',
      cookies: [],
      headers: entry.responseHeaders ?? [],
      content: {
        // 解压后的内容大小；传输大小（可能是压缩后的）放在 bodySize
        size: response?.size ?? 0,
        mimeType: response?.mimeType ?? headerValue(entry.responseHeaders, 'content-type') ?? '',
        ...(response?.text != null ? { text: response.text } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: response?.transferSize ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
    // Chrome DevTools 导入 HAR 时认这个字段，显示 WebSocket 消息
    ...(entry.messages?.length
      ? {
          _webSocketMessages: entry.messages.map((m) => ({
            type: m.direction === 'sent' ? 'send' : 'receive',
            time: (startedAt + m.t) / 1000,
            opcode: m.binary ? 2 : 1,
            data: m.data,
          })),
        }
      : {}),
    ...(comment ? { comment } : {}),
  };
}

function logComment(log: NetworkLog): string {
  const abortedNote = log.abortedAt != null
    ? `Network recording was stopped by the user ${Math.round(log.abortedAt / 1000)}s into the recording.`
    : 'Network recording was stopped by the user.';
  return [
    log.state === 'aborted' ? abortedNote : '',
    log.state === 'unavailable' ? `Network recording was unavailable: ${log.unavailableReason ?? 'unknown reason'}.` : '',
    ...(log.unavailableTabs ?? []).map((tab) => `Tab ${tab.tabId} could not be recorded: ${tab.reason}.`),
    log.truncated ? 'Network recording stopped early after reaching its size or entry limit.' : '',
    log.filteredCount ? `${log.filteredCount} analytics or monitoring requests were left out.` : '',
    'Sensitive headers, query parameters and body fields are replaced with [redacted]; cookies are not recorded.',
  ].filter(Boolean).join(' ');
}

/** 生成 HAR 文本（多行缩进）。`startedAt` 为录制开始的绝对时刻，`creatorVersion` 为扩展版本。 */
function buildHar(log: NetworkLog, startedAt: number, creatorVersion: string): string {
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Cebian', version: creatorVersion },
      pages: [],
      entries: log.entries.map((entry) => harEntry(entry, startedAt)),
      comment: logComment(log),
    },
  };
  return JSON.stringify(har, null, 2);
}

// ─── 公开 API ───

export { buildHar };
