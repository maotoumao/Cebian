// UI 端口消息的注册制路由：`ClientMessage['type']` → handler 的一张查表。
//
// 与 `port-registry.ts` 同属 ipc/（纯传输 + 分发），**不得 import 任何能力目录**
// （chat / recorder / memory / mcp）—— 依赖方向是「能力 → ipc/」单向：各能力目录的
// `client-handlers.ts` 导出自己的 handler map，由 `index.ts` 在启动序列里调各域
// `setup()` 注册进来。路由器只回答「这条消息交给谁」，不认识任何业务。
//
// 时序约束：所有注册必须**同步**完成，且发生在 `setupPortRegistry()` 受理连接之前 ——
// SW 被端口连接唤醒后首条消息到得很快，异步注册会留下查表未命中的窗口，
// 穷尽性测试测不出这种时序洞。
//
// 穷尽性由 `client-router.test.ts` 守卫：每个 `CLIENT_MESSAGE_TYPES` 成员都必须有
// handler，漏注册则 CI 红。

import { CLIENT_MESSAGE_TYPES, type ClientMessage } from '@/lib/ipc/protocol';
import { getPortState, onPortConnect, post, setInstanceId } from './port-registry';

/** 每个消息类型对应的处理函数。映射类型让各域注册时天然拿到窄化后的 msg 形状。 */
type ClientHandlerMap = {
  [T in ClientMessage['type']]?: (
    port: chrome.runtime.Port,
    msg: Extract<ClientMessage, { type: T }>,
  ) => void | Promise<void>;
};

/** 已注册的查表。模块级状态，生命周期 = service worker 生命周期。
 *  null 原型：`msg.type` 来自 wire（类型标注是假设不是保证），普通对象字面量会让
 *  `type: 'constructor'` 之类的载荷沿原型链查到继承函数并被当 handler 调用。 */
const handlers: ClientHandlerMap = Object.create(null);

/**
 * 路由器自带的传输层 handler。`hello` 是连接握手（记录对端 UI 实例 id），
 * 属传输概念而非任何能力域，与 `setInstanceId` 同层，故住在这里。
 * 单独成表（而非在 setup 里内联）是为了让穷尽性测试能把它计入「已注册」。
 */
const builtinHandlers: ClientHandlerMap = {
  hello(port, msg) {
    setInstanceId(port, msg.instanceId);
  },
};

/**
 * 合并一批 handler 进查表。同一消息类型注册两次说明两个域认领了同一条消息 ——
 * 这是启动期就该炸掉的接线错误，不留运行期歧义。
 */
function registerClientHandlers(map: ClientHandlerMap): void {
  for (const key of Object.keys(map)) {
    if (key in handlers) {
      throw new Error(`client-router: duplicate handler for message type "${key}"`);
    }
  }
  Object.assign(handlers, map);
}

/**
 * 注册自带 handler、校验注册表完整，然后开始分发。每个新端口挂一个 onMessage 监听：
 * 查表命中则分发，未命中 = 协议外消息，静默忽略（与拆分前大 switch 的 default 行为一致）。
 *
 * 在 `index.ts` 启动序列里、**所有能力域 setup 之后、`setupPortRegistry()` 之前**调用 ——
 * 此时注册表应已覆盖 `CLIENT_MESSAGE_TYPES` 全集，缺项说明 `index.ts` 漏调了某个域的
 * setup（或某个 setup 注册了错误的 map），启动期就炸，不让漏接线静默进生产。
 * 穷尽性测试只能证明「各域源 map 合起来完整」，这道断言补上「生产真的都注册了」。
 */
function setupClientRouter(): void {
  registerClientHandlers(builtinHandlers);

  const missing = CLIENT_MESSAGE_TYPES.filter((type) => !(type in handlers));
  if (missing.length > 0) {
    throw new Error(
      `client-router: no handler registered for message types: ${missing.join(', ')} ` +
        '(did index.ts forget a domain setup?)',
    );
  }

  onPortConnect((port) => {
    port.onMessage.addListener(async (msg: ClientMessage) => {
      // 传输层守卫：端口已出表（断连竞态）的消息不处理，避免 handler 为死端口
      // 建立业务状态（如 viewer 表项）造成泄漏。
      if (!getPortState(port)) return;
      const handler = handlers[msg.type];
      if (!handler) return;
      try {
        // 查表取出后 TS 无法再把 handler 的参数类型与 msg 的判别关联起来
        // （相关性在索引访问处丢失），此处收窄成一个局部 cast。
        await (handler as (p: chrome.runtime.Port, m: ClientMessage) => void | Promise<void>)(
          port,
          msg,
        );
      } catch (err) {
        const sessionId = 'sessionId' in msg ? msg.sessionId : null;
        post(port, {
          type: 'error',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

// ─── 公开 API ───

export { registerClientHandlers, setupClientRouter, builtinHandlers };
export type { ClientHandlerMap };
