import { describe, expect, it } from 'vitest';
import { redactBody, redactHeaders } from './redact';
import { REDACTED, redactUrl } from './redact-values';

describe('redactHeaders', () => {
  it('认证类与名字像凭据的请求头打码，大小写不敏感，其余原样保留', () => {
    expect(redactHeaders([
      { name: 'Authorization', value: 'Bearer abc' },
      { name: 'authorization', value: 'Basic x' },
      { name: 'X-Token', value: 't' },
      { name: 'apikey', value: 'k' },
      { name: 'Cookie', value: 'a=1' },
      { name: 'Content-Type', value: 'application/json' },
    ])).toEqual([
      { name: 'Authorization', value: REDACTED },
      { name: 'authorization', value: REDACTED },
      { name: 'X-Token', value: REDACTED },
      { name: 'apikey', value: REDACTED },
      { name: 'Cookie', value: REDACTED },
      { name: 'Content-Type', value: 'application/json' },
    ]);
  });

  it('名字带 X- 前缀的凭据头、头部值里内嵌的 URL（Link、CSP）同样打码', () => {
    const [csrf, sessionKey, link, csp] = redactHeaders([
      { name: 'X-CSRF', value: 'C' },
      { name: 'X-Session-Key', value: 'K' },
      { name: 'Link', value: '<https://a.test/file?X-Amz-Signature=LEAK6rQ8>; rel="preload"' },
      { name: 'Content-Security-Policy', value: "default-src 'self'; report-uri https://a.test/?token=LEAK6rQ8" },
    ]);
    expect(csrf.value).toBe(REDACTED);
    expect(sessionKey.value).toBe(REDACTED);
    expect(link.value).not.toContain('LEAK6rQ8');
    expect(link.value).toContain('rel="preload"');
    expect(csp.value).not.toContain('LEAK6rQ8');
    expect(csp.value).toContain("default-src 'self'");
  });

  it('Link 里尖括号引用整段打码（含 ; , 与相对地址），裸 URL 不在 , ; 处提前截断', () => {
    const [semicolon, comma, relative, bare] = redactHeaders([
      { name: 'Link', value: '<https://a.test/a;b?token=LEAK6rQ8>; rel="next"' },
      { name: 'Link', value: '<https://a.test/?token=abc,LEAK6rQ8>; rel="next"' },
      { name: 'Link', value: '</cb?token=LEAK6rQ8>; rel="next"' },
      { name: 'X-Report', value: 'https://a.test/?token=abc,LEAK6rQ8;x=1' },
    ]);
    for (const h of [semicolon, comma, relative, bare]) expect(h.value).not.toContain('LEAK6rQ8');
    expect(semicolon.value).toMatch(/^<https:\/\/a\.test\/a;b\?token=.*>; rel="next"$/);
    expect(relative.value).toMatch(/^<\/cb\?token=.*>; rel="next"$/);
  });

  it('其它头的值里还有凭据迹象（敏感名字的赋值、带用户信息的 URL）时整个值打码', () => {
    const [assign, userinfo, plain] = redactHeaders([
      { name: 'X-Debug', value: 'user=a; token=LEAK6rQ8' },
      { name: 'X-Upstream', value: 'via https://u:LEAK6rQ8@a.test' },
      { name: 'Cache-Control', value: 'max-age=0, no-cache' },
    ]);
    expect(assign.value).toBe(REDACTED);
    expect(userinfo.value).not.toContain('LEAK6rQ8');
    expect(plain.value).toBe('max-age=0, no-cache');
  });

  it('名字列表类的头按结构判断、不按词打码；URL 之外的部分才检查凭据迹象', () => {
    const [link, vary, allow, boundary, bearer, bracket] = redactHeaders([
      { name: 'Link', value: '<https://api.test/v1/session:refresh>; rel="next"' },
      { name: 'Vary', value: 'Cookie, Authorization' },
      { name: 'Access-Control-Allow-Headers', value: 'authorization, x-csrf-token' },
      { name: 'Content-Type', value: 'multipart/form-data; boundary=token=LEAK6rQ8' },
      { name: 'X-Forwarded-Auth', value: 'Bearer abcdefLEAK6rQ8' },
      { name: 'X-Note', value: 'a["password"]="LEAK6rQ8"' },
    ]);
    expect(link.value).toBe('<https://api.test/v1/session:refresh>; rel="next"');
    expect(vary.value).toBe('Cookie, Authorization');
    expect(allow.value).toBe('authorization, x-csrf-token');
    for (const h of [boundary, bearer, bracket]) expect(h.value).toBe(REDACTED);
  });

  it('尖括号里不是 URL 的内容、Refresh 里不是 URL 的目标按自由文本检查；CSP 不按词打码；Basic 凭据打码', () => {
    const [angle, angleColon, refresh, csp, basic] = redactHeaders([
      { name: 'X-Debug', value: 'note <my password is hunter2LEAK6rQ8>' },
      { name: 'X-Debug', value: '<password: LEAK6rQ8>' },
      { name: 'Refresh', value: '0; password: LEAK6rQ8' },
      { name: 'Content-Security-Policy', value: "connect-src 'self' https://*.auth0.com https://securetoken.googleapis.com" },
      { name: 'X-Forwarded-Authorization', value: 'Basic dXNlcjpMRUFL' },
    ]);
    for (const h of [angle, angleColon, refresh, basic]) expect(h.value).toBe(REDACTED);
    expect(csp.value).toBe("connect-src 'self' https://*.auth0.com https://securetoken.googleapis.com");
    const [forwarded] = redactHeaders([{ name: 'X-Debug', value: 'via Basic dXNlcjpMRUFL' }]);
    expect(forwarded.value).toBe(REDACTED);
  });

  it('Link 的相对引用按 URL 处理；裸 URL 不在单引号处截断；名字列表类的头名与策略头的功能名不误伤', () => {
    const [relative, fragment, anchor, acac, policy, featurePolicy] = redactHeaders([
      { name: 'Link', value: '<cb?key=LEAK6rQ8>; rel="next"' },
      { name: 'Link', value: '<#ticket=LEAK6rQ8>; rel="next"' },
      { name: 'Link', value: `<https://a.test/page>; rel="next"; anchor="https://a.test/login?password=abc'LEAK6rQ8"` },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
      { name: 'Permissions-Policy', value: 'camera=(), otp-credentials=(self "https://a.test")' },
      { name: 'Feature-Policy', value: "otp-credentials 'self'; camera 'none'" },
    ]);
    for (const h of [relative, fragment, anchor]) expect(h.value).not.toContain('LEAK6rQ8');
    expect(relative.value).toMatch(/^<cb\?key=.*>; rel="next"$/);
    expect(acac.value).toBe('true');
    const [functionsKey, csp] = redactHeaders([
      { name: 'x-functions-key', value: 'LEAK6rQ8' },
      { name: 'Content-Security-Policy', value: "script-src 'nonce-r4nd0m' 'sha256-abc='" },
    ]);
    expect(functionsKey.value).toBe(REDACTED);
    expect(csp.value).toBe("script-src 'nonce-r4nd0m' 'sha256-abc='");
    expect(policy.value).toBe('camera=(), otp-credentials=(self "https://a.test")');
    expect(featurePolicy.value).toBe("otp-credentials 'self'; camera 'none'");
  });

  it('base64 包着的 JSON 里的凭据（AppSync 的 header 参数与 WebSocket 子协议）', () => {
    const jwt = `${btoa('{"alg":"HS256"}').replace(/=+$/, '')}.e30.LEAK6rQ8`;
    const header = btoa(JSON.stringify({ Authorization: jwt, host: 'x.appsync-api.us-east-1.amazonaws.com' }));
    const [protocol] = redactHeaders([{ name: 'Sec-WebSocket-Protocol', value: `graphql-ws, header-${header.replace(/=+$/, '')}` }]);
    expect(protocol.value).toBe(REDACTED);
    expect(redactUrl(`wss://x.appsync-realtime-api.us-east-1.amazonaws.com/graphql?header=${encodeURIComponent(header)}&payload=e30=`))
      .not.toContain(encodeURIComponent(header));
  });

  it('base64 包着的 JSON：含中文、含 + 的标准 base64、内部再转义、后面紧跟文字、格式化输出都能解开', () => {
    const toBase64 = (text: string) => Buffer.from(text).toString('base64');
    const toBase64Url = (text: string) => toBase64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const samples = [
      toBase64('{"user":"张三","Authorization":"LEAK6rQ8"}'),
      toBase64('{"x":">>>~~~","Authorization":"LEAK6rQ8"}'),
      toBase64(String.raw`{"\u0041uthorization":"LEAK6rQ8"}`),
      `${toBase64Url('{"Authorization":"LEAK6rQ8"}')}-v2`,
      toBase64('{ "password": "LEAK6rQ8" }'),
      toBase64('{\n  "password": "LEAK6rQ8"\n}'),
      toBase64('{  "Authorization":"LEAK6rQ8"}'),
      toBase64(' \n{ \n "password":"LEAK6rQ8"}'),
      toBase64('[{"Authorization":"LEAK6rQ8"}]'),
      // MIME 风格换行
      toBase64('{"host":"example.appsync-api.us-east-1.amazonaws.com","Authorization":"LEAK6rQ8"}').replace(/(.{76})/g, '$1\n'),
      // 两层嵌套
      toBase64(JSON.stringify({ header: toBase64('{"Authorization":"LEAK6rQ8"}') })),
    ];
    for (const encoded of samples) {
      const url = `https://a.test/?header=${encodeURIComponent(encoded)}`;
      expect(redactUrl(url)).not.toContain(encodeURIComponent(encoded));
      expect(JSON.parse(recorded(JSON.stringify({ state: encoded }))).state).toBe(REDACTED);
    }
    const [protocol] = redactHeaders([
      { name: 'Sec-WebSocket-Protocol', value: `graphql-ws, header-${toBase64Url('{"user":"王","Authorization":"LEAK6rQ8"}')}` },
    ]);
    expect(protocol.value).toBe(REDACTED);
    // 前面先有普通文字再接编码内容：路径段、参数值、子协议、字符串值、两行拼接
    const json = toBase64Url('{"Authorization":"LEAK6rQ8"}');
    for (const prefix of ['x/', 'embed/', 'events/', 'export/', 'Data/', 'edit/', 'Images/']) {
      expect(redactUrl(`https://a.test/${prefix}${json}`)).not.toContain(json);
    }
    expect(redactUrl(`https://a.test/#/edit/${json}`)).not.toContain(json);
    expect(redactUrl(`https://a.test/?state=Data-${json}`)).not.toContain(json);
    expect(redactUrl(`https://a.test/?state=edit_${json}`)).not.toContain(json);
    const [dataProtocol] = redactHeaders([{ name: 'Sec-WebSocket-Protocol', value: `graphql-ws, Data-${json}` }]);
    expect(dataProtocol.value).toBe(REDACTED);
    for (const value of [`ID_${json}`, `event-${json}`, `Done\n${toBase64('{"Authorization":"LEAK6rQ8"}')}`, `${toBase64Url('{"a":"bc"}')}\n${json}`]) {
      expect(JSON.parse(recorded(JSON.stringify({ state: value }))).state).toBe(REDACTED);
    }
  });

  it('病态的头部值保持线性耗时（未闭合的 <、Refresh 里的长空白）', () => {
    const start = performance.now();
    redactHeaders([
      { name: 'X-A', value: '<'.repeat(65536) },
      { name: 'Vary', value: `a${']'.repeat(65536)}` },
      { name: 'X-B', value: 'http:'.repeat(13000) },
      { name: 'Refresh', value: `0; url=a${' '.repeat(65536)}z` },
    ]);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('值是 URL 的头（Referer / Location / Refresh）里的参数与片段打码，相对地址保持相对', () => {
    const [referer, location, relative, refresh] = redactHeaders([
      { name: 'Referer', value: 'https://app.test/cb?code=LEAK6rQ8&state=1' },
      { name: 'Location', value: 'https://app.test/cb#access_token=LEAK6rQ8&state=ok' },
      { name: 'Location', value: '/cb?code=LEAK6rQ8' },
      { name: 'Refresh', value: '0; url=https://app.test/cb?token=LEAK6rQ8' },
    ]);
    const [spaced, quoted] = redactHeaders([
      { name: 'Refresh', value: '0; url = https://app.test/cb?token=LEAK6rQ8' },
      { name: 'Refresh', value: "5;URL='https://app.test/cb?token=LEAK6rQ8'" },
    ]);
    expect(spaced.value).toMatch(/^0; url = https:\/\/app\.test\/cb\?token=/);
    expect(spaced.value).not.toContain('LEAK6rQ8');
    expect(quoted.value).toMatch(/^5;URL='https:\/\/app\.test\/cb\?token=.*'$/);
    expect(quoted.value).not.toContain('LEAK6rQ8');
    expect(referer.value).not.toContain('LEAK6rQ8');
    expect(referer.value).toContain('state=1');
    expect(location.value).not.toContain('LEAK6rQ8');
    expect(location.value).toContain('state=ok');
    expect(relative.value).toBe(`/cb?code=${encodeURIComponent(REDACTED)}`);
    expect(refresh.value.startsWith('0; url=https://app.test/cb?token=')).toBe(true);
    expect(refresh.value).not.toContain('LEAK6rQ8');
  });
});

/** 断言这份正文能被记录（不是 undefined），返回打码后的文本。 */
function recorded(text: string, mimeType?: string): string {
  const out = redactBody(text, mimeType);
  expect(out).toBeTypeOf('string');
  return out!;
}

describe('redactBody', () => {
  it('JSON：按字段名递归打码（含数组、嵌套与 GraphQL variables），非敏感字段保留', () => {
    const body = JSON.stringify({
      username: 'alice',
      password: 'p',
      profile: { keyword: 'k', refresh_token: 'r' },
      items: [{ secret: 's', name: 'n' }],
      variables: { apiKey: 'x' },
    });
    expect(JSON.parse(recorded(body, 'application/json'))).toEqual({
      username: 'alice',
      password: REDACTED,
      profile: { keyword: 'k', refresh_token: REDACTED },
      items: [{ secret: REDACTED, name: 'n' }],
      variables: { apiKey: REDACTED },
    });
  });

  it('JSON 里的业务状态码 code 不打码；顶层数组、字符串根值同样处理', () => {
    expect(JSON.parse(recorded('{"code":0,"msg":"ok","data":{"token":"t"}}', 'application/json')))
      .toEqual({ code: 0, msg: 'ok', data: { token: REDACTED } });
    expect(JSON.parse(recorded('[{"password":"p"},{"name":"n"}]'))).toEqual([{ password: REDACTED }, { name: 'n' }]);
    expect(recorded('"https://a.test/?token=S"', 'application/json')).not.toContain('=S');
  });

  it('字符串里再装着的 JSON、URL 递归打码；其余文本有凭据迹象就整段打码', () => {
    const body = JSON.stringify({
      payload: JSON.stringify({ access_token: 'LEAK6rQ8', ok: true }),
      next: '../cb?code=LEAK6rQ8',
      query: 'mutation { login(username: "a", password: "LEAK6rQ8") { id } }',
      triple: 'mutation { login(password: """LEAK6rQ8""", otp: 123456) { id } }',
      variable: 'mutation Login($pw: String!) { login(password: $pw) { id } }',
      prose: 'see https://a.test/?token=LEAK6rQ8 for details',
      encoded: 'next=https%3A%2F%2Fa.test%2F%3Ftoken%3DLEAK6rQ8',
      escaped: '{\\"password\\":\\"LEAK6rQ8\\"',
      note: '{not json',
    });
    const parsed = JSON.parse(recorded(body, 'application/json'));
    expect(JSON.parse(parsed.payload)).toEqual({ access_token: REDACTED, ok: true });
    expect(parsed.next).toBe(`../cb?code=${encodeURIComponent(REDACTED)}`);
    // 变量化的 GraphQL 也整段打码：无法可靠区分变量引用与字面量（宁可多打）
    for (const key of ['query', 'triple', 'variable', 'prose', 'encoded', 'escaped']) expect(parsed[key]).toBe(REDACTED);
    expect(parsed.note).toBe('{not json');
  });

  it('URL 前后带空白（空格、制表、换行）照样识别并打码，空白保留', () => {
    for (const ws of [' ', '\t', '\n']) {
      const parsed = JSON.parse(recorded(JSON.stringify({ next: `https://a.test/?token=LEAK6rQ8${ws}` })));
      expect(parsed.next).toBe(`https://a.test/?token=${encodeURIComponent(REDACTED)}${ws}`);
    }
    const form = recorded(`next=${encodeURIComponent('https://a.test/?token=LEAK6rQ8 ')}`, 'application/x-www-form-urlencoded');
    expect(form).not.toContain('LEAK6rQ8');
  });

  it('字段名本身装着 URL / 凭据时字段名同样打码', () => {
    const parsed = JSON.parse(recorded(JSON.stringify({ 'https://a.test/?token=LEAK6rQ8': 1, ok: 2 })));
    expect(Object.keys(parsed).join()).not.toContain('LEAK6rQ8');
    expect(parsed.ok).toBe(2);
  });

  it('打码长字符串保持线性耗时（64 KB 的 base64url 值、长标识符串）', () => {
    const value = 'aB3-_x'.repeat(11000);
    const start = performance.now();
    recorded(JSON.stringify({ blob: value, note: `${value}: x` }), 'application/json');
    recorded(JSON.stringify({ blob: `${'a'.repeat(65536)}://` }), 'application/json');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('自由文本里的各种写法：命令行参数、GraphQL 注释、括号属性、转义、带空格的名字、Bearer、JWT', () => {
    const texts = [
      'mysql --password=LEAK6rQ8 -h db',
      'mutation { login(password # comment\n: "LEAK6rQ8") { id } }',
      'a["password"]="LEAK6rQ8"',
      'received {"pass\\u0077ord":"LEAK6rQ8"}',
      'received {"p\\u0061ssword":"LEAK6rQ8"}',
      'received {"api key":"LEAK6rQ8"}',
      'password=[redacted]LEAK6rQ8',
      'see //user:LEAK6rQ8@api.test/x',
      'https:\\\\user:LEAK6rQ8@api.test/x',
      '//{"token":"LEAK6rQ8"}',
      'Authorization: Bearer abcdefLEAK6rQ8',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.LEAK6rQ8',
    ];
    for (const text of texts) {
      expect(JSON.parse(recorded(JSON.stringify({ note: text }))).note).toBe(REDACTED);
    }
  });

  it('普通文本不误伤：错误码、只有一个词的枚举值', () => {
    const body = { message: 'Request failed, error code: 500', grant_type: 'refresh_token', kind: 'session' };
    expect(JSON.parse(recorded(JSON.stringify(body)))).toEqual(body);
  });

  it('不依赖名字的凭据形态：短 Bearer、头部 JSON 带空白的 JWT、名字里带 secret 的令牌', () => {
    const toBase64Url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${toBase64Url('{\n  "alg": "HS256",\n  "typ": "JWT"\n}')}.${toBase64Url('{"sub":"1"}')}.LEAK6rQ8sig`;
    for (const note of ['Bearer abc1234LEAK6rQ8', jwt, 'pi_3MtwLEAK6rQ8_secret_YrKJ', 'password.hunter']) {
      expect(JSON.parse(recorded(JSON.stringify({ note }))).note).toBe(REDACTED);
    }
  });

  it('短的 Basic 凭据、载荷为空对象的 JWT 同样识别', () => {
    const toBase64Url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const emptyClaims = `${toBase64Url('{"alg":"HS256"}')}.e30.LEAK6rQ8sig`;
    for (const note of ['Basic YTpi', 'Basic dTo=', emptyClaims]) {
      expect(JSON.parse(recorded(JSON.stringify({ note }))).note).toBe(REDACTED);
    }
  });

  it('JSON 里的授权码带 / . 时同样打码（Google、Microsoft、CAS），key 的路径值不误伤', () => {
    for (const code of ['4/0AeaYSHLEAK6rQ8abcdefghij', '0.AXkALEAK6rQ8abcdefg.AgAB', 'ST-12345-LEAK6rQ8-cas01.example.org']) {
      expect(recorded(JSON.stringify({ code }), 'application/json')).not.toContain('LEAK6rQ8');
    }
    const plain = { key: 'uploads/2024/05/a1b2c3d4e5f6g7.jpg', code: 'auth/invalid-email' };
    expect(JSON.parse(recorded(JSON.stringify(plain)))).toEqual(plain);
  });

  it('真实认证接口的字段：Firebase 手机登录、Cognito 挑战应答、恢复码', () => {
    const bodies = [
      { sessionInfo: 'LEAK6rQ8LEAK6rQ8x', code: '683791' },
      { temporaryProof: 'LEAK6rQ8LEAK6rQ8x', phoneNumber: '+15555550100' },
      { ChallengeResponses: { SMS_MFA_CODE: 'LEAK6rQ8', SOFTWARE_TOKEN_MFA_CODE: 'LEAK6rQ8' } },
      { type: 'recovery_codes', unused_codes: ['LEAK6rQ8'] },
      { newPwd: 'LEAK6rQ8', userPass: 'LEAK6rQ8' },
    ];
    for (const body of bodies) expect(recorded(JSON.stringify(body), 'application/json')).not.toContain('LEAK6rQ8');
    expect(recorded('new_pass=LEAK6rQ8&passwrd=LEAK6rQ8', 'application/x-www-form-urlencoded')).not.toContain('LEAK6rQ8');
  });

  it('JSON 里的短信验证码、设备授权码、以 key 结尾的密钥字段、sign 签名', () => {
    const bodies = [
      { sessionInfo: 'LEAK6rQ8', code: '642831' },
      { device_code: 'x', user_code: 'LEAK6rQ8', verification_uri_complete: 'https://t.auth0.com/device?user_code=LEAK6rQ8' },
      { sharedKey: 'JBSWY3DPEHPK3PXPLEAK6rQ8', primaryKey: 'aB3/dE+fG=hIjKLEAK6rQ8' },
      { keys: [{ keyName: 'key1', value: 'LEAK6rQ8' }] },
      { key: 'abc/def+ghi=jklLEAK6rQ8' },
      { sign: 'a1b2c3d4e5f6LEAK6rQ8' },
      { stateHandle: '02.id.LEAK6rQ8' },
      { status: 'ok', data: { tokenUuid: 'u1', tokenName: 'automation', tokenValue: 'LEAK6rQ8' } },
      { id: 'id1', name: 'automation', encoded: 'aWQxOkxFQUs2clE4' },
      { sharedKey: 'LEAKQQQQLEAKQQQQLEAKQQQQLEAKQQQQ' },
      { ChallengeName: 'CUSTOM_CHALLENGE', ChallengeResponses: { USERNAME: 'u', ANSWER: 'LEAK6rQ8' } },
      { apiKeys: ['sk_live_LEAK6rQ8abcdef1234'] },
      { ticket: '642831' },
      { primaryKey: `/${'LEAK6rQ8'.repeat(5)}AA=` },
      { key: { kty: 'oct', k: 'LEAK6rQ8'.repeat(5) } },
      { keys: [{ kty: 'RSA', n: 'pub', e: 'AQAB', d: 'LEAK6rQ8', p: 'LEAK6rQ8' }] },
      { keys: ['JBSWY3DPEHPK3PXPLEAK6rQ8'] },
      { properties: { AzureWebJobsStorage: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=LEAK6rQ8+abc/def==;EndpointSuffix=core.windows.net' } },
      { name: 'interaction_code', value: 'LEAK6rQ8' },
      { msg: 'method', method: 'login', params: [{ resume: 'LEAK6rQ8abcdefghijk' }] },
    ];
    // Elasticsearch 的 encoded 是 `id:api_key` 的 base64：检查编码副本，而不只是明文
    expect(recorded(JSON.stringify({ encoded: btoa('id1:LEAK6rQ8') }), 'application/json')).not.toContain(btoa('id1:LEAK6rQ8'));
    expect(recorded('authcode=123456&smscode=LEAK6rQ8', 'application/x-www-form-urlencoded')).not.toMatch(/123456|LEAK6rQ8/);
    expect(recorded('grant_type=interaction_code&interaction_code=LEAK6rQ8', 'application/x-www-form-urlencoded'))
      .not.toContain('LEAK6rQ8');
    for (const body of bodies) expect(recorded(JSON.stringify(body), 'application/json')).not.toContain('LEAK6rQ8');
    expect(recorded(JSON.stringify({ code: 200, status: 'ok' }), 'application/json')).toBe('{"code":200,"status":"ok"}');
    // 字符串形式的 4–8 位数字状态码（`"code": "10000"`）与短信验证码分不开：按验证码打码（宁可多打）
    expect(JSON.parse(recorded(JSON.stringify({ code: '10000' }))).code).toBe(REDACTED);
    // 名字带提示单词但值很短或是普通值时不受影响
    const plain = {
      token_type: 'Bearer',
      tokenName: 'automation',
      keyName: 'key1',
      auth_url: 'https://a.test/oauth/authorize',
      objectKey: 'uploads/2024/a1b2c3d4e5f6g7h8.png',
      jwk: { kty: 'RSA', n: 'pubmodulus', e: 'AQAB' },
    };
    expect(JSON.parse(recorded(JSON.stringify(plain)))).toEqual(plain);
  });

  it('只在参数里敏感的 key / code 出现在 JSON 里时，值像令牌才打码', () => {
    const body = { key: '9054f7aa9305e012b3c2300408c3dfdf390fcdLEAK6rQ8', code: 'LEAK6rQ8LEAK6rQ8x', oobCode: 'LEAK6rQ8' };
    expect(recorded(JSON.stringify(body), 'application/json')).not.toContain('LEAK6rQ8');
    const plain = { code: 'E1001', key: 'Enter', error: { code: 'INVALID_ARGUMENT' }, path: 'uploads/2024/a1b2c3d4e5f6g7h8.png' };
    expect(JSON.parse(recorded(JSON.stringify(plain)))).toEqual(plain);
  });

  it('普通文本与字段不误伤：大模型用量字段、possession 等词、普通的 *_code= 赋值', () => {
    const body = {
      usage: { prompt_tokens: 10, completion_tokens: 2 },
      possession: 55,
      label: 'Password',
      note: 'status_code=200 zip_code=94107',
    };
    expect(JSON.parse(recorded(JSON.stringify(body)))).toEqual(body);
  });

  it('名值对列表与二元数组里，名字敏感时打码对应的值', () => {
    const body = {
      fields: [{ name: 'password', value: 'LEAK6rQ8' }, { name: 'user', value: 'alice' }],
      headers: [['Authorization', 'xLEAK6rQ8'], ['Accept', 'text/html']],
      codes: [['otp', 123456], ['pin', ['4321']]],
      input: { type: 'password', id: 'pw1', value: 'LEAK6rQ8' },
      labeled: { label: 'Password', value: 'LEAK6rQ8' },
      encoded: [{ name: 'p%61ssword', value: 'LEAK6rQ8' }],
      auth: { totp_code: 123456, two_factor_code: 654321, access_tokens: ['LEAK6rQ8'] },
    };
    expect(JSON.parse(recorded(JSON.stringify(body)))).toEqual({
      fields: [{ name: 'password', value: REDACTED }, { name: 'user', value: 'alice' }],
      headers: [['Authorization', REDACTED], ['Accept', 'text/html']],
      codes: [['otp', REDACTED], ['pin', REDACTED]],
      input: { type: 'password', id: 'pw1', value: REDACTED },
      labeled: { label: 'Password', value: REDACTED },
      encoded: [{ name: 'p%61ssword', value: REDACTED }],
      auth: REDACTED,
    });
  });

  it('重复的键：解析只留最后一个，前面的值也不会随原文漏出', () => {
    const dup = '{"next":"https://a.test/?token=LEAK6rQ8","next":"x"}';
    expect(recorded(dup, 'application/json')).not.toContain('LEAK6rQ8');
    expect(recorded('{"u":"password=LEAK6rQ8","u":1}', 'application/x-ndjson')).not.toContain('LEAK6rQ8');
    expect(recorded(JSON.stringify({ inner: dup }), 'application/json')).not.toContain('LEAK6rQ8');
    const multipart = `--B\r\nContent-Disposition: form-data; name="op"\r\nContent-Type: application/json\r\n\r\n${dup}\r\n--B--\r\n`;
    expect(recorded(multipart, 'multipart/form-data; boundary=B')).not.toContain('LEAK6rQ8');
  });

  it('字段名编码后才看得出敏感时，字段名与值一起打码（JSON、multipart）', () => {
    expect(recorded('{"pass%77ord":"LEAK6rQ8"}', 'application/json')).not.toContain('LEAK6rQ8');
    for (const name of ['pass%77ord', 'p%61ssword', 'to%6ben', '%6bey']) {
      const multipart = `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nLEAK6rQ8\r\n--B--\r\n`;
      expect(recorded(multipart, 'multipart/form-data; boundary=B')).not.toContain('LEAK6rQ8');
    }
  });

  it('字段名本身是名值文本时字段名打码', () => {
    expect(recorded('{"password: LEAK6rQ8":1}', 'application/json')).not.toContain('LEAK6rQ8');
    expect(recorded(JSON.stringify({ [JSON.stringify({ password: 'LEAK6rQ8' })]: 1 }), 'application/json')).not.toContain('LEAK6rQ8');
  });

  it('含长数字串、长串 ] 的字段名保持线性耗时', () => {
    const start = performance.now();
    recorded(JSON.stringify({ [`x${'1'.repeat(65536)}z`]: 1 }), 'application/json');
    recorded(JSON.stringify({ [`a${']'.repeat(65500)}!`]: 1 }), 'application/json');
    // 一段里有大量可能是 base64 JSON 起点的位置
    recorded(JSON.stringify({ note: 'e-'.repeat(32768), other: 'eyJ7/'.repeat(13000) }), 'application/json');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('JSON 字符串值里的 URL（如预签名地址）同样打码', () => {
    const body = JSON.stringify({ upload: 'https://s3.test/f?X-Amz-Signature=SIG&X-Amz-Expires=60' });
    const parsed = JSON.parse(recorded(body, 'application/json'));
    expect(parsed.upload).not.toContain('SIG');
    expect(parsed.upload).toContain('X-Amz-Expires=60');
  });

  it('总是重新序列化（紧凑格式）且大整数不丢精度；__proto__ 键保留', () => {
    expect(recorded('{"id":9007199254740993,"token":"S"}', 'application/json'))
      .toBe(`{"id":9007199254740993,"token":"${REDACTED}"}`);
    expect(recorded('{"id":12345678901234567890,  "name":"x"}', 'application/json'))
      .toBe('{"id":12345678901234567890,"name":"x"}');
    const proto = JSON.parse(recorded('{"__proto__":{"a":1},"password":"p"}'));
    expect(Object.keys(proto)).toEqual(['__proto__', 'password']);
    expect(proto.password).toBe(REDACTED);
  });

  it('带防劫持前缀的 JSON 去掉前缀解析、打码后再加回去', () => {
    expect(recorded(`)]}'\n{"token":"S","n":1}`, 'application/json')).toBe(`)]}'\n{"token":"${REDACTED}","n":1}`);
  });

  it('声明为 JSON 却解析不了、超深嵌套导致出错时都不记，不退回原文', () => {
    expect(redactBody('{"password":"LEAK6rQ8",}', 'application/json')).toBeUndefined();
    const deep = `{"access_token":"LEAK6rQ8","x":${'['.repeat(6000)}${']'.repeat(6000)}}`;
    const out = redactBody(deep, 'application/json');
    expect(out === undefined || !out.includes('LEAK6rQ8')).toBe(true);
  });

  it('空正文原样返回', () => {
    expect(redactBody('', 'application/json')).toBe('');
    expect(redactBody('  \n', 'application/json')).toBe('  \n');
  });

  it('表单：按参数名打码（含授权码 code、多值参数、带括号的结构化名字），保持顺序', () => {
    const params = new URLSearchParams(recorded(
      'user=alice&password=p&code=c&tag=a&tag=b&user%5Bauth%5D=S&auth%5Bkey%5D=S',
      'application/x-www-form-urlencoded; charset=UTF-8',
    ));
    expect([...params]).toEqual([
      ['user', 'alice'], ['password', REDACTED], ['code', REDACTED], ['tag', 'a'], ['tag', 'b'],
      ['user[auth]', REDACTED], ['auth[key]', REDACTED],
    ]);
  });

  it('表单类型的 JSON 正文（jQuery 默认）按 JSON 打码', () => {
    const form = 'application/x-www-form-urlencoded; charset=UTF-8';
    expect(JSON.parse(recorded('{"username":"alice","password":"LEAK6rQ8"}', form)))
      .toEqual({ username: 'alice', password: REDACTED });
    expect(recorded('{"access_token":"LEAK6rQ8","x":1}', form)).not.toContain('LEAK6rQ8');
  });

  it('multipart：敏感字段与文件内容不记，JSON 分段按字段打码，其它字段保留', () => {
    const body = [
      '--XyZ',
      'Content-Disposition: form-data; name="username"',
      '',
      'alice',
      '--XyZ',
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2--XyZLEAK6rQ8',
      '--XyZ',
      'Content-Disposition: form-data; name="operations"',
      'Content-Type: application/json',
      '',
      '{"variables":{"password":"P2"}}',
      '--XyZ',
      'Content-Disposition: form-data; name="avatar"; filename="a.png"',
      'Content-Type: image/png',
      '',
      'PNGDATA',
      '--XyZ--',
      '',
    ].join('\r\n');
    const redacted = recorded(body, 'multipart/form-data; boundary=XyZ');
    expect(redacted).toContain('alice');
    for (const secret of ['hunter2', 'LEAK6rQ8', 'P2', 'PNGDATA']) expect(redacted).not.toContain(secret);
  });

  it('multipart：缺字段名、分段头无法解析时整段打码；分段头只重建字段名与类型；前言与尾声丢弃', () => {
    const body = [
      'password=PREAMBLE',
      '--B',
      '',
      'NONAME',
      '--B',
      'Content-Type: text/plain',
      '',
      'TYPEONLY',
      '--B',
      'Content-Disposition: form-data;',
      ' name="password"',
      '',
      'FOLDED',
      '--B',
      'Content-Disposition: form-data; name="note"',
      'Authorization: Bearer HEADLEAK6rQ8',
      'Content-Location: https://a.test/?token=HEADLEAK6rQ8',
      '',
      'hello',
      '--B--',
      'password=EPILOGUE',
    ].join('\r\n');
    const redacted = recorded(body, 'multipart/form-data; boundary=B');
    for (const secret of ['PREAMBLE', 'NONAME', 'TYPEONLY', 'FOLDED', 'HEADLEAK6rQ8', 'EPILOGUE']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('Content-Disposition: form-data; name="note"\r\n\r\nhello');
    expect(redacted.startsWith('--B\r\n')).toBe(true);
    expect(redacted.endsWith('--B--\r\n')).toBe(true);
  });

  it('multipart：重复的字段名 / Content-Disposition、非纯文本类型的分段整段打码；分隔符带凭据迹象整份不记', () => {
    const part = (head: string, body: string) => `--B\r\n${head}\r\n\r\n${body}\r\n--B--\r\n`;
    const cases = [
      part('Content-Disposition: form-data; name="note"; name="password"', 'LEAK6rQ8'),
      part('Content-Disposition: form-data; name="note"\r\nContent-Disposition: form-data; name="password"', 'LEAK6rQ8'),
      part('Content-Disposition: form-data; name="payload"\r\nContent-Type: application/xml', '<password>LEAK6rQ8</password>'),
      part('Content-Disposition: form-data; name="payload"\r\nContent-Type: text/html', '<input name=password value=LEAK6rQ8>'),
    ];
    for (const body of cases) expect(recorded(body, 'multipart/form-data; boundary=B')).not.toContain('LEAK6rQ8');
    const tokenBoundary = '--token=LEAK6rQ8\r\nContent-Disposition: form-data; name="x"\r\n\r\nok\r\n--token=LEAK6rQ8--\r\n';
    expect(redactBody(tokenBoundary, 'multipart/form-data; boundary="token=LEAK6rQ8"')).toBeUndefined();
  });

  it('multipart：quoted-printable / base64 传输编码的分段整段打码', () => {
    for (const [encoding, body] of [['quoted-printable', 'p=61ssword: LEAK6rQ8'], ['base64', btoa('password: LEAK6rQ8')]]) {
      const multipart = `--B\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}\r\n--B--\r\n`;
      const redacted = recorded(multipart, 'multipart/form-data; boundary=B');
      expect(redacted).not.toContain(body);
      expect(redacted).toContain(REDACTED);
    }
  });

  it('multipart：不加引号的 name、filename 在前或里面带 name=、LF 换行、缺结束分隔行都能识别', () => {
    const body = [
      '--B',
      'Content-Disposition: form-data; filename="x; name=foo"; name="token"',
      '',
      'TOK1',
      '--B',
      'Content-Disposition: form-data; name=password',
      '',
      'PW2',
    ].join('\n');
    const redacted = recorded(body, 'multipart/form-data; boundary="B"');
    expect(redacted).not.toContain('TOK1');
    expect(redacted).not.toContain('PW2');
    expect(redactBody('x', 'multipart/form-data')).toBeUndefined();
  });

  it('SSE：CR / CRLF / LF 换行、开头 BOM、跨多行的 data 都能打码；[DONE] 原样保留', () => {
    for (const nl of ['\r\n', '\r', '\n']) {
      const sse = `﻿event: auth${nl}data: {"token":${nl}data: "LEAK6rQ8"}${nl}${nl}data: [DONE]${nl}${nl}`;
      const redacted = recorded(sse, 'text/event-stream');
      expect(redacted).not.toContain('LEAK6rQ8');
      expect(redacted).toContain('event: auth\n');
      expect(redacted).toContain('data: [DONE]');
    }
  });

  it('SSE：不是 JSON 的数据（URL、表单、令牌）整份打码；注释与未知字段丢弃，id 只保留数字', () => {
    const sse = [
      'data: https://a.test/?token=LEAK6rQ8', '',
      'data: password=LEAK6rQ8', '',
      'data: eyJLEAK6rQ8', '',
      ': token=LEAK6rQ8',
      'id: LEAK6rQ8CURSOR',
      'data: {"ok":1}', '',
      'id: 42',
      'retry: 1000',
      'data: [DONE]', '', '',
    ].join('\n');
    const redacted = recorded(sse, 'text/event-stream');
    expect(redacted).not.toContain('LEAK6rQ8');
    expect(redacted).toContain('data: {"ok":1}');
    expect(redacted).toContain('id: 42\nretry: 1000\ndata: [DONE]');
  });

  it('SSE：非数字的 retry 丢弃，带凭据迹象的 event 打码', () => {
    const redacted = recorded('retry: token=LEAK6rQ8\nevent: password=LEAK6rQ8\ndata: {}\n\n', 'text/event-stream');
    expect(redacted).toBe(`event: ${REDACTED}\ndata: {}\n\n`);
  });

  it('NDJSON 按行打码，任何 JSON 值都处理，保留原换行', () => {
    const ndjson = '{"token":"a"}\r\n{"name":"n"}\n"https://a.test/?token=S"';
    const lines = recorded(ndjson, 'application/x-ndjson').split(/\r?\n/);
    expect(JSON.parse(lines[0])).toEqual({ token: REDACTED });
    expect(JSON.parse(lines[1])).toEqual({ name: 'n' });
    expect(lines[2]).not.toContain('=S');
    expect(recorded('{"a":1}\r\n{"b":2}', 'application/x-ndjson')).toBe('{"a":1}\r\n{"b":2}');
  });

  it('未声明类型或 text/plain：JSON、URL 按结构打码；表单没有凭据迹象才原样记录，否则不记', () => {
    expect(recorded('user=Alice Smith&page=2', 'text/plain;charset=UTF-8')).toBe('user=Alice Smith&page=2');
    expect(recorded('username=alice\r\npage=2\r\n', 'text/plain')).toBe('username=alice\r\npage=2\r\n');
    // 值里可以含 & 与换行，分不清范围：整份不记
    expect(redactBody('password=prefix&tail=LEAK6rQ8\r\n', 'text/plain')).toBeUndefined();
    expect(redactBody('note=a\r\npassword=x\r\ncontinuation=LEAK6rQ8\r\n', 'text/plain')).toBeUndefined();
    expect(redactBody('next=https%3A%2F%2Fa.test%2F%3Ftoken%3DLEAK6rQ8', 'text/plain')).toBeUndefined();
    expect(redactBody('api key=LEAK6rQ8', 'text/plain')).toBeUndefined();
    for (const name of ['key', 'ticket', 'tokens', 'secrets', 'pw']) {
      expect(redactBody(`user=a\r\n${name}=LEAK6rQ8\r\n`, 'text/plain')).toBeUndefined();
    }
    expect(JSON.parse(recorded('{"token":"S"}'))).toEqual({ token: REDACTED });
    expect(recorded('https://u:p@LEAK6rQ8@a.test/cb?code=LEAK6rQ8')).not.toContain('LEAK6rQ8');
  });

  it('无法可靠打码的格式不记：HTML、XML、YAML、脚本、GraphQL 原文、无结构文本', () => {
    for (const [text, mime] of [
      ['<input name=password value=LEAK6rQ8>', 'text/html'],
      ['<password>LEAK6rQ8</password>', 'application/xml'],
      ['password: LEAK6rQ8', 'application/x-yaml'],
      ["window.s={accessToken:'LEAK6rQ8'}", 'application/javascript'],
      ['mutation { login(password: "LEAK6rQ8") }', 'application/graphql'],
      ['hello password is LEAK6rQ8', 'text/plain'],
      ['{not json', undefined],
    ] as const) {
      expect(redactBody(text, mime)).toBeUndefined();
    }
  });
});
