// 任务运行中发送的消息队列（issue #96）：每个会话一份，由 SessionManager 持有。
// 只管数据与顺序，不碰 agent 和 IO——交给 `agent.steer()`、出队派发、HAR 清理都在
// session-manager。
//
// 队列不挂在 AgentSession 上：停止任务会拆掉 AgentSession，而停止后队列要保留。

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { QueuedPrompt, QueuedPromptView } from '@/lib/ipc/protocol';

/** 插话项额外记住的东西：交给 `agent.steer()` 的那条消息（按引用匹配消费），以及组装它时
 *  写下的 HAR（插话被撤回时要删掉）。 */
interface Steering {
  message: AgentMessage;
  writtenHars: string[];
}

interface QueueEntry {
  prompt: QueuedPrompt;
  /** 有值 = 已插入当前任务、等下一个工具边界；无值 = 排队等这一轮结束。 */
  steering?: Steering;
}

class PromptQueue {
  private entries: QueueEntry[] = [];
  /** 上一轮异常结束（出错 / 停止 / 上下文到顶）：不自动出队。下一轮开始时清掉。 */
  paused = false;

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  get hasSteering(): boolean {
    return this.entries.some((e) => e.steering);
  }

  enqueue(prompt: QueuedPrompt): void {
    this.entries.push({ prompt });
  }

  /** 把一条刚取出、却没能发出去的排队项放回队首。 */
  restore(prompt: QueuedPrompt): void {
    this.entries.unshift({ prompt });
  }

  /** 记一条已交给 `agent.steer()` 的插话。 */
  addSteering(prompt: QueuedPrompt, message: AgentMessage, writtenHars: string[]): void {
    this.entries.push({ prompt, steering: { message, writtenHars } });
  }

  /** 插话项交给 agent 的那条消息；排队项或不存在返回 undefined。 */
  steeringMessageOf(id: string): AgentMessage | undefined {
    return this.entries.find((e) => e.prompt.id === id)?.steering?.message;
  }

  /** 移除一条（排队或插话中都行），返回被移除的项；不存在返回 undefined。 */
  remove(id: string): QueueEntry | undefined {
    const index = this.entries.findIndex((e) => e.prompt.id === id);
    if (index < 0) return undefined;
    return this.entries.splice(index, 1)[0];
  }

  /** 取出指定的排队项。插话中的不给取——它已经交给 agent 了，只能删除。 */
  takeQueued(id: string): QueuedPrompt | undefined {
    const index = this.entries.findIndex((e) => e.prompt.id === id && !e.steering);
    if (index < 0) return undefined;
    return this.entries.splice(index, 1)[0].prompt;
  }

  /** 取出队首的排队项（跳过插话中的）。 */
  takeNext(): QueuedPrompt | undefined {
    const index = this.entries.findIndex((e) => !e.steering);
    if (index < 0) return undefined;
    return this.entries.splice(index, 1)[0].prompt;
  }

  /** agent 把插话消息投进转录时调用（按引用匹配）。命中则移出队列并返回 true。 */
  consumeSteered(message: AgentMessage): boolean {
    const index = this.entries.findIndex((e) => e.steering?.message === message);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  /** 插话消息中仍在 agent 插话队列里（`inAgent`）的那些，按入队顺序。删掉一条插话后，
   *  调用方清空 agent 的插话队列，再把这些交回去。 */
  steeringMessagesIn(inAgent: ReadonlySet<AgentMessage>): AgentMessage[] {
    return this.entries.flatMap((e) => (e.steering && inAgent.has(e.steering.message) ? [e.steering.message] : []));
  }

  /**
   * 这一轮不会再从 agent 插话队列取消息了（结束或停止），把插话项分两类收掉：
   * - 还在 agent 插话队列里（`inAgent`）的，退回成排队项并挪到队首（彼此保持原顺序）——
   *   插话的本意是「尽快」，理应排在已有排队项前面。返回它们写下的 HAR，调用方删掉，
   *   再派发时会按原始附件重新写。
   * - 已被 loop 取走、只是还没投进转录的，算已消费：直接移出，HAR 留着给转录里那条用。
   */
  settleSteering(inAgent: ReadonlySet<AgentMessage>): string[] {
    const returned = this.entries.filter((e) => e.steering && inAgent.has(e.steering.message));
    const queued = this.entries.filter((e) => !e.steering);
    this.entries = [...returned.map((e) => ({ prompt: e.prompt })), ...queued];
    return returned.flatMap((e) => e.steering!.writtenHars);
  }

  view(): QueuedPromptView[] {
    return this.entries.map(({ prompt, steering }) => ({
      id: prompt.id,
      text: prompt.text,
      ...(prompt.slashPrompt ? { slashPromptName: prompt.slashPrompt.name } : {}),
      attachmentCount: prompt.attachments.length,
      status: steering ? 'steering' : 'queued',
    }));
  }
}

// ─── 公开 API ───

export { PromptQueue };
