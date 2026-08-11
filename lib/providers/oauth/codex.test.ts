import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { codexOAuth } from './codex';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal('chrome', fakeBrowser);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type TabUpdatedListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];

function setupAuthorizationTab(tabId: number) {
  let listener: TabUpdatedListener | undefined;
  const create = vi.spyOn(chrome.tabs, 'create').mockImplementation(
    async () => ({ id: tabId }) as chrome.tabs.Tab,
  );
  const remove = vi.spyOn(chrome.tabs, 'remove').mockResolvedValue(undefined);
  const addListener = vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation((registered) => {
    listener = registered;
  });
  const removeListener = vi.spyOn(chrome.tabs.onUpdated, 'removeListener');
  return {
    create,
    remove,
    addListener,
    removeListener,
    getListener: () => listener,
  };
}

describe('codexOAuth', () => {
  it('forwards the refresh signal to the token request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await codexOAuth.refresh({
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1,
    }, signal);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBe(signal);
  });

  it('accepts only its authorization tab and cleans up after success', async () => {
    const tab = setupAuthorizationTab(42);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const removeAbortListener = vi.spyOn(signal, 'removeEventListener');

    const login = codexOAuth.login({ signal, prompt: async () => '', notify: vi.fn() });
    await vi.waitFor(() => expect(tab.addListener).toHaveBeenCalledTimes(1));
    const authorizeUrl = new URL(String(tab.create.mock.calls[0]?.[0].url));
    const redirectUrl = `http://localhost:1455/auth/callback?code=code-1&state=${authorizeUrl.searchParams.get('state')}`;
    const listener = tab.getListener();
    if (!listener) throw new Error('Expected tab update listener');

    listener(99, { url: redirectUrl }, { id: 99 } as chrome.tabs.Tab);
    expect(fetchMock).not.toHaveBeenCalled();
    listener(42, { url: redirectUrl }, { id: 42 } as chrome.tabs.Tab);

    await expect(login).resolves.toMatchObject({ access: 'new-access' });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBe(signal);
    expect(tab.remove).toHaveBeenCalledWith(42);
    expect(tab.removeListener).toHaveBeenCalledWith(listener);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('closes the authorization tab and removes listeners when cancelled', async () => {
    const tab = setupAuthorizationTab(43);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const login = codexOAuth.login({
      signal: controller.signal,
      prompt: async () => '',
      notify: vi.fn(),
    });
    const rejection = expect(login).rejects.toThrow();
    await vi.waitFor(() => expect(tab.addListener).toHaveBeenCalledTimes(1));
    const listener = tab.getListener();
    controller.abort();

    await rejection;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tab.remove).toHaveBeenCalledWith(43);
    expect(tab.removeListener).toHaveBeenCalledWith(listener);
  });
});