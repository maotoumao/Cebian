import { describe, it, expect } from 'vitest';
import { asString, isValidSessionId } from '@/lib/utils';

describe('asString', () => {
  it('是字符串 → 原样返回（含空串）', () => {
    expect(asString('hi', 'fb')).toBe('hi');
    expect(asString('', 'fb')).toBe('');
  });

  it('非字符串 → 回退到 fallback', () => {
    expect(asString(123, 'fb')).toBe('fb');
    expect(asString(null, 'fb')).toBe('fb');
    expect(asString(undefined, 'fb')).toBe('fb');
    expect(asString({}, 'fb')).toBe('fb');
    expect(asString(['a'], 'fb')).toBe('fb');
    expect(asString(true, 'fb')).toBe('fb');
  });
});

describe('isValidSessionId', () => {
  const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

  it('合法 UUID 形态 → true（大小写均可）', () => {
    expect(isValidSessionId(UUID)).toBe(true);
    expect(isValidSessionId(UUID.toUpperCase())).toBe(true);
  });

  it('非 UUID / 空 / 非字符串 → false', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(`${UUID}/..`)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });
});
