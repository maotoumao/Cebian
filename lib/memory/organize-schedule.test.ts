import { describe, it, expect } from 'vitest';
import {
  countNewMemories,
  shouldRunOrganize,
  ORGANIZE_BACKOFF_MS,
  type OrganizePolicy,
  type OrganizeSignals,
} from '@/lib/memory/organize-schedule';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const POLICY: OrganizePolicy = { auto: true, intervalDays: 14, minNewMemories: 30 };

/** 默认「应该跑」的信号：auto 开、空闲、无退避、超间隔、新增达标。 */
function signals(over: Partial<OrganizeSignals> = {}): OrganizeSignals {
  return {
    now: NOW,
    lastRunAt: NOW - 30 * DAY,
    lastAttemptAt: NOW - 30 * DAY,
    newMemoryCount: 50,
    hasActiveSession: false,
    ...over,
  };
}

describe('countNewMemories', () => {
  it('数 mtime 晚于 since 的档', () => {
    const m = { 'a.md': 100, 'b.md': 200, 'c.md': 300 };
    expect(countNewMemories(m, 150)).toBe(2); // b, c
    expect(countNewMemories(m, 0)).toBe(3);
    expect(countNewMemories(m, 500)).toBe(0);
  });

  it('since 缺省 → 全部算新', () => {
    expect(countNewMemories({ 'a.md': 1, 'b.md': 2 })).toBe(2);
  });

  it('空目录 → 0', () => {
    expect(countNewMemories({}, 100)).toBe(0);
  });
});

describe('shouldRunOrganize', () => {
  it('全满足 → 跑', () => {
    expect(shouldRunOrganize(POLICY, signals())).toBe(true);
  });

  it('auto 关 → 否', () => {
    expect(shouldRunOrganize({ ...POLICY, auto: false }, signals())).toBe(false);
  });

  it('有活跃对话 → 否（idle 门控）', () => {
    expect(shouldRunOrganize(POLICY, signals({ hasActiveSession: true }))).toBe(false);
  });

  it('退避窗口内（距上次真跑不足 6h）→ 否', () => {
    expect(shouldRunOrganize(POLICY, signals({ lastAttemptAt: NOW - ORGANIZE_BACKOFF_MS + 1000 }))).toBe(false);
  });

  it('退避窗口外 → 不挡', () => {
    expect(shouldRunOrganize(POLICY, signals({ lastAttemptAt: NOW - ORGANIZE_BACKOFF_MS - 1000 }))).toBe(true);
  });

  it('距上次成功整理不足 interval → 否', () => {
    expect(shouldRunOrganize(POLICY, signals({ lastRunAt: NOW - 5 * DAY, lastAttemptAt: undefined }))).toBe(false);
  });

  it('新增不足阈值 → 否', () => {
    expect(shouldRunOrganize(POLICY, signals({ newMemoryCount: 10 }))).toBe(false);
  });

  it('从未跑过（lastRunAt/lastAttemptAt 均缺省）+ 新增达标 → 跑', () => {
    expect(
      shouldRunOrganize(POLICY, signals({ lastRunAt: undefined, lastAttemptAt: undefined })),
    ).toBe(true);
  });
});
