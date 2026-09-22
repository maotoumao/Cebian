import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, serializeConversation } from '@earendil-works/pi-agent-core';
import { estimateMessageTokens, estimateTextTokens } from '@/lib/agent/context-tokens';
import {
  findCompactionCutPoint,
  measureContextUsage,
  planCompaction,
  resolveCompactionBudget,
  splitForSummary,
  summaryChunkBudget,
} from '@/lib/agent/compaction';
import { resolveCompactionSettings, type CompactionSettings } from '@/lib/persistence/storage';

const on = (thresholdPercent: number) => ({ enabled: true, thresholdPercent });

describe('resolveCompactionBudget', () => {
  it('按百分比换算触发点，不再随窗口大小漂移', () => {
    // 旧的「窗口 − 16384」在 128k 上是 87%、在 1M 上是 98.4%；改成百分比后两者一致。
    expect(resolveCompactionBudget(on(80), 128_000).triggerTokens).toBe(102_400);
    expect(resolveCompactionBudget(on(80), 1_048_576).triggerTokens).toBe(838_860);
  });

  it('触发点跟随设定的百分比，而不是写死的默认值', () => {
    expect(resolveCompactionBudget(on(50), 128_000).triggerTokens).toBe(64_000);
    expect(resolveCompactionBudget(on(95), 128_000).triggerTokens).toBe(121_600);
    // 除不尽时向下取整，宁可早一点压。
    expect(resolveCompactionBudget(on(55), 1_000).triggerTokens).toBe(550);
    expect(resolveCompactionBudget(on(85), 1_111).triggerTokens).toBe(944);
  });

  it('保留区按窗口的 20% 取，并钳在 8k–64k', () => {
    // 32k 窗口 → 6.4k，抬到下界；128k → 25.6k 落在区间内；1M → 209k，压到上界。
    expect(resolveCompactionBudget(on(80), 32_000).keepRecentTokens).toBe(8_000);
    expect(resolveCompactionBudget(on(80), 128_000).keepRecentTokens).toBe(25_600);
    expect(resolveCompactionBudget(on(80), 1_048_576).keepRecentTokens).toBe(64_000);
  });

  it('保留区不会反超触发点——否则小窗口模型每轮都切不动，压缩永久空转', () => {
    // 8k 窗口 @80%：触发点 6400，而 8k 的保留区下界比它还大。钳到触发点的一半。
    const small = resolveCompactionBudget(on(80), 8_000);
    expect(small.triggerTokens).toBe(6_400);
    expect(small.keepRecentTokens).toBe(3_200);
    expect(small.keepRecentTokens).toBeLessThan(small.triggerTokens);
    // 正常窗口不受这道钳位影响（25.6k < 102400/2）。
    expect(resolveCompactionBudget(on(80), 128_000).keepRecentTokens).toBe(25_600);
  });

  it('总开关关闭时永不触发，但保留区预算仍是有限值', () => {
    const budget = resolveCompactionBudget({ enabled: false, thresholdPercent: 80 }, 128_000);
    expect(budget.triggerTokens).toBe(Number.POSITIVE_INFINITY);
    // 切点回溯拿它当预算，变成 Infinity 会让 findCompactionCutPoint 行为突变。
    expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
  });

  it('窗口未知（<= 0）时永不触发——宁可不压，也不拿瞎猜的窗口摘掉历史', () => {
    for (const window of [0, -1]) {
      const budget = resolveCompactionBudget(on(80), window);
      expect(budget.triggerTokens).toBe(Number.POSITIVE_INFINITY);
      expect(Number.isFinite(budget.keepRecentTokens)).toBe(true);
    }
  });
});

