import { describe, expect, it } from 'vitest';
import {
  SkillSnapshotRegistry,
  createSkillSnapshot,
} from '@/lib/tools/skill-snapshot';

describe('createSkillSnapshot', () => {
  it('相同权限与文件内容生成相同摘要', async () => {
    const first = await createSkillSnapshot({
      permissions: ['vfs.read', 'chrome.cookies'],
      skillMd: '---\nname: demo\n---\nDemo',
      scriptPath: 'scripts/run.js',
      script: 'module.exports = 1;',
    });
    const second = await createSkillSnapshot({
      permissions: ['vfs.read', 'chrome.cookies'],
      skillMd: '---\nname: demo\n---\nDemo',
      scriptPath: 'scripts/run.js',
      script: 'module.exports = 1;',
    });

    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['权限变化', { permissions: ['chrome.cookies'] }],
    ['SKILL.md 变化', { skillMd: '---\nname: demo\n---\nChanged' }],
    ['脚本路径变化', { scriptPath: 'scripts/other.js' }],
    ['脚本内容变化', { script: 'module.exports = 2;' }],
  ])('%s会生成不同摘要', async (_label, override) => {
    const base = {
      permissions: ['vfs.read'],
      skillMd: '---\nname: demo\n---\nDemo',
      scriptPath: 'scripts/run.js',
      script: 'module.exports = 1;',
    };

    const before = await createSkillSnapshot(base);
    const after = await createSkillSnapshot({ ...base, ...override });

    expect(after.digest).not.toBe(before.digest);
  });
});

describe('SkillSnapshotRegistry', () => {
  it('按 toolCallId 保存并一次性消费快照', async () => {
    const registry = new SkillSnapshotRegistry();
    const snapshot = await createSkillSnapshot({
      permissions: ['vfs.read'],
      skillMd: 'skill',
      scriptPath: 'scripts/run.js',
      script: 'code',
    });

    registry.set('call-1', snapshot);

    expect(registry.get('call-1')).toEqual(snapshot);
    expect(registry.take('call-1')).toEqual(snapshot);
    expect(() => registry.take('call-1')).toThrow(/no authorization snapshot/i);
  });

  it('当前摘要与授权摘要不同时失败关闭', async () => {
    const registry = new SkillSnapshotRegistry();
    const approved = await createSkillSnapshot({
      permissions: ['vfs.read'],
      skillMd: 'skill',
      scriptPath: 'scripts/run.js',
      script: 'before',
    });
    const changed = await createSkillSnapshot({
      permissions: ['chrome.cookies'],
      skillMd: 'changed skill',
      scriptPath: 'scripts/run.js',
      script: 'after',
    });
    registry.set('call-2', approved);

    expect(() => registry.assertMatch('call-2', changed)).toThrow(/changed while permission/i);
    expect(() => registry.take('call-2')).toThrow(/no authorization snapshot/i);
  });

  it('显式丢弃拒绝或取消的授权快照', async () => {
    const registry = new SkillSnapshotRegistry();
    const snapshot = await createSkillSnapshot({
      permissions: [],
      skillMd: 'skill',
      scriptPath: 'scripts/run.js',
      script: 'code',
    });
    registry.set('call-3', snapshot);

    registry.delete('call-3');

    expect(() => registry.take('call-3')).toThrow(/no authorization snapshot/i);
  });
});
