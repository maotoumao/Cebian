import { describe, it, expect } from 'vitest';
import type { OAuthCredential } from '@/lib/persistence/storage';
import { storedToPiCred, piToStoredCred, piCredToResult } from './credential';

describe('credential adapters', () => {
  it('round-trips stored → pi → stored, preserving the enterprise domain', () => {
    const stored: OAuthCredential = {
      authType: 'oauth',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 123456,
      verified: true,
      extra: { enterpriseUrl: 'company.ghe.com' },
    };
    const pi = storedToPiCred(stored);
    expect(pi).toMatchObject({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 123456,
      enterpriseUrl: 'company.ghe.com',
    });
    expect(piToStoredCred(pi)).toEqual(stored);
  });

  it('omits extra when there is no enterprise domain (e.g. Codex)', () => {
    const pi = storedToPiCred({
      authType: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      verified: true,
    });
    expect(pi.enterpriseUrl).toBeUndefined();
    expect(piToStoredCred(pi).extra).toBeUndefined();
  });

  it('maps a pi credential to the public login result shape', () => {
    expect(piCredToResult({ type: 'oauth', access: 'a', refresh: 'r', expires: 9 })).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 9,
      extra: undefined,
    });
  });

  it('preserves arbitrary provider metadata through the round-trip', () => {
    const stored: OAuthCredential = {
      authType: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 5,
      verified: true,
      extra: { enterpriseUrl: 'company.ghe.com', accountId: 'acct-123', availableModelIds: ['m1', 'm2'] },
    };
    const pi = storedToPiCred(stored);
    expect(pi).toMatchObject({ accountId: 'acct-123', availableModelIds: ['m1', 'm2'] });
    expect(piToStoredCred(pi)).toEqual(stored);
  });
});
