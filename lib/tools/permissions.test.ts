import { describe, it, expect } from 'vitest';
import {
  parsePermission,
  isPermissionAllowed,
  classifyPermission,
  type Permission,
} from '@/lib/tools/permissions';

describe('parsePermission — 原始 token → 判别联合', () => {
  it('固定 token 解析正确', () => {
    expect(parsePermission('page.executeJs')).toEqual({ kind: 'pageExecuteJs' });
    expect(parsePermission('vfs.read')).toEqual({ kind: 'vfsRead' });
    expect(parsePermission('vfs.write')).toEqual({ kind: 'vfsWrite' });
  });

  it('bare bgFetch / 带 pattern 的 bgFetch', () => {
    expect(parsePermission('bgFetch')).toEqual({ kind: 'bgFetch' });
    expect(parsePermission('bgFetch:https://api.example.com/*')).toEqual({
      kind: 'bgFetch',
      pattern: 'https://api.example.com/*',
    });
  });

  it('chrome.<ns> 只判形状，不校验白名单存在性', () => {
    expect(parsePermission('chrome.cookies')).toEqual({ kind: 'chrome', namespace: 'cookies' });
    // 不在白名单的 namespace 形状仍合法 —— 有效性交给 isPermissionAllowed。
    expect(parsePermission('chrome.notInWhitelist')).toEqual({
      kind: 'chrome',
      namespace: 'notInWhitelist',
    });
  });

  it('malformed / 未知 token → null', () => {
    expect(parsePermission('bgFetch:')).toBeNull(); // 空 pattern
    expect(parsePermission('chrome.')).toBeNull(); // 空 namespace
    expect(parsePermission('chrome.__proto__')).toBeNull(); // 下划线不符合形状
    expect(parsePermission('totally.unknown')).toBeNull();
    expect(parsePermission('')).toBeNull();
    expect(parsePermission('vfs')).toBeNull();
  });
});

describe('isPermissionAllowed — 运行时是否允许', () => {
  it('固定 token 形状合法即允许', () => {
    expect(isPermissionAllowed('page.executeJs')).toBe(true);
    expect(isPermissionAllowed('vfs.read')).toBe(true);
    expect(isPermissionAllowed('vfs.write')).toBe(true);
    expect(isPermissionAllowed('bgFetch')).toBe(true);
    expect(isPermissionAllowed('bgFetch:https://api.example.com/*')).toBe(true);
  });

  it('chrome.<ns> 需落在白名单', () => {
    expect(isPermissionAllowed('chrome.cookies')).toBe(true);
    expect(isPermissionAllowed('chrome.tabs')).toBe(true);
    expect(isPermissionAllowed('chrome.notInWhitelist')).toBe(false);
  });

  it('继承名 / malformed 不允许', () => {
    expect(isPermissionAllowed('chrome.constructor')).toBe(false);
    expect(isPermissionAllowed('chrome.toString')).toBe(false);
    expect(isPermissionAllowed('bgFetch:')).toBe(false);
    expect(isPermissionAllowed('totally.unknown')).toBe(false);
  });
});

describe('classifyPermission — 敏感分类', () => {
  it('page.executeJs 与任意 chrome.<ns> 为 sensitive', () => {
    expect(classifyPermission('page.executeJs')).toBe('sensitive');
    expect(classifyPermission('chrome.cookies')).toBe('sensitive');
    expect(classifyPermission('chrome.notInWhitelist')).toBe('sensitive');
  });

  it('vfs.* / bgFetch 为 normal', () => {
    expect(classifyPermission('vfs.read')).toBe('normal');
    expect(classifyPermission('vfs.write')).toBe('normal');
    expect(classifyPermission('bgFetch')).toBe('normal');
    expect(classifyPermission('bgFetch:https://api.example.com/*')).toBe('normal');
  });

  it('未知 token 保守归 normal', () => {
    expect(classifyPermission('totally.unknown')).toBe('normal');
  });
});

describe('穷尽守卫 — 每个 kind 都被分类覆盖', () => {
  // 列出全部 kind 的代表 token；新增 kind 时此处不补 → 下方断言会暴露遗漏，
  // classifyPermission 内部的 assertNever 则在编译期强制补分支。
  const samples: Record<Permission['kind'], string> = {
    pageExecuteJs: 'page.executeJs',
    vfsRead: 'vfs.read',
    vfsWrite: 'vfs.write',
    bgFetch: 'bgFetch',
    chrome: 'chrome.cookies',
  };

  it('每个 kind 的代表 token 都能解析回对应 kind 并被分类', () => {
    for (const [kind, raw] of Object.entries(samples)) {
      const perm = parsePermission(raw);
      expect(perm?.kind).toBe(kind);
      expect(['sensitive', 'normal']).toContain(classifyPermission(raw));
    }
  });
});
