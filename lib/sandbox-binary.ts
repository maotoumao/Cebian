/**
 * Binary envelope for sandbox ↔ background RPC.
 *
 * MV3 `chrome.runtime.sendMessage` 在 offscreen ↔ background 这一跳走 JSON 序列化，
 * 不是 structured clone —— 因此 `Uint8Array` / `ArrayBuffer` / `ArrayBufferView`
 * 中途会被压成 `{0:0xNN, 1:..., ...}` 的普通对象，`instanceof Uint8Array` 失效。
 *
 * 这里提供一对透明的 wrap / unwrap，在跨进程边界把二进制塞进 `{__cebianBin: '<b64>'}`
 * 信封里走 JSON 通道，落地另一端再还原成 `Uint8Array`。两侧（sandbox/main.ts
 * 和 sandbox-rpc.ts）共用同一份实现，避免编解码漂移。
 *
 * 仅扫描数组顶层元素（vfs.writeFile / readFile 等用法足够），不递归深嵌套对象 ——
 * 既能覆盖现有用例，又避免对普通 JSON 对象徒增 walk 成本。
 */

import { bytesToBase64, base64ToBytes } from '@/lib/utils';

const BIN_MARKER = '__cebianBin';

interface BinaryWrapper {
  readonly [BIN_MARKER]: string;
}

function isBinaryWrapper(v: unknown): v is BinaryWrapper {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { [BIN_MARKER]?: unknown })[BIN_MARKER] === 'string'
  );
}

/**
 * 把可能含 Uint8Array / ArrayBuffer / TypedArray 视图的值打包成 JSON-safe 形态。
 * 顶层是二进制 → 包成 wrapper；其他类型原样返回。
 *
 * **`Blob` / `File` 明确不支持**：它们的实际字节是异步取的（`await blob.arrayBuffer()`），
 * 这里为了保持同步接口不能隐式 await。早期实现是「原样返回」→ chrome.runtime.sendMessage
 * 会把 Blob 序列化成空对象 `{}` → 上游报一个含糊的 "must be string/Uint8Array/..."，
 * 属于静默数据损坏。现在直接抛错，提示调用方先做 `await blob.arrayBuffer()`。
 */
export function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BIN_MARKER]: bytesToBase64(value) } satisfies BinaryWrapper;
  }
  if (value instanceof ArrayBuffer) {
    return { [BIN_MARKER]: bytesToBase64(new Uint8Array(value)) } satisfies BinaryWrapper;
  }
  // 覆盖 Int8Array / DataView 等 ArrayBufferView：统一按底层字节看。
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      [BIN_MARKER]: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    } satisfies BinaryWrapper;
  }
  // Blob / File 不允许静默通过 —— 会被 JSON 压成空对象，造成难定位的数据损坏。
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    throw new Error(
      'Cannot pass a Blob/File through sandbox RPC. Convert it first: ' +
      '`const bytes = new Uint8Array(await blob.arrayBuffer());`',
    );
  }
  return value;
}

/** 反向：见到 `{__cebianBin: 'b64'}` 信封就还原为 Uint8Array；其他类型原样返回。 */
export function decodeBinary(value: unknown): unknown {
  if (isBinaryWrapper(value)) {
    return base64ToBytes(value[BIN_MARKER]);
  }
  return value;
}

/** 数组版本：用在 RPC `args: unknown[]` 这种场景，逐项 encode/decode。 */
export function encodeBinaryArgs(args: readonly unknown[]): unknown[] {
  return args.map(encodeBinary);
}

export function decodeBinaryArgs(args: readonly unknown[]): unknown[] {
  return args.map(decodeBinary);
}
