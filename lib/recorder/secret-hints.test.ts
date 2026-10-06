import { describe, expect, it } from 'vitest';
import { hasSecretHints, isSensitiveName } from './secret-hints';

describe('isSensitiveName', () => {
  it.each([
    'password', 'user_password', 'newPassword', 'password_confirmation', 'password1', 'new_password2',
    'passwd', 'passphrase', 'pass', 'pwd', 'pin', 'otp', 'auth', 'jwt', 'assertion', 'client_assertion',
    'code_verifier', 'oauth_verifier', 'SAMLResponse', 'device_code',
    'token', 'access_token', 'refreshToken', 'id_token', 'csrf_token', 'X-CSRF-Token', 'x-token', 'private-token',
    'secret', 'client_secret', 'clientSecret', 'x-hasura-admin-secret', 'api_key', 'apiKey', 'apikey',
    'session', 'session_id', 'sessionId', 'sid', 'PHPSESSID', 'JSESSIONID', 'session_key',
    'private_key', 'credentials', 'X-Amz-Credential', 'signature', 'X-Amz-Signature', 'oauth_signature',
    'secret_key', 'AWS_SECRET_KEY', 'X-Auth-Key', 'Ocp-Apim-Subscription-Key', 'DD-APPLICATION-KEY', 'app_key',
    'client_key', 'signing_key', 'encryption_key', 'master_key', 'license_key', 'laravel_session',
    '_gitlab_session', 'X-Firebase-AppCheck', 'basic_auth', 'otp_code', 'mfa_code', 'sms_code', 'auth_code', 'totp',
    'totp_code', 'two_factor_code', '2fa_code', 'access_tokens', 'tokens', 'X-Forwarded-Authorization', 'X-Supabase-Auth',
    'pw', 'user_pw', 'new_pw', 'passwort', 'privkey', 'priv_key', 'oobCode', 'token_hash', 'SAMLart', '_wpnonce',
    'X-WP-Nonce', 'hmac', 'newPwd', 'oldPwd', 'loginPwd', 'payPwd', 'userPass', 'new_pass', 'confirm_pass', 'passwrd',
    'pass1-text', 'neues_passwort', 'passwort_wiederholen', 'nova_senha', 'mot_de_passe', 'contrasena', 'wachtwoord',
    'kennwort', 'sessionInfo', 'temporaryProof', 'SMS_MFA_CODE', 'SOFTWARE_TOKEN_MFA_CODE', 'EMAIL_OTP_CODE',
    'recovery_codes', 'backup_codes', 'unused_codes', 'recovery_code', 'login_ticket', 'verify_code', 'checkCode',
    'signedRequest', 'SECRET_HASH', 'user_code', 'stateHandle', 'interactionHandle', 'ConfirmationCode', 'resetCode',
    'session_code', 'SecretCode', 'SecretString', 'sharedSecret', 'pinCode', 'contraseña', 'authcode', 'smscode',
    'verifycode', 'statehandle', 'usercode', 'two-factor-email-code', 'binding_code', 'ChallengeResponses', 'apiKeys',
  ])('%s 视为敏感', (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each([
    'keyword', 'keywords', 'author', 'authors', 'country_code', 'zipcode', 'promo_code_hint',
    'tokenizer', 'secretary', 'passage', 'compass', 'session_count', 'key', 'sort', 'username', 'email', 'id',
    'content-type', 'x-request-id', 'sec-websocket-key', 'monkey', 'sort_key', 'possession', 'obsession',
    'prompt_tokens', 'max_tokens', 'token_type', 'auth_url', 'bypass', 'surpass', 'passenger_count',
  ])('%s 不视为敏感', (name) => {
    expect(isSensitiveName(name)).toBe(false);
  });

  it('OAuth 授权码 code 只在 URL 参数 / 表单里算敏感，JSON 字段里不算', () => {
    expect(isSensitiveName('code', 'param')).toBe(true);
    expect(isSensitiveName('code', 'field')).toBe(false);
    expect(isSensitiveName('key', 'param')).toBe(true);
    expect(isSensitiveName('key', 'field')).toBe(false);
    expect(isSensitiveName('ticket', 'param')).toBe(true);
  });

  it('tokens 这类词只在完整名字里敏感，自由文本里的同一个词不算', () => {
    expect(isSensitiveName('tokens', 'field')).toBe(true);
    expect(isSensitiveName('tokens', 'word')).toBe(false);
  });
});

describe('hasSecretHints', () => {
  it.each([
    'password.hunter', 'pi_3MtwLEAK6rQ8_secret_YrKJ', 'Basic YTpi', 'mysql --password=LEAK6rQ8',
    'key=LEAK6rQ8', `${btoa('{"alg":"HS256"}').replace(/=+$/, '')}.e30.LEAK6rQ8`,
    'recovery codes: LEAK6rQ8', 'password/Hunter2', `eyJ${'a'.repeat(5000)}.e30.LEAK6rQ8`, 'contraseña: LEAK6rQ8',
    'smscode 123456',
  ])('%s 有凭据迹象', (text) => {
    expect(hasSecretHints(text)).toBe(true);
  });

  it.each([
    'refresh_token', 'Authorization', 'pw1', 'basic information', 'status_code=200', 'auth/invalid-email',
    'Request failed, error code: 500', `${btoa('{"foo":"bar"}').replace(/=+$/, '')}.e30.LEAK6rQ8`,
  ])('%s 没有凭据迹象', (text) => {
    expect(hasSecretHints(text)).toBe(false);
  });
});
