// prompt() 里录制 HAR 的落盘时机：被拒绝的提交不写，写了但没发出去的要删掉。
// agent 会话用最小假对象顶替（只覆盖 prompt() 这条路径读到的字段），工作目录走真实 VFS。
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RecordingAttachment } from '@/lib/agent/attachments';
import { vfs } from '@/lib/persistence/vfs';
import { sessionManager } from './session-manager';
import { sessionStore } from './session-store';
import { composeSystemPrompt, composeUserMessage } from '../agent/prompt-composer';

vi.mock('../agent/prompt-composer', () => ({
  composeUserMessage: vi.fn(async (text: string) => text),
  composeSystemPrompt: vi.fn(async () => 'system'),
}));

const SID = '00000000-0000-4000-8000-0000000000aa';
const HAR_FILE = `/workspaces/${SID}/recordings/recording-x.har`;

const recording = (): RecordingAttachment => ({
  type: 'recording',
  name: 'recording-x.json',
  sizeBytes: 2,
  eventCount: 1,
  durationMs: 100,
  json: '{}',
  networkCount: 1,
  har: { name: 'recording-x.har', json: '{"log":{}}' },
});

type FakeSession = ReturnType<typeof fakeSession>;
function fakeSession(phase: 'idle' | 'running' | 'preparing', isStreaming = false) {
  const session = {
    sessionId: SID,
    sessionCreated: true,
    phase: phase as string,
    modelKey: 'p/m',
    preamble: { systemPrompt: '', tools: [] },
    agent: {
      state: { model: { contextWindow: 100_000 }, thinkingLevel: 'off', messages: [], isStreaming },
      // 与 pi-agent-core 一致：调用时同步读当前的进行中状态
      prompt: vi.fn(() => {
        if (session.agent.state.isStreaming) return Promise.reject(new Error('Agent is already processing a prompt.'));
        return Promise.resolve();
      }),
      steer: vi.fn(),
    },
    toolCtx: { hasPending: () => false, cancelAll: vi.fn() },
    permissionBridge: { getPending: () => null, cancel: vi.fn() },
  };
  return session;
}

// prompt() 里用到的私有成员
const internals = sessionManager as unknown as {
  sessions: Map<string, FakeSession>;
  getOrCreateAgent: () => Promise<FakeSession>;
};

function install(session: FakeSession): void {
  internals.sessions.set(SID, session);
  vi.spyOn(internals, 'getOrCreateAgent').mockResolvedValue(session);
}

beforeEach(async () => {
  fakeBrowser.reset();
  await vfs.rm(`/workspaces/${SID}`, { recursive: true, force: true });
  vi.spyOn(sessionStore, 'loadMeta').mockResolvedValue({ id: SID } as Awaited<ReturnType<typeof sessionStore.loadMeta>>);
});

afterEach(() => {
  internals.sessions.delete(SID);
  vi.restoreAllMocks();
});

describe('prompt() 与录制 HAR', () => {
  it('正常发出：HAR 写进工作目录，消息里带相对路径', async () => {
    const session = fakeSession('idle');
    install(session);
    await sessionManager.prompt(SID, 'hi', [recording()]);
    expect(await vfs.exists(HAR_FILE)).toBe(true);
    const [, sent] = vi.mocked(composeUserMessage).mock.calls.at(-1)!;
    expect(sent[0]).toMatchObject({ harPath: 'recordings/recording-x.har' });
    expect(sent[0]).not.toHaveProperty('har');
    expect(session.agent.prompt).toHaveBeenCalledOnce();
  });

  it('会话正忙（重试准备中）时提交被丢弃，不写 HAR', async () => {
    install(fakeSession('preparing'));
    await sessionManager.prompt(SID, 'hi', [recording()]);
    expect(await vfs.exists(`/workspaces/${SID}`)).toBe(false);
  });

  it('写完之后被取消：HAR 被删掉，不派发', async () => {
    const session = fakeSession('idle');
    install(session);
    // 模拟 cancel() 在组装系统提示词期间落地（idle 拆除分支把会话移出表）
    vi.mocked(composeSystemPrompt).mockImplementationOnce(async () => {
      internals.sessions.delete(SID);
      return 'system';
    });
    await sessionManager.prompt(SID, 'hi', [recording()]);
    expect(await vfs.exists(HAR_FILE)).toBe(false);
    expect(session.agent.prompt).not.toHaveBeenCalled();
  });

  it('撞上进行中的一轮（过期 IPC）：prompt 照旧报错，HAR 被删掉', async () => {
    install(fakeSession('running', true));
    await expect(sessionManager.prompt(SID, 'hi', [recording()])).rejects.toThrow(/already processing/);
    expect(await vfs.exists(HAR_FILE)).toBe(false);
  });

  it('同一份录制重复提交、后一次撞上进行中的一轮：只删后一次的文件，前一条消息的 HAR 保留', async () => {
    const session = fakeSession('idle');
    install(session);
    await sessionManager.prompt(SID, 'hi', [recording()]);
    session.phase = 'running';
    session.agent.state.isStreaming = true;
    await expect(sessionManager.prompt(SID, 'hi', [recording()])).rejects.toThrow(/already processing/);
    expect(await vfs.exists(HAR_FILE)).toBe(true);
    expect(await vfs.readdir(`/workspaces/${SID}/recordings`)).toEqual(['recording-x.har']);
  });

  it('写入之后的步骤抛错：HAR 被删掉，错误照常抛出', async () => {
    install(fakeSession('idle'));
    vi.mocked(composeSystemPrompt).mockRejectedValueOnce(new Error('boom'));
    await expect(sessionManager.prompt(SID, 'hi', [recording()])).rejects.toThrow('boom');
    expect(await vfs.exists(HAR_FILE)).toBe(false);
  });

  it('写入期间会话被删除：重建出来的工作目录一并删掉', async () => {
    vi.mocked(sessionStore.loadMeta).mockResolvedValue(undefined);
    install(fakeSession('idle'));
    vi.mocked(composeSystemPrompt).mockImplementationOnce(async () => {
      internals.sessions.delete(SID);
      return 'system';
    });
    await sessionManager.prompt(SID, 'hi', [recording()]);
    expect(await vfs.exists(`/workspaces/${SID}`)).toBe(false);
  });
});
