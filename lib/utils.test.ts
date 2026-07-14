import { describe, it, expect } from 'vitest';
import { asString, isValidSessionId, assertNever, formatCompactCount, formatBytes } from '@/lib/utils';

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

describe('assertNever', () => {
  it('运行期被调用 → 抛错并带上越界值', () => {
    // 绕过类型检查模拟外部传入的越界数据。
    expect(() => assertNever('oops' as never)).toThrow('Unexpected value: oops');
  });
});

describe('formatCompactCount', () => {
  it('< 1000 → 原样整数', () => {
    expect(formatCompactCount(0)).toBe('0');
    expect(formatCompactCount(999)).toBe('999');
  });

  it('K / M 分档，丢掉末尾 .0', () => {
    expect(formatCompactCount(1000)).toBe('1K');
    expect(formatCompactCount(1200)).toBe('1.2K');
    expect(formatCompactCount(200000)).toBe('200K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatCompactCount(1_500_000)).toBe('1.5M');
  });

  it('负数夹到 0、小数先向下取整', () => {
    expect(formatCompactCount(-5)).toBe('0');
    expect(formatCompactCount(1499.9)).toBe('1.5K');
  });
});

describe('formatBytes', () => {
  it('按二进制单位分档，保留一位小数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30.0 MB');
  });
});
