import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { createCompactionSummaryMessage } from '@/lib/agent/compaction-summary';
import { toModel } from '@/lib/providers/custom-models';
import { createCebianAgent, type AgentPreamble } from './factory';
import { NO_TOOLS_NOTE } from './system-prompt';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function echoTool(name: string, onExecute?: () => void): AgentTool<any> {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async () => {
      onExecute?.();
      return { content: [{ type: 'text', text: `${name} ok` }], details: {} };
    },
  };
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

/** 按顺序回放预设回复的假 provider，并记录每次请求收到的 transcript。 */
function scriptedStream(replies: AssistantMessage[]) {
  const requests: Message[][] = [];
  const streamFn = (_model: Model<Api>, context: TranscriptContext) => {
    requests.push([...context.messages]);
    const message = replies[requests.length - 1] ?? assistant([{ type: 'text', text: 'done' }], 'stop');
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    });
    return stream;
  };
  return { requests, streamFn };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function toolNames(message: Message | undefined): string[] {
  return message?.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [];
}

describe('createCebianAgent · system 头', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('每次请求以 system 头开头，且 system 消息从不进入 state 或事件流', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'You are Cebian.', tools: [echoTool('echo')] };
    const agent = createCebianAgent({ model, preamble, thinkingLevel: 'off' });
    const { requests, streamFn } = scriptedStream([
      assistant([{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: {} }], 'toolUse'),
    ]);
    agent.streamFunction = streamFn;
    const roles: string[] = [];
    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'message_end') roles.push(event.message.role);
    });

    await agent.prompt('hi');

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request[0]).toMatchObject({ role: 'system', content: 'You are Cebian.' });
      expect(toolNames(request[0])).toEqual(['echo']);
      expect(request.filter((m) => m.role === 'system')).toHaveLength(1);
    }
    expect(roles).not.toContain('system');
    expect(agent.state.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  });

  it('run 中途改写 preamble，下一次请求即生效，工具也按新集合执行', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'v1', tools: [] };
    let laterRan = false;
    preamble.tools = [
      echoTool('first', () => {
        preamble.systemPrompt = 'v2';
        preamble.tools = [echoTool('later', () => { laterRan = true; })];
      }),
    ];
    const agent = createCebianAgent({ model, preamble, thinkingLevel: 'off' });
    const { requests, streamFn } = scriptedStream([
      assistant([{ type: 'toolCall', id: 'call-1', name: 'first', arguments: {} }], 'toolUse'),
      assistant([{ type: 'toolCall', id: 'call-2', name: 'later', arguments: {} }], 'toolUse'),
    ]);
    agent.streamFunction = streamFn;

    await agent.prompt('hi');

    expect(requests[0][0]).toMatchObject({ role: 'system', content: 'v1' });
    expect(toolNames(requests[0][0])).toEqual(['first']);
    expect(requests[1][0]).toMatchObject({ role: 'system', content: 'v2' });
    expect(toolNames(requests[1][0])).toEqual(['later']);
    expect(laterRan).toBe(true);
    expect(agent.state.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('continue()（重试路径）与 steering 消息同样带头，且不往 state 写 system', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [] };
    let agent: ReturnType<typeof createCebianAgent>;
    preamble.tools = [echoTool('echo', () => agent.steer(userMessage('steered')))];
    agent = createCebianAgent({
      model,
      preamble,
      thinkingLevel: 'off',
      messages: [userMessage('retry me')],
    });
    const { requests, streamFn } = scriptedStream([
      assistant([{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: {} }], 'toolUse'),
    ]);
    agent.streamFunction = streamFn;

    await agent.continue();

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request[0]).toMatchObject({ role: 'system', content: 'base' });
      expect(request.filter((m) => m.role === 'system')).toHaveLength(1);
    }
    expect(JSON.stringify(requests[1])).toContain('steered');
    expect(agent.state.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('同名工具只声明并执行先出现的那个，且不会往 state 插 system 消息', async () => {
    let executed = '';
    const first = { ...echoTool('dup', () => { executed = 'first'; }), description: 'first' };
    const second = { ...echoTool('dup', () => { executed = 'second'; }), description: 'second' };
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [first, second] };
    const agent = createCebianAgent({ model, preamble, thinkingLevel: 'off' });
    const { requests, streamFn } = scriptedStream([
      assistant([{ type: 'toolCall', id: 'call-1', name: 'dup', arguments: {} }], 'toolUse'),
    ]);
    agent.streamFunction = streamFn;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await agent.prompt('hi');

    expect(executed).toBe('first');
    for (const request of requests) {
      const head = request[0];
      expect(head.role === 'system' && head.toolsAdded?.map((tool) => tool.description)).toEqual(['first']);
    }
    expect(agent.state.messages.some((m) => m.role === 'system')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('有压缩摘要时，system 头仍在摘要之前', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [] };
    const summary = createCompactionSummaryMessage('earlier work', 1234, []);
    const agent = createCebianAgent({
      model,
      preamble,
      thinkingLevel: 'off',
      messages: [userMessage('old'), summary],
    });
    const { requests, streamFn } = scriptedStream([]);
    agent.streamFunction = streamFn;

    await agent.prompt('next');

    const [request] = requests;
    expect(request[0]).toMatchObject({ role: 'system', content: 'base' });
    // 摘要降级成 user 消息紧跟在头之后，被折叠掉的 'old' 不再发送
    expect(request.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(JSON.stringify(request)).not.toContain('"old"');
  });

  it('prepareNextTurnWithContext 交回与工具集不一致的 context 时，不会往 state 插 system 消息', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const agent = createCebianAgent({
      model,
      preamble,
      thinkingLevel: 'off',
      // 模拟调用方按纯对话流重建 context：去掉了 system 头、却沿用了工具集。不经工厂
      // 归一的话，pi 会把「工具变更」当成一条 system 消息插进 transcript。
      prepareNextTurnWithContext: (turn) => ({
        context: {
          ...turn.context,
          messages: [...turn.context.messages.filter((m) => m.role !== 'system'), userMessage('injected')],
        },
      }),
    });
    const { requests, streamFn } = scriptedStream([
      assistant([{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: {} }], 'toolUse'),
    ]);
    agent.streamFunction = streamFn;

    await agent.prompt('hi');

    expect(requests).toHaveLength(2);
    expect(requests[1].filter((m) => m.role === 'system')).toHaveLength(1);
    expect(requests[1][0]).toMatchObject({ role: 'system', content: 'base' });
    expect(agent.state.messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('createCebianAgent · 不支持工具调用的模型 (#83)', () => {
  // 自定义模型关掉「工具调用」后，toModel 会在 Model 上挂这个标记
  const chatOnly: Model<Api> = Object.assign({ ...model }, { toolCalling: false });

  /** 一段先调过工具的历史：user → assistant(toolCall) → toolResult → assistant。 */
  function toolHistory(): AgentMessage[] {
    return [
      userMessage('list files'),
      assistant([{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: { path: '/' } }], 'toolUse'),
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'echo',
        content: [{ type: 'text', text: 'echo ok' }],
        isError: false,
        timestamp: Date.now(),
      },
      assistant([{ type: 'text', text: 'done listing' }], 'stop'),
    ];
  }

  function hasToolTraffic(request: Message[]): boolean {
    return request.some(
      (m) => m.role === 'toolResult' || (m.role === 'assistant' && m.content.some((b) => b.type === 'toolCall')),
    );
  }

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('不声明工具、工具历史改写成文本、提示词追加说明，state 不变', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const history = toolHistory();
    const agent = createCebianAgent({ model: chatOnly, preamble, thinkingLevel: 'off', messages: history });
    const { requests, streamFn } = scriptedStream([]);
    agent.streamFunction = streamFn;

    await agent.prompt('next');

    const [request] = requests;
    expect(request[0]).toMatchObject({ role: 'system', content: `base\n\n${NO_TOOLS_NOTE}` });
    expect(toolNames(request[0])).toEqual([]);
    expect(hasToolTraffic(request)).toBe(false);
    const text = JSON.stringify(request);
    expect(text).toContain('[Tool call: echo({\\"path\\":\\"/\\"})]');
    expect(text).toContain('[Tool result: echo]');
    // 只改请求视图：原始工具消息仍在 state 里
    expect(agent.state.messages.slice(0, history.length)).toEqual(history);
  });

  it('压缩摘要保留区里的工具调用同样被改写', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const summary = createCompactionSummaryMessage('earlier work', 1234, toolHistory().slice(1));
    const agent = createCebianAgent({
      model: chatOnly,
      preamble,
      thinkingLevel: 'off',
      messages: [userMessage('old'), summary],
    });
    const { requests, streamFn } = scriptedStream([]);
    agent.streamFunction = streamFn;

    await agent.prompt('next');

    expect(hasToolTraffic(requests[0])).toBe(false);
    expect(JSON.stringify(requests[0])).toContain('[Tool result: echo]');
  });

  it('工具调用后的回复被中断再继续：请求里 user / assistant 严格交替', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const history = [...toolHistory().slice(0, 3), assistant([{ type: 'text', text: 'partial' }], 'aborted')];
    const agent = createCebianAgent({ model: chatOnly, preamble, thinkingLevel: 'off', messages: history });
    const { requests, streamFn } = scriptedStream([]);
    agent.streamFunction = streamFn;

    await agent.prompt('next');

    const roles = requests[0].map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(hasToolTraffic(requests[0])).toBe(false);
  });

  // 经 pi-ai 真实的 streamSimple 转换，用 onPayload 抓实际请求体（fetch 抛错保持离线）
  const custom = toModel(
    { id: 'p', name: 'P', baseUrl: 'https://example.invalid/v1', models: [] },
    { modelId: 'chat-only', name: 'chat-only', reasoning: true, toolCalling: false },
  );
  const own = (message: AssistantMessage): AssistantMessage => ({ ...message, provider: custom.provider, model: custom.id });

  async function requestBody(history: AgentMessage[]): Promise<{ tools?: unknown; messages: { role: string }[] }> {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const agent = createCebianAgent({ model: custom, preamble, thinkingLevel: 'off', messages: history });
    const payloads: { tools?: unknown; messages: { role: string }[] }[] = [];
    agent.streamFunction = (m, context, options) =>
      streamSimple(m, context, {
        ...options,
        apiKey: 'test-key',
        onPayload: (payload) => {
          payloads.push(payload as (typeof payloads)[number]);
          return undefined;
        },
        fetch: async () => {
          throw new Error('offline');
        },
      });
    await agent.prompt('next');
    return payloads[0];
  }

  function expectPlainAlternating(body: { tools?: unknown; messages: { role: string }[] }): void {
    expect(body.tools).toBeUndefined();
    const roles = body.messages.map((m) => m.role).filter((role) => role !== 'system');
    expect(roles).not.toContain('tool');
    expect(roles[0]).toBe('user');
    expect(roles.every((role, i) => i === 0 || role !== roles[i - 1])).toBe(true);
  }

  it('真实请求体：工具轮、只有思考的截断回复、空回复之后，无工具协议且严格交替', async () => {
    expectPlainAlternating(
      await requestBody([
        userMessage('list files'),
        own(assistant([{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: {} }], 'toolUse')),
        toolHistory()[2],
        own(assistant([{ type: 'thinking', thinking: 'still thinking' }], 'length')),
        userMessage('again'),
        own(assistant([], 'stop')),
      ]),
    );
  });

  it('真实请求体：空字符串 user 合并、正文只剩未配对代理字符的回复之后仍严格交替', async () => {
    const stringUser = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: Date.now() });
    expectPlainAlternating(
      await requestBody([
        stringUser(''),
        own(assistant([{ type: 'text', text: 'partial' }], 'aborted')),
        stringUser(''),
        own(assistant([{ type: 'text', text: 'answer' }], 'stop')),
      ]),
    );
    expectPlainAlternating(
      await requestBody([userMessage('first'), own(assistant([{ type: 'text', text: '\uD800' }], 'stop'))]),
    );
  });

  it('真实请求体：历史里有空 user 消息时仍以 user 开头、严格交替', async () => {
    const emptyUser = (): AgentMessage => ({ role: 'user', content: [], timestamp: Date.now() });
    expectPlainAlternating(
      await requestBody([emptyUser(), own(assistant([{ type: 'text', text: 'hi' }], 'stop'))]),
    );
    expectPlainAlternating(
      await requestBody([
        userMessage('first'),
        own(assistant([{ type: 'text', text: 'one' }], 'stop')),
        emptyUser(),
        own(assistant([{ type: 'text', text: 'two' }], 'stop')),
      ]),
    );
  });

  it('同一会话切回支持工具的模型后，工具声明与工具消息恢复原样', async () => {
    const preamble: AgentPreamble = { systemPrompt: 'base', tools: [echoTool('echo')] };
    const agent = createCebianAgent({ model: chatOnly, preamble, thinkingLevel: 'off', messages: toolHistory() });
    const { requests, streamFn } = scriptedStream([]);
    agent.streamFunction = streamFn;

    await agent.prompt('chat only');
    agent.state.model = model;
    await agent.prompt('with tools');

    expect(hasToolTraffic(requests[0])).toBe(false);
    expect(requests[1][0]).toMatchObject({ role: 'system', content: 'base' });
    expect(toolNames(requests[1][0])).toEqual(['echo']);
    expect(hasToolTraffic(requests[1])).toBe(true);
  });
});
