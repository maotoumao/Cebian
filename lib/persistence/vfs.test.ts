// fake-indexeddb 必须先于 lightning-fs 首次触碰 indexedDB 注入全局（vfs.ts 是懒初始化，
// 第一次 IO 发生在测试体内，但仍按同类测试文件的惯例放在首行）。
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { PROTECTED_VFS_ROOTS, isProtectedVfsRoot, vfs } from '@/lib/persistence/vfs';

// 前半部分：受保护根是 VFS 层的结构不变量，恢复 / 清空必须保证它们恒为目录，只覆盖
// 纯谓词。后半部分（copyDir）驱动真实 lightning-fs。
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

// ─── copyDir（真实 lightning-fs，IndexedDB 由 fake-indexeddb 提供） ───
//
// 只覆盖分叉工作区复制依赖的三条语义：嵌套文件按相对路径复制、源不存在为 no-op、
// dest 里已有文件不被误删。lightning-fs 的库名是固定的 "cebian-vfs"，同一测试文件内
// 用不同的根目录隔离用例即可。

const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  const raw = await vfs.readFile(path, 'utf8');
  return typeof raw === 'string' ? raw : decoder.decode(raw as Uint8Array);
}

describe('vfs.copyDir', () => {
  it('递归复制常规文件并保留相对路径；同名文件覆盖、其它已有文件保留', async () => {
    await vfs.writeFile('/workspaces/src-a/top.txt', 'top');
    await vfs.writeFile('/workspaces/src-a/nested/deep/leaf.md', 'leaf');
    await vfs.writeFile('/workspaces/dst-a/keep.txt', 'keep');
    await vfs.writeFile('/workspaces/dst-a/top.txt', 'stale');

    await vfs.copyDir('/workspaces/src-a', '/workspaces/dst-a');

    expect(await readText('/workspaces/dst-a/top.txt')).toBe('top');
    expect(await readText('/workspaces/dst-a/nested/deep/leaf.md')).toBe('leaf');
    expect(await readText('/workspaces/dst-a/keep.txt')).toBe('keep');
    // 源保持原样
    expect(await readText('/workspaces/src-a/top.txt')).toBe('top');
  });

  it('源目录不存在 → no-op，不创建 dest', async () => {
    await vfs.copyDir('/workspaces/does-not-exist', '/workspaces/dst-b');
    expect(await vfs.exists('/workspaces/dst-b')).toBe(false);
  });
});
