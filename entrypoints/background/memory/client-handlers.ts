// memory 域的客户端消息 handler：手动触发跨对话记忆整理 + 运行态查询。
// 整理是全局单飞行的后台长任务，运行态经 `memory_organize_state` 广播给所有连接
// （设置页可能在任意窗口打开），结果详情走 memoryOrganizeState 存储供 UI 响应式读取。

import { runOrganize, isOrganizing } from './organize-manager';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { post, broadcastAll } from '../ipc/port-registry';

const memoryClientHandlers: ClientHandlerMap = {
  memory_organize_query(port) {
    // 仅回发起端口当前运行态（不带 outcome → UI 不会误弹 toast）。
    post(port, { type: 'memory_organize_state', running: isOrganizing() });
  },

  memory_organize() {
    // 全局、单飞行。已在跑 → 只重播 running:true 同步迟到的 UI，不重入、不误广播 idle。
    if (isOrganizing()) {
      broadcastAll({ type: 'memory_organize_state', running: true });
      return;
    }
    broadcastAll({ type: 'memory_organize_state', running: true });
    // 不 await：整理是后台长任务，立即返回让消息循环继续（结果详情走 memoryOrganizeState）。
    runOrganize()
      .then((res) =>
        broadcastAll({
          type: 'memory_organize_state',
          running: false,
          outcome: res.status === 'ok' ? 'ok' : res.reason === 'already-running' ? undefined : res.reason,
        }),
      )
      .catch((err) => {
        console.error('[organize] run failed:', err);
        broadcastAll({
          type: 'memory_organize_state',
          running: false,
          outcome: 'failed',
          error: err?.message ?? String(err),
        });
      });
  },
};

/** 注册 memory 域 handler。在 `index.ts` 启动序列里、`setupPortRegistry()` 之前同步调用。 */
function setupMemoryClientHandlers(): void {
  registerClientHandlers(memoryClientHandlers);
}

// ─── 公开 API ───

export { setupMemoryClientHandlers, memoryClientHandlers };
