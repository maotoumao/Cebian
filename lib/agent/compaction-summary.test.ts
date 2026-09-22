import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createCompactionSummaryMessage,
  createDroppedHistoryMessage,
  renderSummaryForLlm,
} from '@/lib/agent/compaction-summary';

const retained = [
  { role: 'user', content: [{ type: 'text', text: '保留的问题' }], timestamp: 1 },
] as unknown as AgentMessage[];

describe('createDroppedHistoryMessage', () => {
  it('没有旧摘要时 summary 为空串，dropped 置真，保留区原样挂上', () => {
    const msg = createDroppedHistoryMessage(1_234, retained);
    expect(msg.role).toBe('compactionSummary');
    expect(msg.summary).toBe('');
    expect(msg.dropped).toBe(true);
    expect(msg.tokensBefore).toBe(1_234);
    expect(msg.retainedTail).toEqual(retained);
  });

  it('带上一段仍然有效的摘要：这一轮失败的是合并，不是旧摘要作废', () => {
    const msg = createDroppedHistoryMessage(1_234, retained, '上一段摘要');
    expect(msg.summary).toBe('上一段摘要');
    expect(msg.dropped).toBe(true);
  });
});

describe('renderSummaryForLlm', () => {
  it('普通摘要渲染成 <summary>，不带丢弃说明', () => {
    const text = renderSummaryForLlm(createCompactionSummaryMessage('摘要正文', 10, retained));
    expect(text).toContain('<summary>\n摘要正文\n</summary>');
    expect(text).not.toContain('<context-note>');
  });

  it('无旧摘要的丢弃标记只发 <context-note>，绝不发空的 <summary></summary>', () => {
    // 这条是本模块最要紧的不变式：一旦漏判 dropped，空摘要会被包成
    // <summary></summary> 发出去，等于骗模型说早期上下文已经交代过，而且悄无声息。
    const text = renderSummaryForLlm(createDroppedHistoryMessage(10, retained));
    expect(text).toContain('<context-note>');
    expect(text).not.toContain('<summary>');
  });

  it('带旧摘要的丢弃标记两段都发：旧摘要仍然有效，只是新内容没压成', () => {
    const text = renderSummaryForLlm(createDroppedHistoryMessage(10, retained, '上一段摘要'));
    expect(text).toContain('<summary>\n上一段摘要\n</summary>');
    expect(text).toContain('<context-note>');
    expect(text.indexOf('<summary>')).toBeLessThan(text.indexOf('<context-note>'));
  });

  it('三种形态都带同一句行为指引，且不鼓励模型先回头问用户', () => {
    const texts = [
      renderSummaryForLlm(createCompactionSummaryMessage('摘要', 10, retained)),
      renderSummaryForLlm(createDroppedHistoryMessage(10, retained)),
      renderSummaryForLlm(createDroppedHistoryMessage(10, retained, '旧摘要')),
    ];
    for (const text of texts) {
      expect(text).toContain('Do not respond to it directly');
      expect(text).toContain('Only ask the user for a missing detail if it actually blocks you');
    }
  });
});
