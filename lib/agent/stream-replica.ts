/**
 * 流式副本应用端：把 background 广播的 StreamOp 序列应用到 UI 持有的消息
 * 列表副本上（协议定义见 lib/ipc/protocol.ts 的 StreamOp）。
 *
 * 不可变更新：返回新数组，尾消息之前的元素引用保持稳定（供列表级 memo）。
 * 操作无法应用（尾消息不是 assistant、块下标越界、字段与块类型不符——均意味
 * 着副本已漂移）时返回 null，调用方应重新订阅拉取权威快照兜底；正常情况下
 * 副本也会在每个 message_end / agent_end 的全量 transcript 边界被整体校正。
 */

import { parseStreamingJson } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { BroadcastMessage, StreamOp } from '@/lib/ipc/protocol';

/** 流式中的 toolCall 块带 partialJson 累积字段（pi-ai 的 provider 在运行时
 *  写入、公开类型未声明）。副本自己维护同名字段并据此重算 arguments。 */
type StreamingToolCall = ToolCall & { partialJson?: string };

/** 内容块的宽松结构视图（AgentMessage['content'] 元素的运行时形态）。 */
type ContentBlock = { type: string } & Record<string, unknown>;

/** 应用单个 tail_append。失败（副本漂移）返回 null。 */
function applyAppend(
  messages: BroadcastMessage[],
  op: Extract<StreamOp, { kind: 'tail_append' }>,
): BroadcastMessage[] | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const content = [...(last.content as unknown as ContentBlock[])];
  const block = content[op.blockIndex];
  if (!block) return null;

  switch (op.field) {
    case 'text':
      if (block.type !== 'text' || typeof block.text !== 'string') return null;
      content[op.blockIndex] = { ...block, text: block.text + op.delta };
      break;
    case 'thinking':
      if (block.type !== 'thinking' || typeof block.thinking !== 'string') return null;
      content[op.blockIndex] = { ...block, thinking: block.thinking + op.delta };
      break;
    case 'partialJson': {
      if (block.type !== 'toolCall') return null;
      const toolCall = block as unknown as StreamingToolCall;
      const partialJson = (toolCall.partialJson ?? '') + op.delta;
      // 每个合并窗只解析一次（此前是每个 SSE delta 解析一次整段累积 JSON）
      content[op.blockIndex] = {
        ...block,
        partialJson,
        arguments: parseStreamingJson(partialJson) ?? {},
      };
      break;
    }
  }

  const next = [...messages];
  next[next.length - 1] = { ...last, content } as unknown as BroadcastMessage;
  return next;
}

/** 应用单个 tail_replace：尾消息是 assistant 则替换，否则追加为新尾。 */
function applyReplace(
  messages: BroadcastMessage[],
  op: Extract<StreamOp, { kind: 'tail_replace' }>,
): BroadcastMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last && last.role === 'assistant') {
    next[next.length - 1] = op.message;
  } else {
    next.push(op.message);
  }
  return next;
}

/**
 * 按序应用一帧操作序列。任何一步失败即整帧返回 null（不做部分应用——
 * 部分应用后的副本比过期的副本更难对齐）。
 */
function applyStreamOps(
  messages: BroadcastMessage[],
  ops: StreamOp[],
): BroadcastMessage[] | null {
  let current = messages;
  for (const op of ops) {
    const next = op.kind === 'tail_replace' ? applyReplace(current, op) : applyAppend(current, op);
    if (next === null) return null;
    current = next;
  }
  return current;
}

export { applyStreamOps };
