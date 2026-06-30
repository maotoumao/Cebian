// 自动整理调度的「纯决策」逻辑——不碰 IO / chrome.alarms，便于单测。
// 由 background 的 maybeAutoOrganize 收集信号后调用。

import type { MemoryManifest } from './organize-plan';

const DAY_MS = 86_400_000;

/** 真跑后被冲突/失败丢弃 → 退避窗口内不自动重试（避免反复烧 token）。idle 拦截不计入。 */
export const ORGANIZE_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** 自动整理策略（来自 memorySettings.organize）。 */
export interface OrganizePolicy {
  auto: boolean;
  intervalDays: number;
  minNewMemories: number;
}

/** 决策所需的运行时信号。 */
export interface OrganizeSignals {
  now: number;
  /** 上次成功整理时间。 */
  lastRunAt?: number;
  /** 上次尝试整理时间（真跑过的，含冲突/失败）。 */
  lastAttemptAt?: number;
  /** 自上次成功整理起新增/改动的记忆档数。 */
  newMemoryCount: number;
  /** 是否有活跃对话（idle 门控）。 */
  hasActiveSession: boolean;
}

/** mtime 晚于 since 的记忆档数（since 缺省视为 0 → 全部算「新」）。 */
export function countNewMemories(manifest: MemoryManifest, since?: number): number {
  const t = since ?? 0;
  let n = 0;
  for (const mtime of Object.values(manifest)) {
    if (mtime > t) n++;
  }
  return n;
}

/**
 * 是否该自动跑整理。依次短路（任一不满足即否）：
 * - auto 关 → 否。
 * - 有活跃对话 → 否（idle 门控；不算一次 attempt，下个 tick 再看）。
 * - 在退避窗口内（距上次「真跑」不足 ORGANIZE_BACKOFF_MS）→ 否。
 * - 距上次「成功整理」不足 intervalDays → 否。
 * - 新增记忆不足 minNewMemories → 否。
 * - 否则 → 是。
 */
export function shouldRunOrganize(policy: OrganizePolicy, s: OrganizeSignals): boolean {
  if (!policy.auto) return false;
  if (s.hasActiveSession) return false;
  if (s.lastAttemptAt !== undefined && s.now - s.lastAttemptAt < ORGANIZE_BACKOFF_MS) return false;
  if (s.lastRunAt !== undefined && s.now - s.lastRunAt < policy.intervalDays * DAY_MS) return false;
  if (s.newMemoryCount < policy.minNewMemories) return false;
  return true;
}
