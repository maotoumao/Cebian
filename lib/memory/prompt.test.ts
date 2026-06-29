import { describe, it, expect } from 'vitest';
import { MEMORY_INSTRUCTIONS, memoryLimitationLine } from '@/lib/memory/prompt';
import { CEBIAN_MEMORIES_DIR } from '@/lib/persistence/vfs-paths';
import { MEMORY_TYPES } from '@/lib/memory/types';

describe('memoryLimitationLine', () => {
  it('开 / 关给出不同且诚实的措辞', () => {
    const on = memoryLimitationLine(true);
    const off = memoryLimitationLine(false);
    expect(on).not.toBe(off);
    expect(off).toContain('no memory of previous conversations');
    expect(on).toContain('memory across conversations');
    // 两者都是 Limitations 列表的一个 bullet
    expect(on.startsWith('- ')).toBe(true);
    expect(off.startsWith('- ')).toBe(true);
  });
});

describe('MEMORY_INSTRUCTIONS', () => {
  it('含四类法的全部类型名', () => {
    for (const t of ['<name>user</name>', '<name>feedback</name>', '<name>context</name>', '<name>reference</name>']) {
      expect(MEMORY_INSTRUCTIONS).toContain(t);
    }
  });

  it('含关键小节：不该记 / 怎么存 / 安全', () => {
    expect(MEMORY_INSTRUCTIONS).toContain('### What NOT to save');
    expect(MEMORY_INSTRUCTIONS).toContain('### How to save');
    expect(MEMORY_INSTRUCTIONS).toContain('### Safety');
  });

  it('点名敏感信息排除 + 「即使用户要求也过滤」杀手锏', () => {
    expect(MEMORY_INSTRUCTIONS).toContain('Secrets');
    expect(MEMORY_INSTRUCTIONS).toContain('EVEN IF the user says');
  });

  it('指向记忆目录与 frontmatter 类型（从权威常量推导，防漂移）', () => {
    expect(MEMORY_INSTRUCTIONS).toContain(`${CEBIAN_MEMORIES_DIR}/`);
    expect(MEMORY_INSTRUCTIONS).toContain(MEMORY_TYPES.join(' | '));
  });
});
