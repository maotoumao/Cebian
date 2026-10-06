import { describe, expect, it } from 'vitest';
import type { RecordedEvent } from '@/lib/recorder/types';
import { eventOffset, sortByTime } from './timeline';

describe('eventOffset', () => {
  it('按页面端的发生时刻计算，而不是收到时刻', () => {
    expect(eventOffset(1_200, 2_000, 1_000)).toBe(200);
  });

  it('没有发生时刻时用收到时刻', () => {
    expect(eventOffset(undefined, 2_000, 1_000)).toBe(1_000);
  });

  it('夹到录制区间内：开始之前的记为 0，超前的不超过收到时刻', () => {
    expect(eventOffset(500, 2_000, 1_000)).toBe(0);
    expect(eventOffset(2_500, 2_000, 1_000)).toBe(1_000);
  });

  it('取整到毫秒（网络事件的时刻带小数）', () => {
    expect(eventOffset(1_200.6, 2_000, 1_000)).toBe(201);
    expect(eventOffset(1_200.4, 2_000, 1_000)).toBe(200);
  });

  it('系统时钟被往回调到录制开始之前时不出现负数', () => {
    expect(eventOffset(1_100, 900, 1_000)).toBe(0);
    expect(eventOffset(undefined, 900, 1_000)).toBe(0);
  });
});

describe('sortByTime', () => {
  const event = (id: string, t: number) =>
    ({ id, t, tabId: 1, url: 'https://a.test', kind: 'tab', event: 'focus_changed' }) as RecordedEvent;

  it('按 t 恢复发生顺序：防抖后才到达的输入排回它真正发生的位置', () => {
    const arrived = [event('click', 100), event('request', 300), event('input', 50)];
    expect(sortByTime(arrived).map((e) => e.id)).toEqual(['input', 'click', 'request']);
  });

  it('t 相同时保持到达顺序', () => {
    const arrived = [event('a', 100), event('b', 100), event('c', 100)];
    expect(sortByTime(arrived).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
