import { afterEach, describe, it, expect, vi } from 'vitest';
import { normalizeDomain, getGitHubCopilotBaseUrl, copilotOAuth } from './copilot';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizeDomain', () => {
  it('returns hostname for a bare domain', () => {
    expect(normalizeDomain('company.ghe.com')).toBe('company.ghe.com');
  });
  it('extracts hostname from a full URL', () => {
    expect(normalizeDomain('https://company.ghe.com/some/path')).toBe('company.ghe.com');
  });
  it('returns null for blank input', () => {
    expect(normalizeDomain('   ')).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(normalizeDomain('http://')).toBeNull();
  });
});

describe('getGitHubCopilotBaseUrl', () => {
  it('derives api host from the token proxy-ep', () => {
    expect(
      getGitHubCopilotBaseUrl('tid=abc;exp=1;proxy-ep=proxy.individual.githubcopilot.com;more=x'),
    ).toBe('https://api.individual.githubcopilot.com');
  });
  it('falls back to the enterprise domain when the token has no proxy-ep', () => {
    expect(getGitHubCopilotBaseUrl('tid=abc;exp=1', 'company.ghe.com')).toBe(
      'https://copilot-api.company.ghe.com',
    );
  });
  it('uses the individual default when nothing is available', () => {
    expect(getGitHubCopilotBaseUrl()).toBe('https://api.individual.githubcopilot.com');
  });
  it('prefers the token proxy-ep over the enterprise domain', () => {
    expect(
      getGitHubCopilotBaseUrl('proxy-ep=proxy.acme.githubcopilot.com', 'company.ghe.com'),
    ).toBe('https://api.acme.githubcopilot.com');
  });
});

describe('copilotOAuth', () => {
  it('forwards the refresh signal to the token request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: 'new-access',
      expires_at: 2_000_000_000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await copilotOAuth.refresh({
      type: 'oauth',
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 1,
    }, signal);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBe(signal);
  });

  it('does not swallow cancellation while enabling model policies', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const policySignals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      if (url.endsWith('/login/device/code')) {
        return Promise.resolve(new Response(JSON.stringify({
          device_code: 'device-code',
          user_code: 'user-code',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 60,
        }), { status: 200 }));
      }
      if (url.endsWith('/login/oauth/access_token')) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: 'github-token' }), { status: 200 }));
      }
      if (url.endsWith('/copilot_internal/v2/token')) {
        return Promise.resolve(new Response(JSON.stringify({
          token: 'copilot-token',
          expires_at: 2_000_000_000,
        }), { status: 200 }));
      }
      policySignals.push(signal);
      return signal.aborted
        ? Promise.reject(signal.reason)
        : Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const login = copilotOAuth.login({
      signal: controller.signal,
      prompt: async () => '',
      notify: (event) => {
        if (event.type === 'progress') controller.abort();
      },
    });
    const rejection = expect(login).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(policySignals.length).toBeGreaterThan(0);
    expect(policySignals.every((signal) => signal === controller.signal)).toBe(true);
  });
});
