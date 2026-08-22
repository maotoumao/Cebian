// 划词动作的输出后处理脚本执行器（background 侧）。
//
// 与 skill 共用 sandbox.html 这份「能跑 new Function 的页面」，但**不共用实例**：每次执行
// 由 offscreen 新建一个 iframe、跑完或超时立即销毁（执行契约与校验都在
// entrypoints/offscreen/transform-sandbox.ts，这边只负责把脚本递过去、把结果拿回来）。
// 刻意不复用 skill 那个长存的共享沙箱——同一 realm 里脚本能窥探后续 skill 的执行信封
// 并借其权限行事。
//
// 契约：用户脚本定义一个完整的 `transform(text, vars)` 函数，由宿主按名字查到并调用
// （见 transform-sandbox.ts 的 wrapHookCall）。`vars` 是环境变量那一套，与提示词模板同源，
// 不含任何设置项。
//
// 脚本零权限：沙箱不注入 chrome / vfs / bgFetch / executeInPage，它只拿到字符串 text 与
// 字符串映射 vars；沙箱侧只接受直接宿主发来的协议消息，故它也注入不了别的沙箱实例。
// 局限（如实记录）：(1) sandbox page 的 CSP 是全局共享的，故脚本仍能访问原生 fetch——
// 隔离解决的是越权，不解决出网，所以设置页提示只跑信得过的脚本；(2) 宿主是 offscreen
// 文档，而 offscreen 是 Chrome MV3 的 API——Firefox 上拿不到它，后处理会失败并降级显示
// 原始输出。这与 read-page / run_skill 等既有能力同一条件。
//
// 也刻意不走页面内 MAIN world 执行：那会被站点 CSP 拦，还把用户脚本塞进宿主页面。

import { ensureOffscreen } from '@/lib/tools/offscreen';
import type { OffscreenRequest } from '@/entrypoints/offscreen/main';

/**
 * background 侧的独立超时，比宿主那道（5s）留一点余量。
 *
 * 不能只依赖宿主的定时器：死循环脚本若与 offscreen 文档同线程，会把那边的定时器一起
 * 卡住，`sendMessage` 便永不回音（只有接收方进程死掉才会 reject）。没有这道闸，流式
 * 已经跑完的动作会卡在「思考中」永远出不来。有了它，最坏情况退化成「显示原始输出 +
 * 后处理失败提示」。
 */
const TRANSFORM_DEADLINE_MS = 8_000;

/**
 * 跑一段后处理脚本，返回要展示的文本。
 *
 * 失败即抛（超时、没定义 transform、脚本自身抛错、返回值不是字符串）——后处理是可选的，
 * 故调用方捕获后照常展示原始输出，只把错误消息带到卡片上供用户排查。
 * 脚本返回非字符串一律视为错误而不是强转：`[object Object]` 冒充模型输出比报错更糟。
 */
export async function runTransform(
  script: string,
  text: string,
  vars: Record<string, string>,
): Promise<string> {
  await ensureOffscreen();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Transform script timed out after ${TRANSFORM_DEADLINE_MS} ms`)),
      TRANSFORM_DEADLINE_MS,
    );
  });

  // 显式标注消息体类型：字段名与宿主对不上会在编译期报错（这里曾把 script 发成宿主
  // 读不到的名字，导致脚本被静默丢掉、每次都报「没定义 transform」）。
  const request: OffscreenRequest = {
    type: 'transform:run',
    script,
    hook: 'transform',
    args: { text, vars },
  };

  try {
    const response: unknown = await Promise.race([
      chrome.runtime.sendMessage(request),
      deadline,
    ]);
    const out = response as { result?: string; error?: string } | undefined;
    if (!out) throw new Error('Transform script produced no response');
    if (typeof out.error === 'string') throw new Error(out.error);
    if (typeof out.result !== 'string') {
      throw new Error('Transform script must return a string');
    }
    return out.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
