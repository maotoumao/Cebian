/**
 * Background-side RPC layer for communicating with the sandbox page.
 * Path: background → chrome.runtime.sendMessage → offscreen → postMessage → sandbox
 * Reverse: sandbox → postMessage → offscreen → chrome.runtime.sendMessage → background
 */

import { ensureOffscreen } from './offscreen';
import { executeViaDebugger } from '@/lib/tab-helpers';
import { isChromeCallAllowed } from './chrome-api-whitelist';
import { vfs } from '@/lib/vfs';
import { isVfsCallAllowed, resolveScopedPath, sessionSkillRoot } from './vfs-whitelist';
import { decodeBinaryArgs, encodeBinary } from '@/lib/sandbox-binary';

// ─── Pending run requests ───

/** Per-run state. `vfsRoot` / `permissions` are kept on the trusted side
 *  so that `handleVfsCall` looks them up by `id` instead of trusting the
 *  sandbox-supplied envelope — a malicious skill cannot forge its scope
 *  or claim a permission it wasn't granted. */
interface PendingRun {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  vfsRoot: string | null;
  permissions: string[];
}

const pendingRuns = new Map<string, PendingRun>();

// ─── Handle messages from sandbox (via offscreen relay) ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith('sandbox:')) return false;

  switch (message.type) {
    case 'sandbox:run_result': {
      const pending = pendingRuns.get(message.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingRuns.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }
      }
      return false;
    }

    case 'sandbox:chrome_call': {
      handleChromeCall(message).catch(err => console.error('[sandbox-rpc] chrome_call error:', err));
      return false;
    }

    case 'sandbox:page_exec': {
      handlePageExec(message).catch(err => console.error('[sandbox-rpc] page_exec error:', err));
      return false;
    }

    case 'sandbox:vfs_call': {
      handleVfsCall(message).catch(err => console.error('[sandbox-rpc] vfs_call error:', err));
      return false;
    }
  }

  return false;
});

