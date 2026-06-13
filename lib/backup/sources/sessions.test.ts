import { describe, it, expect } from 'vitest';
import { planSessionWrites, type ExistingSessionMeta } from '@/lib/backup/sources/sessions';
import type { SessionRecord } from '@/lib/db';

function rec(id: string, updatedAt: number): SessionRecord {
  return {
    id,
    title: `t-${id}`,
    model: 'm',
    provider: 'p',
    userInstructions: '',
    thinkingLevel: 'medium',
    messageCount: 0,
    createdAt: 0,
    updatedAt,
    messages: [],
  };
}

const existing: ExistingSessionMeta[] = [
  { id: 'a', updatedAt: 100 },
  { id: 'b', updatedAt: 200 },
];

describe('planSessionApply — replace', () => {
  it('clearAll=true，toPut 为全部 incoming，无跳过', () => {
    const incoming = [rec('a', 50), rec('c', 10)];
    const plan = planSessionWrites(existing, incoming, 'replace');
    expect(plan.clearAll).toBe(true);
    expect(plan.toPut.map((r) => r.id)).toEqual(['a', 'c']);
    expect(plan.skipped).toEqual([]);
  });

  it('incoming 为空 → 清空且不写入（等价清库）', () => {
    const plan = planSessionWrites(existing, [], 'replace');
    expect(plan.clearAll).toBe(true);
    expect(plan.toPut).toEqual([]);
  });
});

describe('planSessionApply — merge（只增不减）', () => {
  it('本地缺失的会话被写入', () => {
    const incoming = [rec('c', 1)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.clearAll).toBe(false);
    expect(plan.toPut.map((r) => r.id)).toEqual(['c']);
    expect(plan.skipped).toEqual([]);
  });

  it('备份更新（updatedAt 更大）→ 写入覆盖', () => {
    const incoming = [rec('a', 150)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.toPut.map((r) => r.id)).toEqual(['a']);
    expect(plan.skipped).toEqual([]);
  });

  it('备份更旧 → 跳过（旧备份不覆盖更新的本地会话）', () => {
    const incoming = [rec('b', 50)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.toPut).toEqual([]);
    expect(plan.skipped).toEqual(['b']);
  });

  it('updatedAt 相等 → 跳过（视为本地不更旧）', () => {
    const incoming = [rec('a', 100)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.toPut).toEqual([]);
    expect(plan.skipped).toEqual(['a']);
  });

  it('混合：新增 + 更新 + 跳过 同时正确分流', () => {
    const incoming = [rec('a', 150), rec('b', 50), rec('c', 1)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.toPut.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(plan.skipped).toEqual(['b']);
  });

  it('绝不删除本地多出来的会话（existing 多于 incoming 时无删除动作）', () => {
    const incoming = [rec('a', 150)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    // b 不在 incoming 里，但 merge 不产生任何删除信号。
    expect(plan.clearAll).toBe(false);
    expect(plan.toPut.map((r) => r.id)).toEqual(['a']);
    expect(plan.skipped).toEqual([]);
  });
});

describe('planSessionApply — incoming 重复 id 去重', () => {
  it('merge：同 id 重复（newer 后 older）只保留 updatedAt 最大的一条', () => {
    const incoming = [rec('c', 200), rec('c', 100)];
    const plan = planSessionWrites(existing, incoming, 'merge');
    expect(plan.toPut).toHaveLength(1);
    expect(plan.toPut[0].id).toBe('c');
    expect(plan.toPut[0].updatedAt).toBe(200);
  });

  it('replace：同 id 重复也只保留 updatedAt 最大的一条', () => {
    const incoming = [rec('c', 100), rec('c', 300), rec('d', 5)];
    const plan = planSessionWrites(existing, incoming, 'replace');
    const c = plan.toPut.filter((r) => r.id === 'c');
    expect(c).toHaveLength(1);
    expect(c[0].updatedAt).toBe(300);
    expect(plan.toPut.map((r) => r.id).sort()).toEqual(['c', 'd']);
  });
});
