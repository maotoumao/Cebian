// 记忆整理的后台编排（background 层：创建/运行临时整理 agent，故住此处，不可放 lib/）。
//
// 事务（staging 副本 + 提交时比对）：
//   1. 恢复：清理上次崩溃残留（planRecovery）。
//   2. 复制 live → staging，记录复制时刻 live 指纹 M0。
//   3. 整理 agent 只在 staging 里干（作用域硬锁）。
//   4. 机器校验整理结果（守记忆文件格式不变量），不过则丢弃。
//   5. 提交门控：重扫 live 指纹；M_now ≠ M0（运行期间用户写了记忆）→ 丢弃（前台赢）。
//   6. 提交：写 .committing 标记 → 用 staging 替换 live → 删标记 → 清 staging。
//   7. 记下上次成功整理时间，写入 memoryOrganizeState（UI 响应式读取）。
//
// 并发正确性靠机制本身：live 全程不被整理碰；提交只在指纹完全没变时发生，故任何「已完成
// 的并发写」都会让指纹变化而触发丢弃，零数据丢失。残留：提交步的 replaceLiveWithStaging
// 是「rm live → mkdir → 逐文件 copy」的**非原子**替换，整个替换期间若有并发写落在 live，
// 可能被删/覆盖/混入——但整理低频、且已完成的写都被门控丢弃，故接受此残留窗口（不引入
// 写屏障，保持 fs 工具与 vfs 对记忆概念无感）。单飞行由模块级 `organizing` 保证（防双击）。