async function handleChromeCall(msg: {
  id: string; callId: string; namespace: string; method: string; args: unknown[];
}): Promise<void> {
  let result: unknown;
  let error: string | undefined;

  try {
    if (!isChromeCallAllowed(msg.namespace, msg.method)) {
      throw new Error(`Chrome API call not allowed: chrome.${msg.namespace}.${msg.method}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (chrome as any)[msg.namespace];
    if (!ns) throw new Error(`Unknown chrome namespace: ${msg.namespace}`);

    if (typeof ns[msg.method] !== 'function') {
      throw new Error(`Not a function: chrome.${msg.namespace}.${msg.method}`);
    }

    result = await ns[msg.method](...msg.args);
  } catch (err) {
    error = (err as Error).message;
  }

  // Send result back to sandbox via offscreen
  await chrome.runtime.sendMessage({
    type: 'sandbox:chrome_result',
    id: msg.id,
    callId: msg.callId,
    result,
    error,
  }).catch(() => {});
}

async function handlePageExec(msg: {
  id: string; callId: string; code: string; tabId?: number;
}): Promise<void> {
  let resultText: string | undefined;
  let error: string | undefined;

  try {
    if (msg.tabId == null) {
      throw new Error('executeInPage requires a tabId. Re-invoke run_skill with an explicit tabId parameter (read it from the [Active Tab] block in the context).');
    }
    resultText = await executeViaDebugger(msg.tabId, msg.code);
  } catch (err) {
    error = (err as Error).message;
  }

  await chrome.runtime.sendMessage({
    type: 'sandbox:page_exec_result',
    id: msg.id,
    callId: msg.callId,
    result: resultText,
    error,
  }).catch(() => {});
}

// ─── VFS proxy handler ───
// 把 skill 脚本里 `vfs.<method>(rel, ...)` 路由到真正的 lib/vfs。所有路径
// 走 resolveScopedPath 限定在该 run 的 vfsRoot 内（由 run-skill 启动时
// 算定 + pendingRuns 里持有），sandbox 自己不能影响作用域。
// `stat` 的返回值带方法，结构化克隆会丢，需要 flatten 成纯对象。
async function handleVfsCall(msg: {
  id: string;
  callId: string;
  method: string;
  args: unknown[];
}): Promise<void> {
  let result: unknown;
  let error: string | undefined;

  try {
    // 反查权威 scope / permissions —— sandbox 那侧的 message envelope 不可信。
    const pending = pendingRuns.get(msg.id);
    if (!pending) {
      throw new Error('vfs call has no matching pending run (timed out or replayed)');
    }
    if (!pending.vfsRoot) {
      // 不可达分支：sandbox 例以未声明 vfs.* 权限时根本不会构造 vfs proxy，走
      // 到这里说明中间某一不可信环节被篡改。报出 internal 标记以免 agent 把这
      // 当成可操作的提示传回用户。
      throw new Error('internal: vfs call received without scope (sandbox-rpc / offscreen relay tampering)');
    }
    if (!isVfsCallAllowed(msg.method, pending.permissions)) {
      throw new Error(`vfs.${msg.method} not allowed (requires vfs.read or vfs.write permission)`);
    }
    if (!Array.isArray(msg.args) || msg.args.length === 0) {
      throw new Error(`vfs.${msg.method} requires at least a path argument`);
    }

    // `chrome.runtime.sendMessage` 在 offscreen → background 这一跳走 JSON
    // 序列化，sandbox 一侧已经把 Uint8Array / ArrayBuffer 包成 base64 信封；
    // 这里逐项还原成原生 Uint8Array 再传给 vfs。
    const callArgs = decodeBinaryArgs(msg.args);
    const rel = callArgs[0];
    const absPath = resolveScopedPath(rel, pending.vfsRoot);

    switch (msg.method) {
      case 'readFile': {
        // encoding 参数原样透传给 vfs.readFile —— 支持 `'utf8'` / undefined /
        // `{ encoding: 'utf8' }` 三种形式（跟 Node `fs.promises` 一致）。不法的
        // encoding 由 lightning-fs / vfs 底层报 EINVAL，不在这一层扫语义。
        result = await vfs.readFile(absPath, callArgs[1] as 'utf8' | { encoding?: 'utf8' } | undefined);
        break;
      }
      case 'writeFile': {
        // skill 常见数据来源：`new TextEncoder().encode(...)` → Uint8Array，
        // `await response.arrayBuffer()` → ArrayBuffer。两种都接，前者已是
        // Uint8Array 直接走；后者包一层视图。string 直接透传。任何另外的
        // `opts` （第三个参）也透传给 vfs.writeFile，不在这里收藏。
        const data = callArgs[1];
        let normalized: string | Uint8Array;
        if (typeof data === 'string' || data instanceof Uint8Array) {
          normalized = data;
        } else if (data instanceof ArrayBuffer) {
          normalized = new Uint8Array(data);
        } else {
          throw new Error('vfs.writeFile data must be a string, Uint8Array, or ArrayBuffer');
        }
        await vfs.writeFile(absPath, normalized, callArgs[2] as 'utf8' | { encoding?: 'utf8'; mode?: number } | undefined);
        result = undefined;
        break;
      }
      case 'mkdir': {
        // Caller 传入的 opts 透传给 vfs.mkdir；未传时默认 `{ recursive: true }`
        // 跟项目其他 fs 工具（fs_mkdir / writeFile 自动建父目录）体验一致；
        // 显式传 `{ recursive: false }` 能被用来探测目录存在。
        const mkdirOpts = (callArgs[1] as { recursive?: boolean; mode?: number } | undefined) ?? { recursive: true };
        await vfs.mkdir(absPath, mkdirOpts);
        result = undefined;
        break;
      }
      case 'readdir': {
        result = await vfs.readdir(absPath);
        break;
      }
      case 'stat': {
        const st = await vfs.stat(absPath);
        // Flatten —— 方法属性结构化克隆会丢。
        result = {
          size: st.size,
          mtimeMs: st.mtimeMs,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
        };
        break;
      }
      case 'exists': {
        result = await vfs.exists(absPath);
        break;
      }
      case 'unlink': {
        await vfs.unlink(absPath);
        result = undefined;
        break;
      }
      default:
        throw new Error(`Unknown vfs method: ${msg.method}`);
    }
  } catch (err) {
    error = (err as Error).message;
  }

  await chrome.runtime.sendMessage({
    type: 'sandbox:vfs_result',
    id: msg.id,
    callId: msg.callId,
    // 反向同样要过 JSON 通道 —— readFile 在二进制模式下返回 Uint8Array，
    // 这里包成 base64 信封，sandbox 一侧用 decodeBinary 还原。
    result: encodeBinary(result),
    error,
  }).catch(() => {});
}

// ─── Public API ───

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Execute a skill script in the sandbox page.
 * Manages the full lifecycle: ensure offscreen → send to sandbox → await result.
 *
 * `skill` + `sessionId` 由 run-skill.ts 注入。如果 permissions 含 vfs.* 任一档，
 * 这里一次性算出该 run 的 `vfsRoot`，存到 pendingRuns 里给 `handleVfsCall`
 * 反查 —— sandbox 自己不持有/不能伪造作用域。
 */
export async function runInSandbox(
  code: string,
  args: Record<string, unknown>,
  permissions: string[],
  skill: string,
  sessionId: string,
  tabId?: number,
): Promise<unknown> {
  await ensureOffscreen();

  const id = crypto.randomUUID();

  // 计算 vfsRoot —— 只有在显式声明了 vfs.* 时才有意义。
  // 校验失败（无效 sessionId / 无效 skill）直接抛，否则错误会延迟到 skill 调用
  // vfs.* 时才暴露，调试更难。
  const wantsVfs = permissions.includes('vfs.read') || permissions.includes('vfs.write');
  const vfsRoot = wantsVfs ? sessionSkillRoot(sessionId, skill) : null;

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRuns.has(id)) {
        pendingRuns.delete(id);
        reject(new Error('Sandbox execution timed out (5 min)'));
      }
    }, SANDBOX_TIMEOUT_MS);

    pendingRuns.set(id, { resolve, reject, timeoutId, vfsRoot, permissions });
  });

  // Send to offscreen (which relays to sandbox iframe)
  try {
    await chrome.runtime.sendMessage({
      type: 'sandbox:run',
      id,
      code,
      args,
      permissions,
      // sandbox 只用 vfsRoot 来暴露 `vfs.cwd`；真正的作用域校验在 background。
      vfsRoot,
      tabId,
    });
  } catch (err) {
    const pending = pendingRuns.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingRuns.delete(id);
    }
    throw err;
  }

  return resultPromise;
}
