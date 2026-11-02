import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { PromptQueue } from './prompt-queue';
import type { QueuedPrompt } from '@/lib/ipc/protocol';

const prompt = (id: string, overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id,
  text: `text-${id}`,
  attachments: [],
  turn: {},
  ...overrides,
});

const userMessage = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }) as AgentMessage;

const ids = (queue: PromptQueue) => queue.view().map((v) => `${v.id}:${v.status}`);

describe('PromptQueue', () => {
  it('排队项按入队顺序出队，插话中的项不会被取出', () => {
    const queue = new PromptQueue();
    queue.enqueue(prompt('a'));
    queue.addSteering(prompt('s'), userMessage('s'), []);
    queue.enqueue(prompt('b'));

    expect(queue.takeNext()?.id).toBe('a');
    expect(queue.takeNext()?.id).toBe('b');
    expect(queue.takeNext()).toBeUndefined();
    expect(ids(queue)).toEqual(['s:steering']);
  });

  it('插话消息按引用消费，内容相同的另一个对象不算', () => {
    const queue = new PromptQueue();
    const steered = userMessage('same');
    queue.addSteering(prompt('s'), steered, []);

    expect(queue.consumeSteered(userMessage('same'))).toBe(false);
    expect(queue.consumeSteered(steered)).toBe(true);
    expect(queue.isEmpty).toBe(true);
  });

  it('收尾时仍在 agent 插话队列里的插话退回到队首、彼此保持顺序，并交出写下的 HAR', () => {
    const queue = new PromptQueue();
    const m1 = userMessage('s1');
    const m2 = userMessage('s2');
    queue.enqueue(prompt('a'));
    queue.addSteering(prompt('s1'), m1, ['/h1']);
    queue.enqueue(prompt('b'));
    queue.addSteering(prompt('s2'), m2, ['/h2']);

    expect(queue.settleSteering(new Set([m1, m2]))).toEqual(['/h1', '/h2']);
    expect(queue.hasSteering).toBe(false);
    expect(ids(queue)).toEqual(['s1:queued', 's2:queued', 'a:queued', 'b:queued']);
  });

  it('收尾时已被 loop 取走的插话算已消费：移出队列，HAR 不交出', () => {
    const queue = new PromptQueue();
    const taken = userMessage('taken');
    const pending = userMessage('pending');
    queue.addSteering(prompt('t'), taken, ['/ht']);
    queue.addSteering(prompt('p'), pending, ['/hp']);
    queue.enqueue(prompt('a'));

    expect(queue.settleSteering(new Set([pending]))).toEqual(['/hp']);
    expect(ids(queue)).toEqual(['p:queued', 'a:queued']);
  });

  it('删除插话项后，剩下的插话消息按原顺序给出，供重新交回 agent', () => {
    const queue = new PromptQueue();
    const m1 = userMessage('1');
    const m2 = userMessage('2');
    const m3 = userMessage('3');
    queue.addSteering(prompt('s1'), m1, []);
    queue.addSteering(prompt('s2'), m2, ['/h2']);
    queue.addSteering(prompt('s3'), m3, []);

    const removed = queue.remove('s2');
    expect(removed?.steering?.writtenHars).toEqual(['/h2']);
    // m3 已被 loop 取走：不再交回 agent
    expect(queue.steeringMessagesIn(new Set([m1, m2]))).toEqual([m1]);
    expect(queue.remove('missing')).toBeUndefined();
  });

  it('删掉的排队项不会再出队', () => {
    const queue = new PromptQueue();
    queue.enqueue(prompt('a'));
    queue.enqueue(prompt('b'));
    expect(queue.remove('a')?.prompt.id).toBe('a');
    expect(queue.takeNext()?.id).toBe('b');
    expect(queue.takeNext()).toBeUndefined();
  });

  it('只能取回排队项去编辑，插话中的取不回', () => {
    const queue = new PromptQueue();
    queue.enqueue(prompt('a'));
    queue.addSteering(prompt('s'), userMessage('s'), []);

    expect(queue.takeQueued('s')).toBeUndefined();
    expect(queue.takeQueued('a')?.id).toBe('a');
    expect(ids(queue)).toEqual(['s:steering']);
  });

  it('派发失败放回的项排在队首', () => {
    const queue = new PromptQueue();
    queue.enqueue(prompt('a'));
    queue.enqueue(prompt('b'));
    const taken = queue.takeNext()!;
    queue.restore(taken);
    expect(queue.takeNext()?.id).toBe('a');
  });

  it('展示快照不带附件正文，只给数量与斜杠提示词名', () => {
    const queue = new PromptQueue();
    queue.enqueue(
      prompt('a', {
        attachments: [{ type: 'image', name: 'x.png', data: 'AAAA', mimeType: 'image/png' } as never],
        slashPrompt: { name: 'review', body: 'long body' },
      }),
    );
    expect(queue.view()).toEqual([
      { id: 'a', text: 'text-a', slashPromptName: 'review', attachmentCount: 1, status: 'queued' },
    ]);
  });
});
