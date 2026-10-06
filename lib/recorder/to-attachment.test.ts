import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { recordingToAttachment } from './to-attachment';
import type { RecordedEvent, RecordedSession } from './types';
import type { NetworkEntry, NetworkLog } from './network-types';
import { MAX_RECORDING_SIZE } from '@/lib/agent/attachments';

const click = (t: number, id = `e${t}`): RecordedEvent => ({
  id,
  t,
  tabId: 7,
  url: 'https://app.test/page',
  kind: 'interaction',
  action: 'click',
  target: { selector: '#go', tag: 'button' },
});

const request = (t: number, overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: `n${t}`,
  t,
  tabId: 7,
  type: 'fetch',
  method: 'POST',
  url: 'https://api.test/search',
  requestHeaders: [],
  requestBody: { text: '{"q":"shoes"}' },
  status: 200,
  responseBody: { text: '{"items":[{"name":"a"}]}' },
  durationMs: 40,
  ...overrides,
});

const session = (events: RecordedEvent[], network?: Partial<NetworkLog> & { entries: NetworkEntry[] }): RecordedSession => ({
  version: 1,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_005_000,
  durationMs: 5000,
  windowId: 1,
  events,
  ...(network ? { network: { state: 'active', filteredCount: 0, ...network } } : {}),
});

const wire = (json: string) => JSON.parse(json) as { events: Array<Record<string, unknown>>; network?: Record<string, unknown> };