import type { Api, Model, AssistantMessage } from '@earendil-works/pi-ai';
import { vfs } from '@/lib/persistence/vfs';
import {
  CEBIAN_MEMORIES_DIR,
  CEBIAN_MEMORIES_STAGING_DIR,
  CEBIAN_MEMORIES_COMMIT_MARKER,
} from '@/lib/persistence/vfs-paths';
import {
  copyDirInto,
  readDirManifest,
  readDirFiles,
  removeDir,
  replaceLiveWithStaging,
} from '@/lib/memory/staging-fs';
import { liveChangedSince, planRecovery } from '@/lib/memory/organize-plan';
import { shouldRunOrganize, countNewMemories } from '@/lib/memory/organize-schedule';
import { validateOrganized } from '@/lib/memory/organize-validate';
import { MEMORY_INDEX_FILE_CAPACITY } from '@/lib/memory/index-scan';
import {
  memorySettings,
  memoryOrganizeState,
  resolveOrganizeSettings,
  lastSelectedModel,
  providerCredentials,
  customProviders,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';
import { createOrganizeAgent } from './organize-agent';
import { agentManager } from './agent-manager';

const LIVE = CEBIAN_MEMORIES_DIR;
const STAGING = CEBIAN_MEMORIES_STAGING_DIR;
const MARKER = CEBIAN_MEMORIES_COMMIT_MARKER;

/** 整理结果。`ok` = 已提交；其余是各种「没落地」的原因（无数据变更）。 */
export type OrganizeOutcome =
  | { status: 'ok' }
  | { status: 'skipped'; reason: 'already-running' | 'no-model' | 'empty' | 'rejected' | 'conflict' | 'failed' };

/** 单飞行标志：同一 SW 内同时只允许一个整理（手动双击 / 自动重入都挡）。 */
let organizing = false;

/** 当前是否有整理在跑（供 IPC handler 同步判断，避免对「已在跑」的二次点击误广播 idle）。 */
export function isOrganizing(): boolean {
  return organizing;
}

// ─── 启动崩溃恢复 ───

/** 记忆化的启动恢复 promise：启动时跳一次，runOrganize 也 await 同一个，避免重叠。 */
let recoveryPromise: Promise<void> | null = null;

/**
 * 清理上次未收尾的整理（须早于任何记忆读写/注入）。记忆化：多次调用只跑一次，
 * 启动与 runOrganize 共用同一 promise，不会并发重叠。
 * - 无 staging → 无事。
 * - staging 无 .committing → 上次崩在提交前，live 没动 → 删 staging。
 * - staging 有 .committing → 上次崩在替换中途 → 幂等重做替换，再删标记与 staging。
 */
export function recoverOrganizeOnStartup(): Promise<void> {
  recoveryPromise ??= doRecover();
  return recoveryPromise;
}

async function doRecover(): Promise<void> {
  const [stagingExists, markerExists] = await Promise.all([
    vfs.exists(STAGING),
    vfs.exists(MARKER),
  ]);
  const action = planRecovery(stagingExists, markerExists);
  if (action === 'discardStaging') {
    await removeDir(STAGING);
  } else if (action === 'redoCommit') {
    await replaceLiveWithStaging(STAGING, LIVE);
    await vfs.rm(MARKER, { force: true });
    await removeDir(STAGING);
  }
}

// ─── 模型解析 ───

/** 解析整理用模型：organize.model 优先，缺省回退全局 lastSelectedModel。无可用配置 → null。 */
async function resolveOrganizeModel(): Promise<Model<Api> | null> {
  const [settings, globalModel, creds, customProvs] = await Promise.all([
    memorySettings.getValue(),
    lastSelectedModel.getValue(),
    providerCredentials.getValue(),
    customProviders.getValue(),
  ]);
  const modelCfg = resolveOrganizeSettings(settings).model ?? globalModel;
  if (!modelCfg) return null;
  return resolveModel(modelCfg, creds, customProvs ?? []) ?? null;
}

// ─── 跑整理 agent 到结束，判断是否成功 ───

/** 跑整理 agent；返回是否成功（最后一条 assistant 的 stopReason 不是 error/aborted）。
 *  fileCount 是当前记忆档数，连同当前日期一起注入 prompt——让 agent（1）按今天转相对
 *  日期，（2）按「离上限还有多远」客观判断该不该为省空间而跨主题合并。 */
async function runOrganizeAgent(model: Model<Api>, fileCount: number): Promise<boolean> {
  const agent = createOrganizeAgent(model);
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  // pi-agent-core 的 prompt() 跑完整 agent 循环、在 agent_end 处 resolve（即使运行失败也
  // 不抛，而是追加一条 stopReason='error'/'aborted' 的 assistant 消息）。
  await agent.prompt(
    `Consolidate the memory files now. The current date is ${today} — use it to convert any relative dates to absolute ones. ` +
      `There are currently ${fileCount} memory files; the index comfortably holds about ${MEMORY_INDEX_FILE_CAPACITY}, so unless you are near that, keep distinct topics in separate files and only de-duplicate same-topic entries.`,
  );
  const msgs = agent.state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      const m = msgs[i] as AssistantMessage;
      // 运行出错/被中断 → 不可信任 staging（可能只改了一半），标为失败。
      return m.stopReason !== 'error' && m.stopReason !== 'aborted';
    }
  }
  // 连一条 assistant 都没有 → 异常，当失败处理。
  return false;
}

// ─── 结果落库 ───

/**
 * 写入 memoryOrganizeState（独立结果态存储项；只有本 manager 写它，单飞行 → 读改写无竞态，
 * 也不会覆盖用户在 memorySettings 改的配置）：
 * - 提交成功 → 更 lastAttemptAt + lastRunAt。
 * - 未提交（冲突/校验不过/失败）→ 只更 lastAttemptAt（供退避调度）。
 */
async function persistResult(opts: { committed: boolean }): Promise<void> {
  const cur = await memoryOrganizeState.getValue();
  const now = Date.now();
  const next = opts.committed
    ? { ...cur, lastAttemptAt: now, lastRunAt: now }
    : { ...cur, lastAttemptAt: now };
  await memoryOrganizeState.setValue(next);
}

// ─── 主流程 ───

/**
 * 跑一次整理。返回 OrganizeOutcome。失败/冲突/校验不过/空，均不改 live、不丢数据。
 * keepalive 包住全程（临时 agent 不在 session map、不自动续 MV3 keepalive）。
 */
