import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PAGE_ACTION_IDS,
  isBuiltinPageActionId,
  isPageActionId,
  newCustomPageActionId,
  isPageActionRequest,
  isPageActionStreamMessage,
} from '@/lib/page-actions/types';

describe('isPageActionId — 内容脚本 → background 的 id 格式白名单', () => {
  it('内置 id 通过', () => {
    for (const id of BUILTIN_PAGE_ACTION_IDS) {
      expect(isPageActionId(id)).toBe(true);
    }
  });

  it('自身生成的自定义 id 通过（生成器与校验器同一约定）', () => {
    expect(isPageActionId(newCustomPageActionId())).toBe(true);
  });

  it('原型键不通过——否则会绕过注册表「查得到定义」那道防线', () => {
    expect(isPageActionId('__proto__')).toBe(false);
    expect(isPageActionId('constructor')).toBe(false);
    expect(isPageActionId('toString')).toBe(false);
    expect(isPageActionId('prototype')).toBe(false);
  });

  it('其它形态的未知 id 不通过', () => {
    expect(isPageActionId('')).toBe(false);
    expect(isPageActionId('explain evil')).toBe(false);
    expect(isPageActionId('custom-')).toBe(false);
    expect(isPageActionId('custom-XYZ')).toBe(false); // 只认小写 hex
    expect(isPageActionId('custom-abc')).toBe(false); // 太短
    expect(isPageActionId('../../etc/passwd')).toBe(false);
    expect(isPageActionId(42)).toBe(false);
    expect(isPageActionId(null)).toBe(false);
    expect(isPageActionId(undefined)).toBe(false);
  });
});

describe('isBuiltinPageActionId', () => {
  it('只认内置三个 id', () => {
    expect(isBuiltinPageActionId('explain')).toBe(true);
    expect(isBuiltinPageActionId('translate')).toBe(true);
    expect(isBuiltinPageActionId('summarize')).toBe(true);
    expect(isBuiltinPageActionId('custom-abcdef12')).toBe(false);
    expect(isBuiltinPageActionId('__proto__')).toBe(false);
    expect(isBuiltinPageActionId(null)).toBe(false);
  });
});

describe('newCustomPageActionId', () => {
  it('形如 custom-<hex>，且两次生成不同', () => {
    const a = newCustomPageActionId();
    const b = newCustomPageActionId();
    expect(a).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('isPageActionRequest', () => {
  it('合法请求通过', () => {
    expect(isPageActionRequest({ actionId: 'explain', text: 'hi', params: {} })).toBe(true);
  });

  it('id 非法 / 字段缺失 → 拒绝', () => {
    expect(isPageActionRequest({ actionId: '__proto__', text: 'hi', params: {} })).toBe(false);
    expect(isPageActionRequest({ actionId: 'explain', text: 'hi' })).toBe(false);
    expect(isPageActionRequest({ actionId: 'explain', params: {} })).toBe(false);
    expect(isPageActionRequest(null)).toBe(false);
  });
});

describe('isPageActionStreamMessage — done 的 transform 结局互斥', () => {
  it('三种合法结局都通过', () => {
    expect(isPageActionStreamMessage({ type: 'done' })).toBe(true);
    expect(isPageActionStreamMessage({ type: 'done', transformed: 'X' })).toBe(true);
    expect(isPageActionStreamMessage({ type: 'done', transformError: 'boom' })).toBe(true);
  });

  it('两个字段同时出现 → 拒绝（不把歧义放进展示层）', () => {
    expect(
      isPageActionStreamMessage({ type: 'done', transformed: 'X', transformError: 'boom' }),
    ).toBe(false);
  });

  it('字段类型不对 → 拒绝', () => {
    expect(isPageActionStreamMessage({ type: 'done', transformed: 1 })).toBe(false);
    expect(isPageActionStreamMessage({ type: 'chunk' })).toBe(false);
    expect(isPageActionStreamMessage({ type: 'nope' })).toBe(false);
  });
});
