import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBgFetch } from './bg-fetch';
import { parseMatchPattern } from './url-pattern';

describe('handleBgFetch redirects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables redirects before fetching when permissions are scoped', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleBgFetch(
      'https://api.example.com/start',
      undefined,
      [parseMatchPattern('https://api.example.com/*')],
    )).rejects.toThrow(/Network error fetching/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('overrides an explicit follow mode when permissions are scoped', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handleBgFetch(
      'https://api.example.com/start',
      { redirect: 'follow' },
      [parseMatchPattern('https://api.example.com/*')],
    )).rejects.toThrow(/Network error fetching/);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('keeps native redirect following for an unrestricted bgFetch permission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await handleBgFetch(
      'https://api.example.com/start',
      { redirect: 'follow' },
      [parseMatchPattern('*://*/*')],
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'follow' });
  });

  it('keeps manual mode for a scoped permission because it never follows redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleBgFetch(
      'https://api.example.com/start',
      { redirect: 'manual' },
      [parseMatchPattern('https://api.example.com/*')],
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