describe('resolveCompactionSettings', () => {
  it('缺字段 / 空值补默认（WXT fallback 只在 key 整体缺失时生效）', () => {
    expect(resolveCompactionSettings(undefined)).toEqual({ enabled: true, thresholdPercent: 80 });
    expect(resolveCompactionSettings(null)).toEqual({ enabled: true, thresholdPercent: 80 });
    expect(resolveCompactionSettings({ enabled: false })).toEqual({
      enabled: false,
      thresholdPercent: 80,
    });
  });

  it('已存的值优先于默认', () => {
    expect(resolveCompactionSettings({ enabled: true, thresholdPercent: 60 })).toEqual({
      enabled: true,
      thresholdPercent: 60,
    });
  });

  it('阈值夹回 1–99 并取整：恢复备份会把任意 JSON 原样写回，这里是唯一防线', () => {
    const percent = (v: unknown) =>
      resolveCompactionSettings({ thresholdPercent: v } as Partial<CompactionSettings>)
        .thresholdPercent;
    // 超过 100 会让触发点大于窗口 → 压缩永不触发，正是 issue #72 的症状。
    expect(percent(120)).toBe(99);
    expect(percent(0)).toBe(1);
    expect(percent(-5)).toBe(1);
    expect(percent(80.6)).toBe(81);
    // 非数值一律退回默认，而不是算出 NaN 让阈值比较恒假。
    expect(percent(Number.NaN)).toBe(80);
    expect(percent('abc')).toBe(80);
    // Number(null) / Number('') / Number([]) 都是 0，不能当成合法输入夹到 1。
    expect(percent(null)).toBe(80);
    expect(percent('')).toBe(80);
    expect(percent([])).toBe(80);
    expect(percent(true)).toBe(80);
    // 字符串数字是备份文件里常见的手改形态，按数值接住。
    expect(percent('70')).toBe(70);
  });

  it('enabled 非布尔值退回默认，不靠 JS 真值判定', () => {
    expect(
      resolveCompactionSettings({ enabled: 'yes' } as unknown as Partial<CompactionSettings>).enabled,
    ).toBe(true);
    expect(resolveCompactionSettings({ enabled: false }).enabled).toBe(false);
  });
});

// ─── 切点 ───

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as AgentMessage;

/** 纯文本 assistant（不发起工具调用）。 */
const assistant = (text: string, stopReason = 'stop'): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
    stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  }) as AgentMessage;

/** 失败 / 取消留下的空 assistant 标记，形状同 pi handleRunFailure 与 buildAbortedMarker。 */
const marker = (stopReason: 'aborted' | 'error'): AgentMessage => assistant('', stopReason);

/** 发起 `ids` 这几个工具调用的 assistant。 */
const caller = (...ids: string[]): AgentMessage =>
  ({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'toolCall', id, name: 'read', arguments: { id } })),
    timestamp: 1,
    stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  }) as unknown as AgentMessage;

const toolResult = (id: string, text: string): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    timestamp: 1,
  }) as unknown as AgentMessage;

/** 造 `turns` 轮「user + 一次工具调用 + 结果」，每条正文都是同一段文字。 */
function conversation(turns: number, bodyText: string): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(user(bodyText), caller(`t${i}`), toolResult(`t${i}`, bodyText));
  }
  return out;
}

/** 收集一段消息里出现过的 toolCall id 与 toolResult id。 */
function toolIds(messages: AgentMessage[]): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const block of m.content) if (block.type === 'toolCall') calls.add(block.id);
    } else if (m.role === 'toolResult') {
      results.add((m as unknown as { toolCallId: string }).toolCallId);
    }
  }
  return { calls, results };
}

/** 保留区里的每条 toolResult，其 toolCall 必须也在保留区内（孤立 toolResult = issue #9 的 400）。 */
function expectNoOrphanResult(messages: AgentMessage[], cut: number, label: string) {
  const { calls, results } = toolIds(messages.slice(cut));
  for (const id of results) {
    expect(calls.has(id), `${label}: toolResult ${id} 的 toolCall 不在保留区内`).toBe(true);
  }
}

