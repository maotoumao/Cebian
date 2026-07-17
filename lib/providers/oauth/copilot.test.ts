import { describe, it, expect } from 'vitest';
import { normalizeDomain, getGitHubCopilotBaseUrl } from './copilot';

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
