import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, StreamOp } from '@/lib/ipc/protocol';
import type { BroadcastMessage } from '@/lib/ipc/protocol';
import { applyStreamOps } from '@/lib/agent/stream-replica';

// 拦截广播出口，收集真实生产端发出的帧
const frames: { sessionId: string; ops: StreamOp[] }[] = [];
vi.mock('./viewers', () => ({
  broadcastToViewers: (sessionId: string, msg: ServerMessage) => {
    if (msg.type === 'stream_ops') frames.push({ sessionId, ops: msg.ops });
  },
}));

const { queueStreamEvent, flushStreamOps, snapshotStreamingTail, dropStreamBroadcast } =
  await import('./stream-broadcast');

/** 用收集到的帧驱动真实应用端，得到 UI 副本。 */
function replay(base: BroadcastMessage[], from = 0): BroadcastMessage[] {
  let replica = base;
  for (const frame of frames.slice(from)) {
    const next = applyStreamOps(replica, frame.ops);
    expect(next).not.toBeNull();
    replica = next!;
  }
  return replica;
}

function tail(replica: BroadcastMessage[]) {
  return replica[replica.length - 1] as unknown as {
    content: { type: string; text?: string; thinking?: string; arguments?: unknown }[];
  };
}

const S = 'session-1';

