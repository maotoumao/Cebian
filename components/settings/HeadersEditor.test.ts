import { describe, it, expect } from 'vitest';
import { headerRowsToRecord, recordToHeaderRows } from '@/components/settings/HeadersEditor';

describe('headerRowsToRecord', () => {
  it('空行数组 → undefined', () => {
    expect(headerRowsToRecord([])).toBeUndefined();
  });

  it('全是空 key 行 → undefined', () => {
    expect(headerRowsToRecord([{ key: '  ', value: 'x' }])).toBeUndefined();
  });

  it('聚合成 Record，key 去空格（Headers 归一化为小写）', () => {
    expect(headerRowsToRecord([{ key: ' X-A ', value: '1' }, { key: 'X-B', value: '2' }]))
      .toEqual({ 'x-a': '1', 'x-b': '2' });
  });

  it('非法 header 名（含空格）跳过，不中断其余行', () => {
    expect(headerRowsToRecord([{ key: 'X Bad', value: 'v' }, { key: 'X-Good', value: '1' }]))
      .toEqual({ 'x-good': '1' });
  });

  it('同名 key 大小写不敏感、后写覆盖', () => {
    expect(headerRowsToRecord([{ key: 'X-A', value: '1' }, { key: 'x-a', value: '2' }]))
      .toEqual({ 'x-a': '2' });
  });
});

describe('recordToHeaderRows', () => {
  it('undefined → 空数组', () => {
    expect(recordToHeaderRows(undefined)).toEqual([]);
  });

  it('Record → 行数组', () => {
    expect(recordToHeaderRows({ 'X-A': '1', 'X-B': '2' }))
      .toEqual([{ key: 'X-A', value: '1' }, { key: 'X-B', value: '2' }]);
  });
});
