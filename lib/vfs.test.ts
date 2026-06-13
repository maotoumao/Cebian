import { describe, it, expect } from 'vitest';
import { PROTECTED_VFS_ROOTS, isProtectedVfsRoot } from '@/lib/vfs';

// 受保护根是 VFS 层的结构不变量：恢复 / 清空必须保证它们恒为目录。这里只覆盖纯谓词，
// 不碰 IndexedDB。
describe('PROTECTED_VFS_ROOTS', () => {
  it('涵盖 VFS 根、工作区、技能、提示词四个结构根', () => {
    expect([...PROTECTED_VFS_ROOTS].sort()).toEqual(
      [
        '/',
        '/home/user/.cebian/prompts',
        '/home/user/.cebian/skills',
        '/workspaces',
      ].sort(),
    );
  });
});

describe('isProtectedVfsRoot', () => {
  it('正好等于受保护根 → true（含未归一化输入）', () => {
    expect(isProtectedVfsRoot('/')).toBe(true);
    expect(isProtectedVfsRoot('/workspaces')).toBe(true);
    expect(isProtectedVfsRoot('/workspaces/')).toBe(true); // 尾斜杠归一化
    expect(isProtectedVfsRoot('~/.cebian/skills')).toBe(true); // ~ 归一化
    expect(isProtectedVfsRoot('/home/user/.cebian/prompts')).toBe(true);
  });

  it('受保护根的子孙 / 无关路径 → false', () => {
    expect(isProtectedVfsRoot('/workspaces/abc')).toBe(false);
    expect(isProtectedVfsRoot('/workspaces/abc/file.txt')).toBe(false);
    expect(isProtectedVfsRoot('/home/user/.cebian/skills/foo/SKILL.md')).toBe(false);
    expect(isProtectedVfsRoot('/home/user/other')).toBe(false);
    expect(isProtectedVfsRoot('/random')).toBe(false);
  });
});
