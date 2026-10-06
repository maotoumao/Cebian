import { describe, expect, it } from 'vitest';
import { redactUrl, REDACTED } from './redact-values';

describe('redactUrl', () => {
  it('打码敏感查询参数（含重复参数），保持参数原有顺序', () => {
    const url = redactUrl('https://api.test/cb?a=1&code=xyz&b=2&access_token=t&access_token=u');
    expect([...new URL(url).searchParams]).toEqual([
      ['a', '1'], ['code', REDACTED], ['b', '2'], ['access_token', REDACTED], ['access_token', REDACTED],
    ]);
  });

  it('片段里的令牌（OAuth 隐式流程）同样打码；普通锚点不动', () => {
    const url = redactUrl('https://app.test/callback#access_token=LEAK6rQ8&state=ok');
    expect(url).not.toContain('LEAK6rQ8');
    expect(url).toContain('state=ok');
    expect(redactUrl('https://app.test/docs#section-2')).toBe('https://app.test/docs#section-2');
  });

  it('参数值里装着 JSON（GraphQL GET 的 variables）时按字段名打码', () => {
    const variables = encodeURIComponent(JSON.stringify({ password: 'p', page: 2 }));
    const url = redactUrl(`https://api.test/graphql?query=q&variables=${variables}`);
    const parsed = JSON.parse(new URL(url).searchParams.get('variables')!);
    expect(parsed).toEqual({ password: REDACTED, page: 2 });
  });

  it('只改查询与片段：协议相对、../ 相对地址的其余部分原样保留', () => {
    expect(redactUrl('//api.test/cb?token=S')).toBe(`//api.test/cb?token=${encodeURIComponent(REDACTED)}`);
    expect(redactUrl('../cb?token=S#x')).toBe(`../cb?token=${encodeURIComponent(REDACTED)}#x`);
    expect(redactUrl('http://[bad/?token=S')).not.toContain('=S');
  });

  it('URL 里的用户名 / 密码打码（以最后一个 @ 为界，前导空白不影响）', () => {
    expect(redactUrl('https://u:p@LEAK6rQ8@example.test/path')).toBe('https://redacted@example.test/path');
    expect(redactUrl('  https://u:LEAK6rQ8@api.test/x')).toBe('  https://redacted@api.test/x');
    expect(redactUrl('https://user:LEAK6rQ8@api.test/cb')).toBe('https://redacted@api.test/cb');
    expect(redactUrl('https://TOKEN@github.com/a/b.git')).toBe('https://redacted@github.com/a/b.git');
    expect(redactUrl('mailto:a@b.test')).toBe('mailto:a@b.test');
  });

  it('参数值里嵌着的 URL 同样打码', () => {
    const url = redactUrl(`https://app.test/login?next=${encodeURIComponent('/cb?code=S')}`);
    expect(new URL(url).searchParams.get('next')).toBe(`/cb?code=${encodeURIComponent(REDACTED)}`);
  });

  it('层层嵌套的跳转地址不会耗尽调用栈，深处的令牌仍不漏出', () => {
    const nested = 'https://a/?next='.repeat(1500) + 'https://b/?token=LEAK6rQ8';
    expect(redactUrl(nested)).not.toContain('LEAK6rQ8');
  });

  it('路径里的矩阵参数（;jsessionid=）按名打码；Google 风格的 resource:method 路径不受影响', () => {
    expect(redactUrl('https://a.test/app;jsessionid=LEAK6rQ8?x=1')).toBe('https://a.test/app;jsessionid=redacted?x=1');
    expect(redactUrl('https://a.test/x/token=LEAK6rQ8/y')).toBe('https://a.test/redacted');
    expect(redactUrl('https://a.test/v1/session:refresh')).toBe('https://a.test/v1/session:refresh');
  });

  it('hash 路由里的查询参数（#/cb?code=）按参数处理，路由部分保留', () => {
    for (const name of ['code', 'auth', 'sid', 'session']) {
      const url = redactUrl(`https://app.test/#/callback?${name}=LEAK6rQ8&state=1`);
      expect(url).toBe(`https://app.test/#/callback?${name}=${encodeURIComponent(REDACTED)}&state=1`);
    }
    expect(redactUrl('https://app.test/#/a;token=LEAK6rQ8')).not.toContain('LEAK6rQ8');
  });

  it('多层编码的参数名、矩阵参数名按解码后的名字判断', () => {
    expect(redactUrl('https://api.test/?%2574oken=LEAK6rQ8')).not.toContain('LEAK6rQ8');
    expect(redactUrl('https://a.test/app;jsession%69d=LEAK6rQ8')).not.toContain('LEAK6rQ8');
  });

  it('浏览器能解析出用户信息的变体写法（制表符、反斜杠）整个打码', () => {
    expect(redactUrl('https:\t//user:LEAK6rQ8@api.test/x')).not.toContain('LEAK6rQ8');
    expect(redactUrl('https:\\\\user:LEAK6rQ8@api.test/x')).not.toContain('LEAK6rQ8');
  });

  it('伪造的占位用户信息、内嵌 JSON 的矩阵参数、装着 JSON / 名值的参数名都不漏出', () => {
    for (const url of [
      'https:redacted@alice:LEAK6rQ8@api.test/x',
      'https://a.test/x;meta=%7B%22password%22%3A%22LEAK6rQ8%22%7D',
      'https://a.test/?{"password":"LEAK6rQ8"}',
      'https://a.test/?password:LEAK6rQ8',
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaLEAK6rQ8',
      'https://app.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=LEAK6rQ8',
      'https://app.test/auth/confirm?token_hash=LEAK6rQ8&type=recovery',
      'https://t.auth0.com/device?user_code=LEAK6rQ8',
      'https://api.test/pay?sign=LEAK6rQ8&ts=1',
      'https://a.test/x;password:LEAK6rQ8=1',
      'https://a.test/x;%7B%22password%22:%22LEAK6rQ8%22%7D=1',
    ]) {
      expect(redactUrl(url)).not.toContain('LEAK6rQ8');
    }
  });

  it('没有敏感参数时原样返回，不是 URL 的文本原样返回', () => {
    expect(redactUrl('https://api.test/items?page=2')).toBe('https://api.test/items?page=2');
    expect(redactUrl('https://api.test/auth/login?next=%2Fhome')).toBe('https://api.test/auth/login?next=%2Fhome');
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

