import { describe, expect, it } from 'vitest';
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { buildBranchInfo } from './session-projection';

function msg(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as unknown as AgentMessage;
}

function entry(id: string, seq: number, parentId: string | null): Entry {
  return { type: 'message', id, seq, parentId, timestamp: 1, message: msg(id) };
}

describe('buildBranchInfo', () => {
  it('分支点：同 parent 的可投影兄弟 ≥2 时记录 index/count/siblings（seq 序），无分支的 entry 不出现（稀疏）', () => {
    // root ─┬─ a1（旧分支）
    //       └─ a2（当前分支）── b
    const all: Entry[] = [
      entry('root', 1, null),
      entry('a1', 2, 'root'),
      entry('a2', 3, 'root'),
      entry('b', 4, 'a2'),
    ];
    const info = buildBranchInfo(all, ['root', 'a2', 'b']);
    expect(Object.keys(info)).toEqual(['a2']);
    expect(info['a2']).toEqual({ index: 1, count: 2, siblings: ['a1', 'a2'] });
  });

  it('不可投影的兄弟（permissionDecision / model_change 等）不撑大分母', () => {
    const decision: Entry = {
      type: 'custom',
      id: 'd',
      seq: 3,
      parentId: 'root',
      timestamp: 1,
      customType: 'permissionDecision',
      data: { toolCallId: 't', decision: 'once', timestamp: 1 },
    };
    const modelChange: Entry = {
      type: 'model_change',
      id: 'm',
      seq: 4,
      parentId: 'root',
      timestamp: 1,
      provider: 'p',
      modelId: 'x',
    };
    const all: Entry[] = [entry('root', 1, null), entry('a', 2, 'root'), decision, modelChange];
    // root 名下 3 个孩子，但可投影的只有 a 一个 → 无分支点
    expect(buildBranchInfo(all, ['root', 'a'])).toEqual({});
  });

  it('根级分支（编辑第一条消息产生的并列提问）同样可识别（parentId = null）', () => {
    const all: Entry[] = [entry('u1', 1, null), entry('u2', 2, null)];
    const info = buildBranchInfo(all, ['u2']);
    expect(info['u2']).toEqual({ index: 1, count: 2, siblings: ['u1', 'u2'] });
  });
});
