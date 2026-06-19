// 语音识别文本的 AI 修正 —— page 侧入口。
//
// 执行上下文：UX 侧（sidepanel）。这是「修正」概念在页面这一侧的唯一入口，
// hook / 组件只 import 这里的 `correctTranscript`。
//
// ⚠ 第一版为直通实现，仅预留 seam。架构岔路已定：修正是一次性的纯转换
// （送一段文本 → 模型修正 → 返回），与对话 session 无关，因此**不**走有状态的
// agent Port，而走独立的一次性 `chrome.runtime.sendMessage`。
//
// 将来真正实现时（background 侧 `correction-manager.ts` 落地后）：
//   1. 读 storage 里的修正配置（是否启用 / 用哪个模型）——未启用直接原样返回，
//      省一次跨进程往返；
//   2. 启用则 `sendMessage({ type: 'speech_correct', text })`，background 的
//      manager 读模型配置、复用 providers 基建调模型、回传修正结果；
//   3. 任何失败（未配置 / 网络 / 超时）降级为返回原文，绝不让修正阻断输入。
// 这些改动都收敛在本文件内部，hook 仍只认 `correctTranscript`，签名不变。

/** `correctTranscript` 的预留配置位（当前为空，供未来扩展，如 model / signal）。 */
export interface CorrectTranscriptOptions {
  // 预留：未来可加 model / signal / 修正强度等字段。
}

/** 对一段识别文本做 AI 修正。第一版直通（原样返回）。
 *
 *  返回 Promise 是为未来异步修正预留——调用方现在就按异步消费，将来内部
 *  接 IPC 时无需改动调用点。 */
export async function correctTranscript(text: string, _opts?: CorrectTranscriptOptions): Promise<string> {
  return text;
}
