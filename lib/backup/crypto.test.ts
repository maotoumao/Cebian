import { describe, it, expect } from 'vitest';
import { encryptPayload, decryptPayload } from '@/lib/backup/crypto';
import { bytesToBase64, base64ToBytes } from '@/lib/utils';
import type { BackupEncryptionMeta } from '@/lib/backup/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 在 Uint8Array 中查找子序列，避免用 TextDecoder 把任意密文字节当 UTF-8 比较。 */
function bytesInclude(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 测试专用：用指定迭代次数直接走 WebCrypto 加密，得到一份合法密文 + meta，
 *  用于验证 decrypt 真的读取 meta.iterations 而非硬编码。 */
async function encryptWithIterations(
  plaintext: Uint8Array,
  password: string,
  iterations: number,
): Promise<{ ciphertext: Uint8Array; meta: BackupEncryptionMeta }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext as BufferSource,
  );
  return {
    ciphertext: new Uint8Array(buf),
    meta: {
      algo: 'AES-GCM',
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
  };
}

describe('备份负载加密 / 解密', () => {
  it('正确口令往返还原出原文', async () => {
    const plaintext = enc.encode('会话内容 + API Key 的混合负载 🔒');
    const { ciphertext, meta } = await encryptPayload(plaintext, 'correct horse');
    const out = await decryptPayload(ciphertext, 'correct horse', meta);
    expect(dec.decode(out)).toBe('会话内容 + API Key 的混合负载 🔒');
  });

  it('空负载也能正确往返', async () => {
    const { ciphertext, meta } = await encryptPayload(new Uint8Array(0), 'pw');
    const out = await decryptPayload(ciphertext, 'pw', meta);
    expect(out.length).toBe(0);
  });

  it('meta 含 AES-GCM / PBKDF2 / SHA-256 与 base64 的 salt、iv', async () => {
    const { meta } = await encryptPayload(enc.encode('x'), 'pw');
    expect(meta.algo).toBe('AES-GCM');
    expect(meta.kdf).toBe('PBKDF2');
    expect(meta.hash).toBe('SHA-256');
    expect(meta.iterations).toBeGreaterThanOrEqual(100_000);
    expect(base64ToBytes(meta.salt).length).toBe(16);
    expect(base64ToBytes(meta.iv).length).toBe(12);
  });

  it('密文中不出现明文字节片段', async () => {
    const secret = enc.encode('sk-very-secret-token');
    const { ciphertext } = await encryptPayload(secret, 'pw');
    expect(bytesInclude(ciphertext, secret)).toBe(false);
  });

  it('错误口令解密失败（抛错，不返回半解密数据）', async () => {
    const { ciphertext, meta } = await encryptPayload(enc.encode('secret'), 'right');
    await expect(decryptPayload(ciphertext, 'wrong', meta)).rejects.toThrow();
  });

  it('密文被篡改时解密失败（GCM 认证标签不匹配）', async () => {
    const { ciphertext, meta } = await encryptPayload(enc.encode('secret'), 'pw');
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptPayload(tampered, 'pw', meta)).rejects.toThrow();
  });

  it('每次加密生成不同的 salt 与 iv（同口令同明文密文也不同）', async () => {
    const plaintext = enc.encode('same');
    const a = await encryptPayload(plaintext, 'pw');
    const b = await encryptPayload(plaintext, 'pw');
    expect(a.meta.salt).not.toBe(b.meta.salt);
    expect(a.meta.iv).not.toBe(b.meta.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('解密使用 meta 中记录的迭代次数（非默认值也能解密）', async () => {
    // 用非默认迭代次数构造密文：若 decrypt 硬编码 600k，此处必然解密失败。
    const fixture = await encryptWithIterations(enc.encode('payload'), 'pw', 150_000);
    const out = await decryptPayload(fixture.ciphertext, 'pw', fixture.meta);
    expect(dec.decode(out)).toBe('payload');
  });
});

describe('解密前的 meta 校验（防篡改 / DoS）', () => {
  async function validFixture(): Promise<{ ciphertext: Uint8Array; meta: BackupEncryptionMeta }> {
    return encryptPayload(enc.encode('payload'), 'pw');
  }

  it('不支持的算法被拒绝', async () => {
    const { ciphertext, meta } = await validFixture();
    const bad = { ...meta, algo: 'DES' as unknown as BackupEncryptionMeta['algo'] };
    await expect(decryptPayload(ciphertext, 'pw', bad)).rejects.toThrow(/Unsupported/);
  });

  it('超大迭代次数被拒绝（防 DoS）', async () => {
    const { ciphertext, meta } = await validFixture();
    const bad = { ...meta, iterations: 1_000_000_000 };
    await expect(decryptPayload(ciphertext, 'pw', bad)).rejects.toThrow(/iterations/);
  });

  it('过小迭代次数被拒绝', async () => {
    const { ciphertext, meta } = await validFixture();
    const bad = { ...meta, iterations: 10 };
    await expect(decryptPayload(ciphertext, 'pw', bad)).rejects.toThrow(/iterations/);
  });

  it('畸形的 salt 长度被拒绝', async () => {
    const { ciphertext, meta } = await validFixture();
    const bad = { ...meta, salt: bytesToBase64(new Uint8Array(8)) };
    await expect(decryptPayload(ciphertext, 'pw', bad)).rejects.toThrow(/salt length/);
  });

  it('畸形的 iv 长度被拒绝', async () => {
    const { ciphertext, meta } = await validFixture();
    const bad = { ...meta, iv: bytesToBase64(new Uint8Array(4)) };
    await expect(decryptPayload(ciphertext, 'pw', bad)).rejects.toThrow(/iv length/);
  });
});