describe('stream-broadcast 生产端 → stream-replica 应用端（端到端契约）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    frames.length = 0;
  });
  afterEach(() => {
    dropStreamBroadcast(S);
    vi.useRealTimers();
  });

  /** 模拟 pi 生产侧：partial 是同一个可变对象（provider 边流边改）。 */
  function makePartial() {
    return { role: 'assistant', content: [] as Record<string, unknown>[], timestamp: 0 };
  }

  it('text 流：leading 立即发，窗口内合并，回放结果与最终文本一致', () => {
    const partial = makePartial();
    partial.content.push({ type: 'text', text: '' });
    queueStreamEvent(S, { type: 'text_start', contentIndex: 0, partial } as never);
    expect(frames).toHaveLength(1); // leading 帧

    const pieces = ['流式', '输出', '的', '增量', '合并'];
    for (const p of pieces) {
      partial.content[0].text += p; // provider 原地累积
      queueStreamEvent(S, { type: 'text_delta', contentIndex: 0, delta: p, partial } as never);
    }
    expect(frames).toHaveLength(1); // 窗口未到期，全部还在缓冲
    vi.advanceTimersByTime(80);
    expect(frames).toHaveLength(2); // trailing 帧
    // 同块相邻 delta 已在缓冲里拼接成单个 op
    expect(frames[1].ops).toEqual([
      { kind: 'tail_append', blockIndex: 0, field: 'text', delta: pieces.join('') },
    ]);

    const replica = replay([]);
    expect(tail(replica).content[0].text).toBe(pieces.join(''));
  });

  it('结构帧吞掉缓冲增量，且快照被 structuredClone 定格（不随 partial 后续变化）', () => {
    const partial = makePartial();
    partial.content.push({ type: 'text', text: '' });
    queueStreamEvent(S, { type: 'text_start', contentIndex: 0, partial } as never);
    partial.content[0].text = 'AB';
    queueStreamEvent(S, { type: 'text_delta', contentIndex: 0, delta: 'AB', partial } as never);
    // 结构事件：text_end —— 缓冲里的 append 应被快照吞掉
    queueStreamEvent(S, { type: 'text_end', contentIndex: 0, content: 'AB', partial } as never);
    // 快照定格后 provider 继续改 partial
    partial.content.push({ type: 'text', text: '不应出现' });
    vi.advanceTimersByTime(80);

    const last = frames[frames.length - 1];
    expect(last.ops).toHaveLength(1);
    expect(last.ops[0].kind).toBe('tail_replace');
    const snap = (last.ops[0] as { message: { content: unknown[] } }).message;
    expect(snap.content).toHaveLength(1); // 未被后续 mutation 污染

    const replica = replay([]);
    expect(tail(replica).content[0].text).toBe('AB');
  });

  it('工具参数：provider 无关（partialArgs 风格的 partial 也能续写）+ 跨工具交错', () => {
    const partial = makePartial();
    const jsonA = '{"x":1}';
    const jsonB = '{"y":"z"}';

    // 模拟 openai-completions 风格：累计串放在 partialArgs，块上没有 partialJson
    partial.content.push({ type: 'toolCall', id: 'a', name: 'ta', arguments: {}, partialArgs: '' });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial } as never);
    partial.content[0].partialArgs = jsonA.slice(0, 4);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: jsonA.slice(0, 4), partial } as never);

    // 工具 B 开始（结构帧覆盖缓冲），A 的续写基底必须存活在注入的 partialJson 里
    partial.content.push({ type: 'toolCall', id: 'b', name: 'tb', arguments: {}, partialArgs: '' });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 1, partial } as never);

    // A、B 交错续流
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: jsonA.slice(4), partial } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 1, delta: jsonB, partial } as never);
    vi.advanceTimersByTime(80);

    const replica = replay([]);
    expect(tail(replica).content[0].arguments).toEqual({ x: 1 });
    expect(tail(replica).content[1].arguments).toEqual({ y: 'z' });
  });

  it('mid-stream subscribe：flush → 快照（snapshotStreamingTail 注入基底）→ 后续 delta 续写正确', () => {
    const partial = makePartial();
    const json = '{"path":"a.txt"}';
    partial.content.push({ type: 'toolCall', id: 'a', name: 'w', arguments: {}, partialArgs: '' });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: json.slice(0, 9), partial } as never);

    // 订阅路径：先 flush 缓冲，再取快照（快照来自 pi 的 partial，经注入出口）
    flushStreamOps(S);
    const framesBeforeSnapshot = frames.length;
    const snapshotTail = snapshotStreamingTail(S, structuredClone(partial) as never);
    // 新 viewer 以快照为基底
    let replica: BroadcastMessage[] = [snapshotTail as unknown as BroadcastMessage];

    // 快照之后的增量帧
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: json.slice(9), partial } as never);
    vi.advanceTimersByTime(80);

    replica = replay(replica, framesBeforeSnapshot);
    expect(tail(replica).content[0].arguments).toEqual({ path: 'a.txt' });
  });

  it('消息边界（drop）后累计基底清零——生产路径的清理保证', () => {
    const partial = makePartial();
    partial.content.push({ type: 'toolCall', id: 'a', name: 'w', arguments: {} });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: '{"x":1}', partial } as never);

    // 生产路径：message_end 处理里先 dropStreamBroadcast 再广播全量 transcript
    dropStreamBroadcast(S);
    frames.length = 0;

    // 下一条消息
    const partial2 = makePartial();
    partial2.content.push({ type: 'toolCall', id: 'b', name: 'w', arguments: {} });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial: partial2 } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: '{"y":2}', partial: partial2 } as never);
    vi.advanceTimersByTime(80);

    const replica = replay([]);
    // 若基底未清零，y 的参数会被旧 JSON 污染解析失败
    expect(tail(replica).content[0].arguments).toEqual({ y: 2 });
  });

  it('start 事件防御性清零累计基底（当前桥接层不转发 start，见生产端注释）', () => {
    const partial = makePartial();
    partial.content.push({ type: 'toolCall', id: 'a', name: 'w', arguments: {} });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: '{"x":1}', partial } as never);

    const partial2 = makePartial();
    queueStreamEvent(S, { type: 'start', partial: partial2 } as never);
    partial2.content.push({ type: 'toolCall', id: 'b', name: 'w', arguments: {} });
    queueStreamEvent(S, { type: 'toolcall_start', contentIndex: 0, partial: partial2 } as never);
    queueStreamEvent(S, { type: 'toolcall_delta', contentIndex: 0, delta: '{"y":2}', partial: partial2 } as never);
    vi.advanceTimersByTime(80);

    const replica = replay([]);
    expect(tail(replica).content[0].arguments).toEqual({ y: 2 });
  });

  it('done / error 为联合类型完备性兜底成快照帧（当前桥接层不转发，见生产端注释）', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: '完' }], timestamp: 0 };
    queueStreamEvent(S, { type: 'done', reason: 'stop', message: msg } as never);
    expect(frames[0].ops[0].kind).toBe('tail_replace');
    dropStreamBroadcast(S);
    frames.length = 0;
    queueStreamEvent(S, { type: 'error', reason: 'aborted', error: msg } as never);
    expect(frames[0].ops[0].kind).toBe('tail_replace');
  });

  it('drop 后不再有 trailing 帧', () => {
    const partial = makePartial();
    partial.content.push({ type: 'text', text: '' });
    queueStreamEvent(S, { type: 'text_start', contentIndex: 0, partial } as never);
    queueStreamEvent(S, { type: 'text_delta', contentIndex: 0, delta: 'X', partial } as never);
    const before = frames.length;
    dropStreamBroadcast(S);
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(before);
  });
});