export async function runOrganize(): Promise<OrganizeOutcome> {
  if (organizing) return { status: 'skipped', reason: 'already-running' };
  organizing = true;
  acquireKeepAlive();
  try {
    // 1. 清理上次残留（与启动恢复共用同一记忆化 promise，不重叠）。
    await recoverOrganizeOnStartup();

    // 2. 解析模型。
    const model = await resolveOrganizeModel();
    if (!model) return { status: 'skipped', reason: 'no-model' };

    // 3. 复制 live → staging；记录复制时刻 live 指纹。live 不存在则视为空、无可整理。
    if (!(await vfs.exists(LIVE))) return { status: 'skipped', reason: 'empty' };
    // 先抓 m0 再复制：复制过程中若有写入，m0 ≠ 提交时的 M_now → 一并触发丢弃。
    const m0 = await readDirManifest(LIVE);
    if (Object.keys(m0).length === 0) return { status: 'skipped', reason: 'empty' };
    await copyDirInto(LIVE, STAGING);

    // 4. 整理 agent 在 staging 干活。运行出错/中断 → 不提交（staging 可能只改了一半）。
    if (!(await runOrganizeAgent(model, Object.keys(m0).length))) {
      await removeDir(STAGING);
      await persistResult({ committed: false });
      return { status: 'skipped', reason: 'failed' };
    }

    // 5. 校验整理结果（守不变量），不过则丢弃。
    const afterFiles = await readDirFiles(STAGING);
    const files = Object.entries(afterFiles).map(([name, content]) => ({ name, content }));
    if (!validateOrganized(files).ok) {
      await removeDir(STAGING);
      await persistResult({ committed: false });
      return { status: 'skipped', reason: 'rejected' };
    }

    // 6. 提交门控：live 自复制时起变过 → 用户写了记忆 → 丢弃（前台赢）。
    if (liveChangedSince(m0, await readDirManifest(LIVE))) {
      await removeDir(STAGING);
      await persistResult({ committed: false });
      return { status: 'skipped', reason: 'conflict' };
    }

    // 7. 提交：标记 → 替换 → 删标记 → 清 staging。
    await vfs.writeFile(MARKER, '');
    await replaceLiveWithStaging(STAGING, LIVE);
    await vfs.rm(MARKER, { force: true });
    await removeDir(STAGING);

    // 8. 记上次整理时间（UI 响应式读取）。
    await persistResult({ committed: true });
    return { status: 'ok' };
  } finally {
    organizing = false;
    releaseKeepAlive();
  }
}

// ─── 自动调度（chrome.alarms 周期检查） ───

const ALARM_NAME = 'memory-organize-check';
// 每 6 小时检查一次（检查廉价，满足条件才真整理、才花 token）。
const CHECK_INTERVAL_MINUTES = 6 * 60;

/**
 * 周期检查「该不该自动整理」：记忆开 + auto 开 + 决策函数过（够久/够多/空闲/非退避）
 * 才调 runOrganize。任一不满足即短路返回，不动 live。
 */
async function maybeAutoOrganize(): Promise<void> {
  const settings = await memorySettings.getValue();
  if (!settings.enabled) return;
  const policy = resolveOrganizeSettings(settings);
  if (!policy.auto) return;

  const [state, manifest] = await Promise.all([
    memoryOrganizeState.getValue(),
    readDirManifest(LIVE),
  ]);
  const ok = shouldRunOrganize(policy, {
    now: Date.now(),
    lastRunAt: state.lastRunAt,
    lastAttemptAt: state.lastAttemptAt,
    newMemoryCount: countNewMemories(manifest, state.lastRunAt),
    hasActiveSession: agentManager.hasActiveSession(),
  });
  if (ok) await runOrganize();
}

/** 注册自动整理的周期 alarm（仿 setupOAuthRefresh）。启动时调一次。 */
export function setupOrganizeSchedule(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    maybeAutoOrganize().catch((err) => console.warn('[organize] auto check failed:', err));
  });
}