describe('findCompactionCutPoint', () => {
  it('只有 assistant 开头时切点是它自己（下标 0），调用方按 no-op 跳过', () => {
    expect(findCompactionCutPoint([caller('t'), toolResult('t', 'b')], 100)).toBe(0);
  });

  it('只有 toolResult、没有任何 user/assistant 可切时返回 -1', () => {
    expect(findCompactionCutPoint([toolResult('a', 'a'), toolResult('b', 'b')], 10)).toBe(-1);
  });

  it('有完整轮次可切时优先切在 user 上', () => {
    const messages = conversation(6, 'x'.repeat(400));
    const cut = findCompactionCutPoint(messages, 1_000);
    expect(cut).toBeGreaterThan(0);
    expect(messages[cut].role).toBe('user');
  });

  it('user 与 assistant 候选不一致时按优先级取 user，即便 assistant 离 boundary 更近', () => {
    // boundary 落在一长串工具轮次中间：最近的候选是 assistant，但后面还有一条 user。
    // 只有真的实现了「user 优先」才会跳过那条更近的 assistant。
    const messages: AgentMessage[] = [user('开始')];
    for (let i = 0; i < 20; i++) messages.push(caller(`t${i}`), toolResult(`t${i}`, '页'.repeat(200)));
    messages.push(user('追问'), caller('last'), toolResult('last', '页'.repeat(200)));
    const cut = findCompactionCutPoint(messages, 2_000);
    // boundary 落在下标 24（一条 toolResult）。最近的候选是下标 25 的 assistant，
    // 但 user 优先，所以取下标 41 那条 user。
    expect(cut).toBe(41);
    expect(messages[cut].role).toBe('user');
    expectNoOrphanResult(messages, cut, 'user 优先');
  });

  it('扫遍各档预算：切点永不落在 toolResult 上，保留区里也不会出现孤立 toolResult', () => {
    // 混入并发工具调用（一条 assistant 带多个结果）与纯文本收尾，覆盖 boundary
    // 恰好落在两条 toolResult 之间的情形。
    const messages: AgentMessage[] = [user('开始')];
    for (let i = 0; i < 6; i++) {
      messages.push(caller(`a${i}`, `b${i}`), toolResult(`a${i}`, '中'.repeat(200)), toolResult(`b${i}`, '中'.repeat(200)));
    }
    messages.push(assistant('收尾说明'));
    for (let budget = 100; budget <= 6_000; budget += 100) {
      const cut = findCompactionCutPoint(messages, budget);
      expect(['user', 'assistant'], `budget=${budget}`).toContain(messages[cut].role);
      expectNoOrphanResult(messages, cut, `budget=${budget}`);
    }
  });

  it('单条 user + 上百条工具消息的会话也能切动——issue #72 的形状', () => {
    // 一句指令 + 上百次工具调用：整段只有下标 0 一条 user 消息。只认 user 切点时结果
    // 恒为 0、调用方按 no-op 跳过，压缩一次都不会发生，上下文一路涨到撑爆。
    const messages: AgentMessage[] = [user('把这些页面的内容收集起来汇总')];
    for (let i = 0; i < 100; i++) {
      messages.push(caller(`t${i}`), toolResult(`t${i}`, '页面正文'.repeat(50)));
    }
    const cut = findCompactionCutPoint(messages, 2_000);
    expect(cut).toBeGreaterThan(0);
    expect(messages[cut].role).toBe('assistant');
    // 切点之前有实打实的历史可摘要，之后仍是配对完整的 assistant/toolResult。
    expect(messages.slice(0, cut).length).toBeGreaterThan(50);
    expectNoOrphanResult(messages, cut, 'issue #72');
  });

  it('失败 / 取消留下的空 assistant 标记不当候选，否则保留区会只剩这条空消息', () => {
    // 一条巨大的工具结果把 boundary 推到末尾，后面跟着用户点停止留下的空标记。
    // 若把标记当候选，切点落在它身上，保留区就只剩一条 provider 还会整条丢掉的空消息。
    const messages: AgentMessage[] = [user('开始')];
    for (let i = 0; i < 5; i++) messages.push(caller(`t${i}`), toolResult(`t${i}`, '页'.repeat(50)));
    messages.push(caller('big'), toolResult('big', '中'.repeat(9_000)), marker('aborted'));
    const cut = findCompactionCutPoint(messages, 8_000);
    expect(messages[cut].role).toBe('assistant');
    expect((messages[cut] as { stopReason?: string }).stopReason).toBe('toolUse');
    // 保留区 = 发起大调用的 assistant + 它的结果 + 标记，用户正在用的工具输出还在。
    expect(messages.length - cut).toBe(3);
    expectNoOrphanResult(messages, cut, '空标记');
  });

  it('全是失败标记、没有正常轮次时返回 -1 而不是切在标记上', () => {
    expect(findCompactionCutPoint([marker('error'), marker('aborted')], 10)).toBe(-1);
  });

  it('总量不足预算时 boundary 保持 0，按优先级仍取首条 user（即 no-op）', () => {
    expect(findCompactionCutPoint(conversation(2, 'ab'), 100_000)).toBe(0);
  });

  it('换成 CJK 感知的尺子后，同样条数的中文历史保留得更少（切点更靠后）', () => {
    // 两边消息条数、字符数完全相同，只有语种不同；预算取得足够小，保证两边都真的
    // 算出一个非 0 的 boundary，而不是一边退化进「总量不足预算」分支。
    const chinese = conversation(8, '中'.repeat(100));
    const english = conversation(8, 'a'.repeat(100));
    const cutChinese = findCompactionCutPoint(chinese, 300);
    const cutEnglish = findCompactionCutPoint(english, 300);
    expect(cutEnglish).toBeGreaterThan(0);
    expect(cutChinese).toBeGreaterThan(cutEnglish);
    expect(chinese[cutChinese].role).toBe('user');
    expect(english[cutEnglish].role).toBe('user');
  });

  it('末尾单条消息就超预算时退取最后一个候选', () => {
    const messages = [user('a'), assistant('b'), user('c'), caller('d'), toolResult('d', '巨'.repeat(5_000))];
    const cut = findCompactionCutPoint(messages, 1_000);
    // 最后一条 assistant：保留区 = 它 + 它的 toolResult，配对完整且不再多留。
    expect(cut).toBe(3);
    expect(messages[cut].role).toBe('assistant');
    expectNoOrphanResult(messages, cut, '超预算回退');
  });
});

