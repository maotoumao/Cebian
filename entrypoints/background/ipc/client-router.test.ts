// client-router 的穷尽性守卫：每个 ClientMessage 类型都必须有 handler ——
// 各域 client-handlers 的 map + 路由器自带的 builtinHandlers 合起来必须精确覆盖
// `CLIENT_MESSAGE_TYPES` 全集。新增协议消息而漏注册 handler、或两个域认领同一
// 类型，都会让本文件红。
//
// 注意这里枚举的是各域导出的**源 map**，与 `index.ts` 启动序列注册的是同一批对象；
// 新增一个域的 client-handlers 时要把它的 map 加进 DOMAIN_HANDLER_MAPS。
// 「index.ts 漏调某个 setup」不归本测试管 —— `setupClientRouter()` 启动时校验实际
// 注册表覆盖全集，漏接线在 SW 启动期直接 throw。

import { describe, it, expect } from 'vitest';
import { CLIENT_MESSAGE_TYPES } from '@/lib/ipc/protocol';
import { builtinHandlers, registerClientHandlers, type ClientHandlerMap } from './client-router';
import { chatClientHandlers } from '../chat/client-handlers';
import { recorderClientHandlers } from '../recorder/client-handlers';
import { memoryClientHandlers } from '../memory/client-handlers';
import { mcpClientHandlers } from '../mcp/bridge';

/** 所有注册进路由器的 handler map（与 index.ts 各 setup() 注册的对象一一对应）。 */
const DOMAIN_HANDLER_MAPS: readonly [name: string, map: ClientHandlerMap][] = [
  ['builtin', builtinHandlers],
  ['chat', chatClientHandlers],
  ['recorder', recorderClientHandlers],
  ['memory', memoryClientHandlers],
  ['mcp', mcpClientHandlers],
];

describe('client-router 穷尽性', () => {
  it('各域 handler 合并后精确覆盖 ClientMessage 全集，且无重复认领', () => {
    const owners = new Map<string, string[]>();
    for (const [name, map] of DOMAIN_HANDLER_MAPS) {
      for (const type of Object.keys(map)) {
        owners.set(type, [...(owners.get(type) ?? []), name]);
      }
    }

    for (const type of CLIENT_MESSAGE_TYPES) {
      const claimants = owners.get(type) ?? [];
      expect(claimants.length, `消息类型 "${type}" 没有注册 handler`).toBeGreaterThan(0);
      expect(
        claimants.length,
        `消息类型 "${type}" 被多个域认领：${claimants.join(', ')}`,
      ).toBe(1);
    }

    // 反向：handler map 里没有协议外的类型（satisfies 已在编译期挡住，这里防运行期漂移）。
    const all = new Set<string>(CLIENT_MESSAGE_TYPES);
    for (const type of owners.keys()) {
      expect(all.has(type), `handler 类型 "${type}" 不在 CLIENT_MESSAGE_TYPES 里`).toBe(true);
    }
  });
});

describe('registerClientHandlers', () => {
  it('重复注册同一消息类型时抛错', () => {
    // 注意：注册表是模块级单例，本用例向其写入 'subscribe'。测试进程里没人调各域
    // setup()（穷尽性用例只读源 map，不碰单例），所以这里不会与真实注册冲突。
    registerClientHandlers({ subscribe: () => {} });
    expect(() => registerClientHandlers({ subscribe: () => {} })).toThrow(
      /duplicate handler .* "subscribe"/,
    );
  });
});
