import { describe, expect, it } from 'vitest';
import { jsonShape, summarizeNetworkEntry } from './network-summary';
import type { NetworkEntry } from './network-types';

describe('jsonShape', () => {
  it('给出字段名与类型，数组只看首个元素', () => {
    expect(jsonShape('{"id":1,"items":[{"name":"a","price":2}],"next":null,"ok":true}'))
      .toBe('{id:number,items:[{name:string,price:number}],next:null,ok:boolean}');
  });

  it('深度与字段数有上限，整体超长截断', () => {
    expect(jsonShape('{"a":{"b":{"c":{"d":{"e":1}}}}}')).toBe('{a:{b:{c:{d:{…}}}}}');
    expect(jsonShape('[[[[[1]]]]]')).toBe('[[[[[…]]]]]');
    const wide = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    expect(jsonShape(JSON.stringify(wide))).toMatch(/,…\}$/);
    const long = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a_rather_long_field_name_${i}`, 'x']));
    expect(jsonShape(JSON.stringify(long))!.endsWith('…')).toBe(true);
  });

  it('带防劫持前缀的 JSON 去掉前缀再给概要', () => {
    expect(jsonShape(`)]}'\n{"id":1}`)).toBe('{id:number}');
  });

  it('不是 JSON 时没有概要', () => {
    expect(jsonShape('<html>')).toBeUndefined();
    expect(jsonShape('{broken')).toBeUndefined();
    expect(jsonShape(undefined)).toBeUndefined();
  });
});

describe('summarizeNetworkEntry', () => {
  const base: NetworkEntry = {
    id: 'n1',
    t: 10,
    tabId: 1,
    type: 'fetch',
    method: 'POST',
    url: 'https://api.test/search',
    requestHeaders: [],
    requestBody: { text: '{"q":"  hello\n world  "}' },
    status: 200,
    responseBody: { text: JSON.stringify({ results: [{ title: 'x'.repeat(400) }] }) },
    durationMs: 80,
  };

  it('请求 / 响应预览压缩空白并截断，附 JSON 结构概要', () => {
    const summary = summarizeNetworkEntry(base);
    expect(summary).toMatchObject({ kind: 'network', id: 'n1', t: 10, method: 'POST', status: 200, ms: 80 });
    expect(summary.req).toBe('{"q":" hello world "}');
    expect(summary.res!.length).toBe(301);
    expect(summary.res!.endsWith('…')).toBe(true);
    expect(summary.shape).toBe('{results:[{title:string}]}');
  });

  it('给出重定向次数与请求体省略原因', () => {
    const summary = summarizeNetworkEntry({
      ...base,
      redirects: [{ url: 'https://api.test/a', status: 302 }],
      requestBody: { omitted: 'too_large', size: 900_000 },
    });
    expect(summary.redirects).toBe(1);
    expect(summary.req).toBeUndefined();
    expect(summary.reqOmitted).toBe('too_large');
    expect(summarizeNetworkEntry(base).redirects).toBeUndefined();
  });

  it('响应体未录到时给出原因，流式连接给出消息条数', () => {
    const summary = summarizeNetworkEntry({
      ...base,
      type: 'websocket',
      requestBody: undefined,
      responseBody: { omitted: 'unavailable' },
      messages: [{ direction: 'received', t: 20, data: 'hi' }],
    });
    expect(summary.res).toBeUndefined();
    expect(summary.resOmitted).toBe('unavailable');
    expect(summary.messages).toBe(1);
  });
});
