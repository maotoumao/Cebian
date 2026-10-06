// 录制时间线的时间换算：事件的 `t` 取页面端记下的发生时刻，而不是后台收到消息的时刻。
//
// 输入有 800ms 防抖、结构变化攒批发送、滚动按窗口聚合，后台收到时最多会晚一两秒；
// 用收到时刻打 `t` 会让事件和同一时刻发出的网络请求错序。页面与后台的 `Date.now()`
// 共用系统时钟，可以直接比较。

import type { RecordedEvent } from '@/lib/recorder/types';

/**
 * 事件相对录制开始的毫秒数。`at` 是页面端记下的发生时刻（缺省用后台收到时刻 `now`），
 * 夹到 [startedAt, now] 内：录制开始前就已发生、或时钟稍有偏差的事件不会得到超前的 `t`；
 * 系统时钟被往回调到录制开始之前时也不会得到负数。取整到毫秒：网络事件的时刻来自 CDP 的
 * 浮点时间戳，小数位对时间线没有意义，只会多占 token。
 */
function eventOffset(at: number | undefined, now: number, startedAt: number): number {
  return Math.max(0, Math.round(Math.min(at ?? now, now) - startedAt));
}

/** 按 `t` 稳定排序：事件按到达顺序入列，定稿时恢复成发生顺序（schema 约定 `t` 不递减）。 */
function sortByTime(events: RecordedEvent[]): RecordedEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t - b.event.t || a.index - b.index)
    .map(({ event }) => event);
}

// ─── 公开 API ───

export { eventOffset, sortByTime };