describe('recordingToAttachment', () => {
  beforeEach(() => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '9.9.9' } as ReturnType<typeof fakeBrowser.runtime.getManifest>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('没开网络录制时的完整输出：标签页表、各类事件字段与原来一致', () => {
    const events: RecordedEvent[] = [
      click(10),
      { id: 'e2', t: 20, tabId: 9, url: 'https://b.test/', kind: 'tab', event: 'focus_changed', title: '' },
      { id: 'e3', t: 30, tabId: 9, url: 'https://b.test/', kind: 'mutation', changes: [{ op: 'appeared', tag: 'div', label: '提示 <ok>' }] },
    ];
    const att = recordingToAttachment(session(events));
    expect(JSON.parse(att.json)).toEqual({
      version: 1,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_005_000,
      durationMs: 5000,
      windowId: 1,
      tabs: [7, 9],
      events: [
        { id: 'e10', t: 10, tIdx: 0, kind: 'interaction', action: 'click', target: { selector: '#go', tag: 'button' } },
        { id: 'e2', t: 20, tIdx: 1, kind: 'tab', event: 'focus_changed', url: 'https://b.test/' },
        { id: 'e3', t: 30, tIdx: 1, kind: 'mutation', changes: [{ op: 'appeared', tag: 'div', label: '提示 <ok>' }] },
      ],
    });
    expect(att).toMatchObject({ eventCount: 3, durationMs: 5000 });
  });

  it('没开网络录制时超限仍从末尾截事件（多字节文本按字节计）', () => {
    const events = Array.from({ length: 2000 }, (_, i): RecordedEvent => ({
      id: `m${i}`, t: i, tabId: 7, url: 'https://app.test/', kind: 'mutation',
      changes: [{ op: 'appeared', tag: 'p', textPreview: '中文'.repeat(40) }],
    }));
    const att = recordingToAttachment(session(events));
    expect(att.sizeBytes).toBeLessThanOrEqual(MAX_RECORDING_SIZE);
    expect(att.sizeBytes).toBe(new TextEncoder().encode(att.json).length);
    expect(att.truncatedAttachment).toBe(true);
    const body = wire(att.json);
    expect(att.eventCount).toBe(body.events.length);
    expect(body.events[0].id).toBe('m0');
  });

  it('没开网络录制时与原来一致：没有网络字段与 HAR', () => {
    const att = recordingToAttachment(session([click(10), click(20)]));
    expect(att.eventCount).toBe(2);
    expect(att.networkCount).toBeUndefined();
    expect(att.har).toBeUndefined();
    expect(wire(att.json).network).toBeUndefined();
  });

  it('网络条目按 t 并入时间线，事件数不含网络条目，HAR 单独携带不进内联 JSON', () => {
    const att = recordingToAttachment(session([click(10), click(50)], {
      entries: [request(20), request(60)],
      filteredCount: 3,
    }));
    const body = wire(att.json);
    expect(body.events.map((e) => [e.kind, e.t])).toEqual([
      ['interaction', 10], ['network', 20], ['interaction', 50], ['network', 60],
    ]);
    // 网络条目保留请求地址与 tIdx，去掉 tabId
    expect(body.events[1]).toMatchObject({ url: 'https://api.test/search', tIdx: 0, req: '{"q":"shoes"}' });
    expect(body.events[1]).not.toHaveProperty('tabId');
    expect(body.network).toEqual({ state: 'active', requests: 2, filtered: 3 });
    expect(att).toMatchObject({ eventCount: 2, networkCount: 2, filteredCount: 3, networkState: 'active' });
    expect(att.har!.name).toBe(att.name.replace(/\.json$/, '.har'));
    const har = JSON.parse(att.har!.json).log;
    expect(har.entries).toHaveLength(2);
    expect(har.creator.version).toBe('9.9.9');
    expect(att.json).not.toContain('"log"');
  });

  it('同一时刻操作排在请求前面（点击引发的请求跟在点击之后）', () => {
    const att = recordingToAttachment(session([click(30)], { entries: [request(30)] }));
    expect(wire(att.json).events.map((e) => e.kind)).toEqual(['interaction', 'network']);
  });

  it('结构概要去掉后放得下时，只去掉概要，预览保留', () => {
    const wideShape = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a_rather_long_field_name_${i}`, 1]));
    const entries = Array.from({ length: 450 }, (_, i) => request(i + 1, {
      requestBody: undefined,
      responseBody: { text: JSON.stringify(wideShape) },
    }));
    const att = recordingToAttachment(session([], { entries }));
    const body = wire(att.json);
    expect(att.sizeBytes).toBeLessThanOrEqual(MAX_RECORDING_SIZE);
    expect(body.network!.previews).toBe('no_shape');
    expect(att.truncatedAttachment).toBeUndefined();
    expect(body.events.every((e) => 'res' in e && !('shape' in e))).toBe(true);
  });

  it('还放不下时再去掉请求 / 响应预览（HAR 里仍是完整内容），不截事件', () => {
    const big = 'x'.repeat(250);
    const entries = Array.from({ length: 700 }, (_, i) => request(i + 1, {
      responseBody: { text: JSON.stringify({ [`field_${i}`]: big }) },
      requestBody: { text: big },
    }));
    const att = recordingToAttachment(session([click(0)], { entries }));
    const body = wire(att.json);
    expect(att.sizeBytes).toBeLessThanOrEqual(MAX_RECORDING_SIZE);
    expect(body.network!.previews).toBe('no_previews');
    expect(att.truncatedAttachment).toBeUndefined();
    const net = body.events.filter((e) => e.kind === 'network');
    expect(net).toHaveLength(700);
    expect(net.some((e) => 'req' in e || 'res' in e || 'shape' in e)).toBe(false);
    expect(JSON.parse(att.har!.json).log.entries[0].response.content.text).toContain(big);
  });

  it('全部降级后仍超限才从末尾截掉事件，并标出实际带上的请求数', () => {
    const entries = Array.from({ length: 3000 }, (_, i) => request(i + 1, {
      url: `https://api.test/${'p'.repeat(150)}/${i}`,
    }));
    const att = recordingToAttachment(session([click(0)], { entries }));
    const body = wire(att.json);
    expect(att.sizeBytes).toBeLessThanOrEqual(MAX_RECORDING_SIZE);
    expect(att.truncatedAttachment).toBe(true);
    expect(body.network!.previews).toBe('no_previews');
    expect(body.network!.requests).toBe(3000);
    expect(body.network!.included).toBe(att.networkCount);
    expect(att.networkCount).toBeLessThan(3000);
    expect(body.events[0].kind).toBe('interaction');
  });

  it('网络录制中止 / 不可用的情况写进顶层概要与附件', () => {
    const aborted = recordingToAttachment(session([click(10)], { entries: [request(5)], state: 'aborted', abortedAt: 8 }));
    expect(wire(aborted.json).network).toMatchObject({ state: 'aborted', abortedAt: 8 });
    expect(aborted.networkState).toBe('aborted');
    const unavailable = recordingToAttachment(session([click(10)], {
      entries: [],
      state: 'unavailable',
      unavailableReason: 'permission_denied',
    }));
    expect(wire(unavailable.json).network).toMatchObject({ state: 'unavailable', requests: 0 });
    expect(unavailable).toMatchObject({ networkCount: 0, networkState: 'unavailable' });
    // 没录到请求时不带空 HAR
    expect(unavailable.har).toBeUndefined();
  });
});
