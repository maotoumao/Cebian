import { describe, it, expect } from 'vitest';
import { buildMemoriesBlock, memoryAge, renderUserProfileBlock, USER_PROFILE_FILE } from '@/lib/memory/index-scan';
import { parseMemoryType, type MemoryMeta } from '@/lib/memory/types';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // 固定 now，保证年龄渲染可断言

function meta(over: Partial<MemoryMeta>): MemoryMeta {
  return {
    name: 'm',
    description: 'd',
    type: 'user',
    filePath: '~/.cebian/memories/m.md',
    mtimeMs: NOW,
    ...over,
  };
}

describe('parseMemoryType', () => {
  it('合法值原样返回', () => {
    expect(parseMemoryType('user')).toBe('user');
    expect(parseMemoryType('feedback')).toBe('feedback');
    expect(parseMemoryType('context')).toBe('context');
    expect(parseMemoryType('reference')).toBe('reference');
  });

  it('未知 / 非字符串 → undefined（宽容降级）', () => {
    expect(parseMemoryType('project')).toBeUndefined(); // 编码味的旧类型，已弃用
    expect(parseMemoryType('')).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
    expect(parseMemoryType(42)).toBeUndefined();
    expect(parseMemoryType(null)).toBeUndefined();
  });
});

describe('memoryAge', () => {
  it('today / yesterday / N days ago', () => {
    expect(memoryAge(NOW, NOW)).toBe('today');
    expect(memoryAge(NOW - 0.3 * DAY, NOW)).toBe('today'); // 同一 UTC 日内仍 today
    expect(memoryAge(NOW - 1 * DAY, NOW)).toBe('yesterday');
    expect(memoryAge(NOW - 2 * DAY, NOW)).toBe('2 days ago');
    expect(memoryAge(NOW - 47 * DAY, NOW)).toBe('47 days ago');
  });

  it('未来 mtime（时钟偏移）钳到 today', () => {
    expect(memoryAge(NOW + 5 * DAY, NOW)).toBe('today');
  });

  it('按 UTC 日分桶：同一 UTC 日内不随时刻漂移（24h 滑窗会算错）', () => {
    const todayStart = 19_675 * DAY; // 任取一个 UTC 日的 0 点
    const mtime = todayStart - DAY + 5 * 3_600_000; // 昨天 05:00
    // 今天 00:00:01 与今天 23:00，年龄都应是 'yesterday'
    expect(memoryAge(mtime, todayStart + 1_000)).toBe('yesterday');
    expect(memoryAge(mtime, todayStart + 23 * 3_600_000)).toBe('yesterday');
  });
});

describe('buildMemoriesBlock', () => {
  it('空集合 → 空串', () => {
    expect(buildMemoriesBlock([], NOW)).toBe('');
  });

  it('渲染 name / type / age / description / file', () => {
    const block = buildMemoriesBlock(
      [meta({ name: 'User role', description: 'is a designer', mtimeMs: NOW - 3 * DAY })],
      NOW,
    );
    expect(block).toContain('<memories>');
    expect(block).toContain('<name>User role</name>');
    expect(block).toContain('<type>user</type>');
    expect(block).toContain('<age>3 days ago</age>');
    expect(block).toContain('<description>is a designer</description>');
    expect(block).toContain('<file>~/.cebian/memories/m.md</file>');
    expect(block.trimEnd().endsWith('</memories>')).toBe(true);
  });

  it('缺 type / description 时省略对应标签', () => {
    const block = buildMemoriesBlock([meta({ type: undefined, description: '' })], NOW);
    expect(block).not.toContain('<type>');
    expect(block).not.toContain('<description>');
    expect(block).toContain('<name>m</name>');
  });

  it('转义 XML 特殊字符', () => {
    const block = buildMemoriesBlock(
      [meta({ name: 'a < b & c', description: 'x </memories> y' })],
      NOW,
    );
    expect(block).toContain('<name>a &lt; b &amp; c</name>');
    expect(block).not.toContain('a < b & c');
  });

  it('排序确定性：打乱输入 → 逐字节一致（按 filePath）', () => {
    const a = meta({ filePath: '~/.cebian/memories/a.md' });
    const b = meta({ filePath: '~/.cebian/memories/b.md' });
    const c = meta({ filePath: '~/.cebian/memories/c.md' });
    const sorted = buildMemoriesBlock([a, b, c], NOW);
    const shuffled = buildMemoriesBlock([c, a, b], NOW);
    expect(shuffled).toBe(sorted);
    // a 必须排在 c 前面
    expect(sorted.indexOf('a.md')).toBeLessThan(sorted.indexOf('c.md'));
  });

  it('超过字节上限 → 截断并附说明', () => {
    const big = 'x'.repeat(10_000);
    const metas = Array.from({ length: 5 }, (_, i) =>
      meta({ filePath: `~/.cebian/memories/m${i}.md`, description: big }),
    );
    const block = buildMemoriesBlock(metas, NOW);
    expect(block).toContain('truncated to');
    // 5 条 × ~10KB 远超 25KB，必然少于 5 条
    const count = (block.match(/<memory>/g) ?? []).length;
    expect(count).toBeLessThan(5);
    expect(count).toBeGreaterThan(0);
  });

  it('至少保留一条，即使它本身超限', () => {
    const huge = 'y'.repeat(40_000);
    const block = buildMemoriesBlock([meta({ description: huge })], NOW);
    expect((block.match(/<memory>/g) ?? []).length).toBe(1);
    expect(block).not.toContain('truncated to'); // 只有一条、没有被丢弃的，不报截断
  });

  it('user_profile.md 不进索引（走常驻全文）', () => {
    const profile = meta({ filePath: `~/.cebian/memories/${USER_PROFILE_FILE}` });
    const other = meta({ filePath: '~/.cebian/memories/feedback_terse.md' });
    expect(buildMemoriesBlock([profile], NOW)).toBe(''); // 只有 profile → 空索引
    const block = buildMemoriesBlock([profile, other], NOW);
    expect(block).not.toContain(USER_PROFILE_FILE);
    expect(block).toContain('feedback_terse.md');
  });
});

describe('renderUserProfileBlock', () => {
  it('cap 内 → 整段正文注入', () => {
    const block = renderUserProfileBlock('猫咪，后端工程师，红绿色弱', 'desc');
    expect(block).toContain('<user_profile>');
    expect(block).toContain('猫咪');
    expect(block).toContain('红绿色弱');
    expect(block.trimEnd().endsWith('</user_profile>')).toBe(true);
  });

  it('空正文 → 空串（不注入空壳）', () => {
    expect(renderUserProfileBlock('   ', 'desc')).toBe('');
  });

  it('超 cap → 只注摘要 + note，不含全文', () => {
    const body = 'x'.repeat(5000);
    const block = renderUserProfileBlock(body, '后端工程师，红绿色弱');
    expect(block).toContain('后端工程师，红绿色弱');
    expect(block).toContain('<note>');
    expect(block).not.toContain('x'.repeat(5000));
  });

  it('转义 XML 特殊字符', () => {
    const block = renderUserProfileBlock('a < b </user_profile> & c', 'd');
    expect(block).toContain('a &lt; b');
    expect(block).not.toContain('a < b </user_profile>');
  });
});
