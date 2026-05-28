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
 * 把 Uint8Array 编码成 base64。逐块切片避免 `String.fromCharCode(...bytes)`
 * 在大数组（>~120 KB）触发 stack overflow。
 */
function bytesToBase64(bytes: Uint8Array): string {
  // 32 KB —— 远低于 V8 默认 arg 数上限，保证 fromCharCode.apply 不会爆栈。
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 把可能含 Uint8Array / ArrayBuffer / TypedArray 视图的值打包成 JSON-safe 形态。
 * 顶层是二进制 → 包成 wrapper；其他类型原样返回。
 *
 * **`Blob` / `File` 明确不支持**：它们的实际字节是异步取的（`await blob.arrayBuffer()`），
 * 这里为了保持同步接口不能默默 await。以前是“原样返回”→ chrome.runtime.sendMessage
 * 会把 Blob 序列化成空对象 `{}` → 上游报个迷糊的 "must be string/Uint8Array/..."，
 * 是默默数据腐败。现在直接报错，提示调用方先 `await blob.arrayBuffer()`。
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
  // Blob / File 不允许默默通过 —— 会被 JSON 敁成空对象，造成难调的默默损坏。
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
