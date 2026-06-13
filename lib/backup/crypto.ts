// 备份负载的口令加密。
//
// 算法：AES-GCM-256，口令派生用 PBKDF2(SHA-256)。每次加密生成随机 salt（派生
// 密钥用）与随机 IV（GCM 用），二者非敏感、随明文 manifest 一起保存，恢复时据此
// 重新派生密钥。口令本身不存储；口令错误时 GCM 认证标签不匹配 → decrypt 抛错。

import { bytesToBase64, base64ToBytes } from '@/lib/utils';
import type { BackupEncryptionMeta } from './types';

/** PBKDF2 迭代次数。与 manifest 中的 `iterations` 对应，解密时从 manifest 读取
 *  实际值，因此未来调大不影响旧包解密。 */
const PBKDF2_ITERATIONS = 600_000;
/** salt 字节数（PBKDF2）。 */
const SALT_BYTES = 16;
/** IV 字节数（AES-GCM 推荐 12）。 */
const IV_BYTES = 12;
/** 派生密钥长度（bit）。 */
const KEY_LENGTH_BITS = 256;
/** 可接受的迭代次数下限——低于此值视为不安全 / 被篡改的弱化攻击。 */
const MIN_ITERATIONS = 100_000;
/** 可接受的迭代次数上限——防止恶意 manifest 用超大迭代次数让 PBKDF2 卡死（DoS）。 */
const MAX_ITERATIONS = 5_000_000;

/** 加密结果：密文字节 + 可写入 manifest 的明文元信息（含 base64 的 salt/iv）。 */
export interface EncryptResult {
  ciphertext: Uint8Array;
  meta: BackupEncryptionMeta;
}

/**
 * 校验来自 manifest 的加密元信息。恢复时 `meta` 来自外部备份文件的 JSON，
 * TypeScript 的字面量类型不约束运行时输入——恶意 / 损坏的 manifest 可能给出
 * 不支持的算法、畸形的 salt/iv 长度，或一个超大的 `iterations` 让 PBKDF2 派生
 * 卡死（restore-time DoS）。在派生密钥前严格校验，否则抛出面向恢复流程的错误。
 *
 * 返回已解码且校验过长度的 salt / iv，避免调用方重复解码。
 */
function validateMeta(meta: BackupEncryptionMeta): { salt: Uint8Array; iv: Uint8Array } {
  if (meta.algo !== 'AES-GCM' || meta.kdf !== 'PBKDF2' || meta.hash !== 'SHA-256') {
    throw new Error(
      `Unsupported backup encryption: algo=${meta.algo} kdf=${meta.kdf} hash=${meta.hash}`,
    );
  }
  if (
    !Number.isSafeInteger(meta.iterations) ||
    meta.iterations < MIN_ITERATIONS ||
    meta.iterations > MAX_ITERATIONS
  ) {
    throw new Error(`Invalid backup encryption iterations: ${meta.iterations}`);
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  try {
    salt = base64ToBytes(meta.salt);
    iv = base64ToBytes(meta.iv);
  } catch {
    throw new Error('Malformed backup encryption salt/iv (not valid base64)');
  }
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Invalid backup encryption salt length: ${salt.length}`);
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid backup encryption iv length: ${iv.length}`);
  }
  return { salt, iv };
}

/** 从口令 + salt + 迭代次数派生一把 AES-GCM 密钥。 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 用口令加密 `plaintext`，返回密文与 manifest 加密元信息。salt / iv 随机生成，
 * 放进 meta（base64），非敏感。
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  password: string,
): Promise<EncryptResult> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );

  return {
    ciphertext: new Uint8Array(buf),
    meta: {
      algo: 'AES-GCM',
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
  };
}

/**
 * 用口令解密。salt / iv / 迭代次数来自 manifest 的 `meta`。口令错误或密文被篡改
 * 时，AES-GCM 认证失败，`crypto.subtle.decrypt` 抛 `OperationError` —— 调用方据此
 * 提示「口令错误或备份损坏」，且不会得到任何半解密数据。
 */
export async function decryptPayload(
  ciphertext: Uint8Array,
  password: string,
  meta: BackupEncryptionMeta,
): Promise<Uint8Array> {
  const { salt, iv } = validateMeta(meta);
  const key = await deriveKey(password, salt, meta.iterations);

  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(buf);
}
