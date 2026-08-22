import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { languageName } from '@/lib/utils';
import { materializeHandoff, runPageActionStream } from './runner';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  resolveModel: vi.fn(),
  resolveProviderApiKey: vi.fn(),
  createWithMessages: vi.fn(),
  setPendingHandoff: vi.fn(),
  getProviderCredentials: vi.fn(),
  getCustomProviders: vi.fn(),
  getLastSelectedModel: vi.fn(),
  getPageActionsConfig: vi.fn(),
  getPageInteractionSettings: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({ stream: mocks.stream }));

vi.mock('@/lib/i18n', () => ({
  t: (key: string, substitutions?: string[]) =>
    substitutions ? `${key}:${substitutions.join('|')}` : key,
}));

vi.mock('@/lib/providers/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('../providers/credentials', () => ({
  resolveProviderApiKey: mocks.resolveProviderApiKey,
}));

vi.mock('../chat/session-store', () => ({
  sessionStore: { createWithMessages: mocks.createWithMessages },
}));

vi.mock('./transform', () => ({ runTransform: vi.fn() }));

vi.mock('@/lib/persistence/storage', () => ({
  providerCredentials: { getValue: mocks.getProviderCredentials },
  customProviders: { getValue: mocks.getCustomProviders },
  lastSelectedModel: { getValue: mocks.getLastSelectedModel },
  pageActionsConfig: { getValue: mocks.getPageActionsConfig },
  pageInteractionSettings: { getValue: mocks.getPageInteractionSettings },
  pendingSidePanelHandoff: { setValue: mocks.setPendingHandoff },
  resolvePageActionsConfig: (value: unknown) => value,
  resolvePageInteractionSettings: (value: unknown) => value,
}));

const IDENTITY = { provider: 'demo', modelId: 'demo-model' };
const MODEL = { api: 'openai-completions', provider: 'demo', id: 'demo-model' };
const SETTINGS = {
  showFloatingBall: true,
  showSelectionToolbar: true,
  ballPages: { include: [], exclude: [] },
  toolbarPages: { include: [], exclude: [] },
};
const ACTIONS = {
  builtin: {
    explain: {
      label: 'Explain',
      systemPrompt: 'Language={{ui_language}}; context={{context}}',
    },
  },
  custom: [],
};

describe('page-action runner prompt contract', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    vi.spyOn(chrome.i18n, 'getUILanguage').mockReturnValue('en-US');
    mocks.getProviderCredentials.mockResolvedValue({});
    mocks.getCustomProviders.mockResolvedValue([]);
    mocks.getLastSelectedModel.mockResolvedValue(IDENTITY);
    mocks.getPageActionsConfig.mockResolvedValue(ACTIONS);
    mocks.getPageInteractionSettings.mockResolvedValue(SETTINGS);
    mocks.resolveModel.mockReturnValue(MODEL);
    mocks.resolveProviderApiKey.mockResolvedValue('api-key');
    mocks.createWithMessages.mockResolvedValue(undefined);
    mocks.setPendingHandoff.mockResolvedValue(undefined);
  });

  it('流式调用用环境变量渲染 system prompt，user turn 保持选中文本原文', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: 'answer' };
    });
    const onDelta = vi.fn();

    await runPageActionStream(
      {
        actionId: 'explain',
        text: 'selected text',
        params: { context: 'surrounding text' },
      },
      { onDelta, signal: new AbortController().signal },
    );

    expect(mocks.stream).toHaveBeenCalledWith(
      MODEL,
      {
        systemPrompt: `Language=${languageName('en-US')}; context=surrounding text`,
        messages: [
          expect.objectContaining({ role: 'user', content: 'selected text' }),
        ],
      },
      expect.objectContaining({ apiKey: 'api-key' }),
    );
    expect(onDelta).toHaveBeenCalledWith('answer');
  });

  it('在侧边栏继续时固化的 user 消息保持选中文本原文', async () => {
    await materializeHandoff(
      {
        actionId: 'explain',
        text: 'selected text',
        result: 'answer',
      },
      7,
    );

    expect(mocks.createWithMessages).toHaveBeenCalledWith(
      expect.objectContaining({ model: IDENTITY.modelId, provider: IDENTITY.provider }),
      [
        expect.objectContaining({ role: 'user', content: 'selected text' }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }),
      ],
    );
    const sessionId = mocks.createWithMessages.mock.calls[0][0].id;
    expect(mocks.setPendingHandoff).toHaveBeenCalledWith({ sessionId, windowId: 7 });
  });
});