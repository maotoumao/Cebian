import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthCredential } from '@/lib/persistence/storage';
import {
  codexOAuth,
  copilotOAuth,
  loginGitHubCopilot,
  loginOpenAICodex,
  refreshOAuthCredential,
} from './index';

afterEach(() => {
  vi.restoreAllMocks();
});

const credential: OAuthCredential = {
  authType: 'oauth',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1,
  verified: true,
};

describe('refreshOAuthCredential', () => {
  it('combines caller cancellation with the refresh timeout', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(codexOAuth, 'refresh').mockImplementation(async (_credential, signal) => {
      requestSignal = signal;
      return {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 2,
      };
    });
    const controller = new AbortController();

    await refreshOAuthCredential('openai-codex', credential, controller.signal);
    expect(requestSignal).toBeDefined();
    expect(requestSignal).not.toBe(controller.signal);

    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('uses a 15-second timeout signal when the caller provides none', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(codexOAuth, 'refresh').mockImplementation(async (_credential, signal) => {
      requestSignal = signal;
      return {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 2,
      };
    });

    await refreshOAuthCredential('openai-codex', credential);

    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(requestSignal).toBe(timeoutSignal);
  });
});

describe('OAuth login adapters', () => {
  it('normalizes an omitted Copilot login signal', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(copilotOAuth, 'login').mockImplementation(async (interaction) => {
      requestSignal = interaction.signal;
      return { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
    });

    await loginGitHubCopilot({ onDeviceCode: vi.fn() });

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
  });

  it('normalizes an omitted Codex login signal', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(codexOAuth, 'login').mockImplementation(async (interaction) => {
      requestSignal = interaction.signal;
      return { type: 'oauth', access: 'a', refresh: 'r', expires: 1 };
    });

    await loginOpenAICodex();

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
  });
});