// ─── 摘要分块 ───

/** 一条消息序列化进摘要正文后的估算 token（与 splitForSummary 内部同口径）。 */
function serializedTokens(message: AgentMessage): number {
  const text = serializeConversation(convertToLlm([message]));
  return text ? estimateTextTokens(text) + 1 : 0;
}

describe('summaryChunkBudget', () => {
  it('窗口未知时不分块', () => {
    expect(summaryChunkBudget(0, 16_384, undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(summaryChunkBudget(-1, 16_384, undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('按最坏情况预留滚动摘要的空间，而不是当前 previousSummary 的实际长度', () => {
    // 摘要输出上限 = 0.8 × 16384 = 13107。128k 窗口：128000 − 16384 − 1000 − 13107。
    expect(summaryChunkBudget(128_000, 16_384, undefined)).toBe(97_509);
    // 短摘要不会让预算变大——上限才是决定因素，否则第二块起就会超窗。
    expect(summaryChunkBudget(128_000, 16_384, '很短的摘要')).toBe(97_509);
  });

  it('已有摘要比输出上限还长时按实际长度预留', () => {
    const long = '中'.repeat(20_000);
    expect(summaryChunkBudget(128_000, 16_384, long)).toBe(128_000 - 16_384 - 1_000 - 20_000);
  });

  it('小窗口模型算不出可用空间时不分块，交给丢弃兜底而不是硬撑一个必然失败的预算', () => {
    // 8k 窗口比默认 reserveTokens 还小，available 是负数。
    expect(summaryChunkBudget(8_000, 16_384, undefined)).toBe(Number.POSITIVE_INFINITY);
    // 刚好低于下限时同样不分块。
    expect(summaryChunkBudget(33_000, 16_384, undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('splitForSummary', () => {
  it('装得下就只有一块，退化成原来的单次调用', () => {
    expect(splitForSummary(conversation(3, '中'.repeat(100)), 100_000)).toHaveLength(1);
  });

  it('预算为 Infinity 时恒为一块', () => {
    const messages = conversation(20, '中'.repeat(5_000));
    expect(splitForSummary(messages, Number.POSITIVE_INFINITY)).toEqual([messages]);
  });

  it('空输入返回空数组', () => {
    expect(splitForSummary([], 1_000)).toEqual([]);
  });

  it('按序列化后的体积分块——巨大的工具结果会被 pi 截到 2000 字符，不该按原文计价', () => {
    // 一条 5 万字的页面正文，原文估算 5 万 token，序列化后只剩约 2000 字符。
    // 若按原文计价，这 3 条会被切成 3 块；按真实体积则一块装得下。
    const messages = [
      toolResult('a', '中'.repeat(50_000)),
      toolResult('b', '中'.repeat(50_000)),
      toolResult('c', '中'.repeat(50_000)),
    ];
    for (const m of messages) expect(estimateMessageTokens(m)).toBeGreaterThan(40_000);
    for (const m of messages) expect(serializedTokens(m)).toBeLessThan(3_000);
    expect(splitForSummary(messages, 10_000)).toHaveLength(1);
  });

  it('超预算就分块，块内保持原顺序、不丢不重', () => {
    // 预算取得够大，保证块数不触及 MAX_SUMMARY_CHUNKS 的截断，好断言「不丢不重」。
    const messages = conversation(10, '中'.repeat(200));
    const chunks = splitForSummary(messages, 1_500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(8);
    expect(chunks.flat()).toEqual(messages);
  });

  it('只有「单条自己就超预算」的块才允许超预算', () => {
    const messages = conversation(10, '中'.repeat(200));
    const budget = 1_500;
    for (const chunk of splitForSummary(messages, budget)) {
      const tokens = chunk.reduce((sum, m) => sum + serializedTokens(m), 0);
      expect(tokens <= budget || chunk.length === 1).toBe(true);
    }
  });

  it('正好等于预算时仍留在同一块（判据是严格大于才切）', () => {
    const one = user('中'.repeat(100));
    const size = serializedTokens(one);
    expect(splitForSummary([one, user('中'.repeat(100))], size * 2)).toHaveLength(1);
    expect(splitForSummary([one, user('中'.repeat(100))], size * 2 - 1)).toHaveLength(2);
  });

  it('单条消息自己就超预算时独占一块，不会被塞进别人的块里', () => {
    const huge = user('中'.repeat(5_000));
    const messages = [user('a'), huge, user('b')];
    const chunks = splitForSummary(messages, 1_000);
    expect(chunks.some((c) => c.length === 1 && c[0] === huge)).toBe(true);
    expect(chunks.flat()).toEqual(messages);
  });

  it('块数超上限时丢掉最旧的，保住最近的 8 块', () => {
    // 每条消息都独占一块，造 30 块。
    const messages = Array.from({ length: 30 }, (_, i) => user('中'.repeat(500) + i));
    const chunks = splitForSummary(messages, 400);
    expect(chunks).toHaveLength(8);
    expect(chunks.flat()).toEqual(messages.slice(-8));
  });
});

// ─── 压缩决策 ───

describe('planCompaction', () => {
  const settings = { enabled: true, thresholdPercent: 80 };
  const plan = (messages: AgentMessage[], contextWindow = 20_000) =>
    planCompaction({ messages, settings, contextWindow });

  it('没到阈值 → skip', () => {
    expect(plan(conversation(1, '中'.repeat(10))).kind).toBe('skip');
  });

  it('总开关关闭 → skip，哪怕已经严重超阈值', () => {
    const messages = conversation(20, '中'.repeat(2_000));
    expect(
      planCompaction({
        messages,
        settings: { enabled: false, thresholdPercent: 80 },
        contextWindow: 20_000,
      }).kind,
    ).toBe('skip');
  });

  it('模型没声明窗口 → skip，不拿瞎猜的窗口摘历史', () => {
    expect(plan(conversation(20, '中'.repeat(2_000)), 0).kind).toBe('skip');
  });

  it('超阈值且有切点 → compact，待摘要区间与保留区拼回原序列', () => {
    const messages = conversation(20, '中'.repeat(2_000));
    const decision = plan(messages);
    if (decision.kind !== 'compact') throw new Error(`expected compact, got ${decision.kind}`);
    const { messagesToSummarize, retainedTail } = decision.plan;
    expect(messagesToSummarize.length).toBeGreaterThan(0);
    expect(retainedTail.length).toBeGreaterThan(0);
    expect([...messagesToSummarize, ...retainedTail]).toEqual(messages);
    expect(decision.plan.lastSummary).toBeNull();
  });

  it('超阈值但整段只有一条候选消息 → stuck，调用方据此停轮', () => {
    // 一次工具调用就返回了超大正文：候选只有下标 0 的 user，切在那儿等于没压。
    const messages = [user('抓一下这个页面'), toolResult('t', '中'.repeat(100_000))];
    expect(plan(messages).kind).toBe('stuck');
  });

  it('保留区超过阈值但仍装得进窗口 → 照常 compact，不能因为阈值调低就误判停轮', () => {
    // 阈值调到 50%（滑杆下限）时 trigger = 10000，一组 12000 token 的 assistant+toolResult
    // 会超过 trigger，但离 20000 的窗口还远。拿 trigger 当判据会在这里误报 stuck——
    // 「把阈值调低」本意是更早压缩，反而更容易让 AI 无故停轮。
    const messages = [
      user('开始'),
      caller('a'),
      toolResult('a', '中'.repeat(3_000)),
      caller('b'),
      toolResult('b', '中'.repeat(12_000)),
    ];
    const decision = planCompaction({
      messages,
      settings: { enabled: true, thresholdPercent: 50 },
      contextWindow: 20_000,
    });
    expect(decision.kind).toBe('compact');
  });

  it('保留区的判据随窗口缩放，小窗口模型不会被固定预留量整体判死', () => {
    // 固定减 16384 的话，20k 窗口只剩 3616 的余量，正常会话会被当成压不动。
    const messages = conversation(20, '中'.repeat(2_000));
    expect(plan(messages, 20_000).kind).toBe('compact');
  });

  it('切得动、但保留区自己就塞不进窗口 → 同样是 stuck，压了也白压', () => {
    // 配对完整的「assistant + 超大 toolResult」：切点第三档回退会把这一整组留在保留区，
    // 谁也拆不开。若只看「有没有切点」就判 compact，压完这一次请求照样超窗，下一轮又
    // 立刻超阈值再压一次，原地打转。
    const messages = [
      user('抓一下这个页面'),
      caller('t'),
      toolResult('t', '中'.repeat(100_000)),
    ];
    expect(plan(messages).kind).toBe('stuck');
  });

  it('已有摘要时只处理「自上次摘要以来」的部分，并把旧摘要交出去做滚动合并', () => {
    const retained = [user('保留区里的问题'), assistant('回答')];
    const summaryMsg = {
      role: 'compactionSummary',
      summary: '上一段摘要',
      tokensBefore: 1,
      timestamp: 1,
      retainedTail: retained,
    } as unknown as AgentMessage;
    const after = conversation(20, '中'.repeat(2_000));
    const decision = plan([user('很早以前的问题'), summaryMsg, ...after]);
    if (decision.kind !== 'compact') throw new Error(`expected compact, got ${decision.kind}`);
    expect(decision.plan.lastSummary?.summary).toBe('上一段摘要');
    // 工作序列 = 上次保留区副本 + 摘要之后的新消息，不含摘要之前的原文。
    expect([...decision.plan.messagesToSummarize, ...decision.plan.retainedTail]).toEqual([
      ...retained,
      ...after,
    ]);
  });
});

// ─── 占用快照 ───

describe('measureContextUsage', () => {
  const settings = { enabled: true, thresholdPercent: 80 };
  const measure = (messages: AgentMessage[], contextWindow = 20_000, s = settings) =>
    measureContextUsage({ messages, settings: s, contextWindow });

  it('报出的 tokens 与压缩判据用的是同一个数', () => {
    // 这条是整个指示器的意义所在：界面显示的必须就是压缩真正比较的那个值，
    // 否则会出现「显示 75%、却已经开始压缩」。
    const messages = conversation(20, '中'.repeat(2_000));
    const usage = measure(messages);
    const decision = planCompaction({ messages, settings, contextWindow: 20_000 });
    if (decision.kind !== 'compact') throw new Error(`expected compact, got ${decision.kind}`);
    // 只断言「两边都超阈值」是不够的：`readContext` 被改坏成两套算法时那样也会绿。
    // `plan.tokensBefore` 就是 planCompaction 拿去和阈值比的那个值，直接对等。
    expect(usage.tokens).toBe(decision.plan.tokensBefore);
    expect(usage.triggerTokens).toBe(16_000);
    expect(usage.tokens).toBeGreaterThan(usage.triggerTokens!);
  });

  it('systemPrompt 与工具表会透传给估算器（无 usage 锚点时才计入）', () => {
    // 这几条消息都没有 usage 锚点，前缀因此会被算进去；透传若断掉，两次结果会相同。
    const messages = [user('你好')];
    const bare = measureContextUsage({ messages, settings, contextWindow: 20_000 });
    const withPrefix = measureContextUsage({
      messages,
      settings,
      contextWindow: 20_000,
      systemPrompt: '很长的系统提示词'.repeat(50),
      tools: [{ name: 'read', description: 'x'.repeat(400) }],
    });
    expect(withPrefix.tokens).toBeGreaterThan(bare.tokens);
  });

  it('压缩关掉时照常报占用，只是没有触发点', () => {
    // 指示器不能因为用户关了自动压缩就消失——那时候更需要知道还剩多少。
    const usage = measure(conversation(3, '中'.repeat(100)), 20_000, {
      enabled: false,
      thresholdPercent: 80,
    });
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.contextWindow).toBe(20_000);
    expect(usage.triggerTokens).toBeNull();
  });

  it('模型没声明窗口时窗口为 0、无触发点，界面据此不画环', () => {
    const usage = measure(conversation(3, '中'.repeat(100)), 0);
    expect(usage.contextWindow).toBe(0);
    expect(usage.triggerTokens).toBeNull();
    expect(usage.tokens).toBeGreaterThan(0);
  });

  it('负数窗口归一成 0，不让界面算出负比例', () => {
    expect(measure([user('hi')], -5).contextWindow).toBe(0);
  });

  it('只统计「自上次摘要以来」的部分——压缩之后占用应当明显回落', () => {
    const heavy = conversation(20, '中'.repeat(2_000));
    const before = measure(heavy).tokens;
    // 把这段历史折进一条摘要，保留区只剩最后一轮。
    const retained = heavy.slice(-3);
    const summaryMsg = {
      role: 'compactionSummary',
      summary: '摘要正文',
      tokensBefore: before,
      timestamp: 1,
      retainedTail: retained,
    } as unknown as AgentMessage;
    const after = measure([...heavy, summaryMsg]).tokens;
    expect(after).toBeLessThan(before);
  });

  it('空会话为 0', () => {
    expect(measure([]).tokens).toBe(0);
  });
});
