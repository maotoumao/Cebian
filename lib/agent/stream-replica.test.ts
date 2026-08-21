import { describe, expect, it } from 'vitest';
import { applyStreamOps } from '@/lib/agent/stream-replica';
import type { BroadcastMessage, StreamOp } from '@/lib/ipc/protocol';

/** 造一条最简 assistant 消息（只填测试关心的字段）。 */
function assistantMsg(content: unknown[]): BroadcastMessage {
  return { role: 'assistant', content, timestamp: 0 } as unknown as BroadcastMessage;
}

function userMsg(text: string): BroadcastMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } as BroadcastMessage;
}

function tailText(messages: BroadcastMessage[]): string {
  const last = messages[messages.length - 1] as { content: { type: string; text?: string }[] };
  return last.content.find((b) => b.type === 'text')?.text ?? '';
}

describe('applyStreamOps', () => {
  it('text 增量按序追加，且尾消息之前的元素引用稳定', () => {
    const base = [userMsg('问'), assistantMsg([{ type: 'text', text: 'AB' }])];
    const next = applyStreamOps(base, [
      { kind: 'tail_append', blockIndex: 0, field: 'text', delta: 'CD' },
      { kind: 'tail_append', blockIndex: 0, field: 'text', delta: 'EF' },
    ]);
    expect(next).not.toBeNull();
    expect(tailText(next!)).toBe('ABCDEF');
    expect(next![0]).toBe(base[0]); // 前缀引用稳定
    expect(base[1]).not.toBe(next![1]); // 输入未被原地修改
    expect(tailText(base)).toBe('AB');
  });

  it('thinking 增量追加到 thinking 字段', () => {
    const base = [assistantMsg([{ type: 'thinking', thinking: '思' }])];
    const next = applyStreamOps(base, [
      { kind: 'tail_append', blockIndex: 0, field: 'thinking', delta: '考中' },
    ]);
    const block = (next![0] as { content: { thinking: string }[] }).content[0];
    expect(block.thinking).toBe('思考中');
  });

  it('partialJson 增量追加并重算 arguments', () => {
    const base = [
      assistantMsg([{ type: 'toolCall', id: 't1', name: 'write', arguments: {} }]),
    ];
    const half = applyStreamOps(base, [
      { kind: 'tail_append', blockIndex: 0, field: 'partialJson', delta: '{"path":"a.' },
    ]);
    const full = applyStreamOps(half!, [
      { kind: 'tail_append', blockIndex: 0, field: 'partialJson', delta: 'txt","n":1}' },
    ]);
    const block = (full![0] as unknown as { content: { arguments: unknown; partialJson: string }[] })
      .content[0];
    expect(block.partialJson).toBe('{"path":"a.txt","n":1}');
    expect(block.arguments).toEqual({ path: 'a.txt', n: 1 });
  });

  it('tail_replace：尾是 assistant 则替换，否则追加', () => {
    const replaced = applyStreamOps(
      [userMsg('问'), assistantMsg([{ type: 'text', text: '旧' }])],
      [{ kind: 'tail_replace', message: assistantMsg([{ type: 'text', text: '新' }]) }],
    );
    expect(replaced).toHaveLength(2);
    expect(tailText(replaced!)).toBe('新');

    const appended = applyStreamOps(
      [userMsg('问')],
      [{ kind: 'tail_replace', message: assistantMsg([{ type: 'text', text: '首帧' }]) }],
    );
    expect(appended).toHaveLength(2);
    expect(tailText(appended!)).toBe('首帧');
  });

  describe('副本漂移 → 整帧返回 null', () => {
    const append: StreamOp = { kind: 'tail_append', blockIndex: 0, field: 'text', delta: 'x' };

    it('尾消息不是 assistant', () => {
      expect(applyStreamOps([userMsg('问')], [append])).toBeNull();
      expect(applyStreamOps([], [append])).toBeNull();
    });

    it('块下标越界', () => {
      const base = [assistantMsg([{ type: 'text', text: '' }])];
      expect(
        applyStreamOps(base, [{ kind: 'tail_append', blockIndex: 3, field: 'text', delta: 'x' }]),
      ).toBeNull();
    });

    it('字段与块类型不符', () => {
      const base = [assistantMsg([{ type: 'text', text: '' }])];
      expect(
        applyStreamOps(base, [
          { kind: 'tail_append', blockIndex: 0, field: 'thinking', delta: 'x' },
        ]),
      ).toBeNull();
    });

    it('任何一步失败即整帧丢弃（不做部分应用）', () => {
      const base = [assistantMsg([{ type: 'text', text: 'A' }])];
      const result = applyStreamOps(base, [
        { kind: 'tail_append', blockIndex: 0, field: 'text', delta: 'B' },
        { kind: 'tail_append', blockIndex: 9, field: 'text', delta: 'C' },
      ]);
      expect(result).toBeNull();
      expect(tailText(base)).toBe('A'); // 原副本未被污染
    });
  });

  /**
   * 性质测试：按协议契约（结构事件发 tail_replace 快照、delta 事件发
   * tail_append）把一条最终消息的生成过程随机切分成增量与合并帧，副本
   * 最终必须与完整消息一致。真实生产端（含缓冲合并、累计参数注入）的
   * 端到端契约测试在 entrypoints/background/chat/stream-broadcast.test.ts。
   */
  it('性质：随机切分的事件流回放后，副本恒等于最终消息', () => {
    // 简单 LCG，保证测试可复现
    let seed = 20260822;
    const rand = (max: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };

    const finalThinking = '让我想想这个问题的关键点在哪里。';
    const finalText = '结论是：先分块，再增量。'.repeat(8);
    const finalJson = '{"path":"notes/结论.md","content":"分块与增量","overwrite":true}';

    for (let round = 0; round < 20; round++) {
      // 把一段字符串随机切成 1~n 个 delta
      const split = (s: string): string[] => {
        const parts: string[] = [];
        let i = 0;
        while (i < s.length) {
          const len = 1 + rand(7);
          parts.push(s.slice(i, i + len));
          i += len;
        }
        return parts;
      };

      // 生产端契约模拟：结构事件 → tail_replace（携带当时的 partial 快照）；
      // delta → tail_append
      const ops: StreamOp[] = [];
      const partial: { type: string; [k: string]: unknown }[] = [];
      const snapshot = () =>
        ops.push({
          kind: 'tail_replace',
          message: assistantMsg(structuredClone(partial)),
        });

      partial.push({ type: 'thinking', thinking: '' });
      snapshot(); // thinking_start
      for (const d of split(finalThinking)) {
        ops.push({ kind: 'tail_append', blockIndex: 0, field: 'thinking', delta: d });
        (partial[0] as unknown as { thinking: string }).thinking += d;
      }
      snapshot(); // thinking_end
      partial.push({ type: 'text', text: '' });
      snapshot(); // text_start
      for (const d of split(finalText)) {
        ops.push({ kind: 'tail_append', blockIndex: 1, field: 'text', delta: d });
        (partial[1] as unknown as { text: string }).text += d;
      }
      snapshot(); // text_end
      partial.push({ type: 'toolCall', id: 't1', name: 'write', arguments: {} });
      snapshot(); // toolcall_start
      for (const d of split(finalJson)) {
        ops.push({ kind: 'tail_append', blockIndex: 2, field: 'partialJson', delta: d });
      }

      // 随机分帧应用（模拟合并窗）
      let replica: BroadcastMessage[] = [userMsg('问')];
      let i = 0;
      while (i < ops.length) {
        const frame = ops.slice(i, i + 1 + rand(5));
        i += frame.length;
        const next = applyStreamOps(replica, frame);
        expect(next).not.toBeNull();
        replica = next!;
      }

      const tail = replica[replica.length - 1] as {
        content: { type: string; thinking?: string; text?: string; arguments?: unknown }[];
      };
      expect(tail.content[0].thinking).toBe(finalThinking);
      expect(tail.content[1].text).toBe(finalText);
      expect(tail.content[2].arguments).toEqual(JSON.parse(finalJson));
    }
  });
});
