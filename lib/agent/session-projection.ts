/**
 * 会话树 ↔ 线性消息的双向映射。
 *
 * 投影方向（`projectEntries` / `entriesToMessages`）：把一条分支上的 entry 序列
 * 还原成 `AgentMessage[]`，供 agent 水合（`agent.state.messages`）、IPC 广播与 UI
 * 渲染共用——三者看到同一个数组。LLM 边界的过滤 / 折叠仍由 convertToLlm /
 * transformContext 负责，本投影不做 LLM 裁剪。
 *
 * 写入方向（`messageToEntryBody`）：一条消息在树上的 entry 形态（去掉
 * id / seq / parentId / timestamp 的 body），是投影的逆映射，被两处共用：
 * - 运行时追加（session-store 的 append 入口）；
 * - v1→v2 迁移（lib/persistence/migrate-messages.ts，自行补 id / seq / 时间戳）。
 * round-trip 无损不变式由 migrate-messages.test.ts 钉死（compactionSummary 的
 * 脏字段会在写入方向被归一化，见该文件头注）。
 *
 * 各 entry 类型的投影：
 * - `message` → 原样透出（含 user / assistant / toolResult 与未知自定义 role）；
 * - `compaction` → 一条 `compactionSummary` 自定义消息；非空 `retainedTail`
 *   会挂回消息（transformContext 依赖它重建「摘要 + 保留区」的 LLM 视图），
 *   entry 之前的原文消息仍在链上，故 retainedTail 不展开成独立消息；
 * - `custom(permissionRequest)` → 一条 `permissionRequest` 消息；若其后有对应的
 *   `custom(permissionDecision)` entry（append-only 的决策回写），折叠最新决策；
 * - `custom(permissionDecision)` → 不单独成消息（已折叠，也不占 entryIds 位）；
 * - `model_change` / `thinking_level_change` / `active_tools_change` /
 *   `branch_summary` → 不进消息流（分支摘要的呈现由分支导航子任务另行处理）。
 */
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { getRetainedTail, isCompactionSummary, type CompactionSummaryMessage } from './compaction';
import {
  isPermissionRequest,
  PERMISSION_DECISION_CUSTOM_TYPE,
  PERMISSION_REQUEST_CUSTOM_TYPE,
  type PermissionDecisionEntryData,
  type PermissionRequestEntryData,
  type PermissionRequestMessage,
} from './tool-permissions';

/** 投影结果：`messages[i]` 由 `entryIds[i]` 对应的 entry 产出（两数组等长对齐）。
 *  编排层靠这份对齐把「数组下标语义」（重试截断、消息编辑）翻译成树操作
 *  （moveLane 到目标 entry）。 */
interface ProjectedBranch {
  messages: AgentMessage[];
  entryIds: string[];
}

/** 一条消息在树上的 entry 形态（不含 id / seq / parentId / timestamp 的 body）。 */
type EntryBody =
  | { type: 'message'; message: AgentMessage }
  | { type: 'compaction'; summary: string; retainedTail: AgentMessage[]; tokensBefore: number }
  | { type: 'custom'; customType: string; data: unknown };

/** 消息 → entry body（投影的逆映射，归一化 compactionSummary 的脏字段）。 */
function messageToEntryBody(msg: AgentMessage): EntryBody {
  if (isCompactionSummary(msg)) {
    return {
      type: 'compaction',
      summary: typeof msg.summary === 'string' ? msg.summary : '',
      retainedTail: getRetainedTail(msg),
      tokensBefore: Number.isFinite(msg.tokensBefore) ? msg.tokensBefore : 0,
    };
  }
  if (isPermissionRequest(msg)) {
    const { role: _role, ...data } = msg;
    return { type: 'custom', customType: PERMISSION_REQUEST_CUSTOM_TYPE, data };
  }
  return { type: 'message', message: msg };
}

function projectEntries(entries: readonly Entry[]): ProjectedBranch {
  // 决策折叠索引：同一 toolCallId 取最后一条 decision（正常只会有一条）
  const decisions = new Map<string, PermissionDecisionEntryData>();
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === PERMISSION_DECISION_CUSTOM_TYPE) {
      const data = entry.data as PermissionDecisionEntryData;
      if (data && typeof data.toolCallId === 'string') decisions.set(data.toolCallId, data);
    }
  }

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case 'message':
        messages.push(entry.message);
        entryIds.push(entry.id);
        break;
      case 'compaction': {
        const summary: CompactionSummaryMessage = {
          role: 'compactionSummary',
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: entry.timestamp,
          ...(entry.retainedTail.length > 0 ? { retainedTail: entry.retainedTail } : {}),
        };
        messages.push(summary);
        entryIds.push(entry.id);
        break;
      }
      case 'custom': {
        if (entry.customType !== PERMISSION_REQUEST_CUSTOM_TYPE) break;
        const data = entry.data as PermissionRequestEntryData;
        // 与 decision 侧同款防御：畸形 entry（data 缺失）跳过，不让整次水合投影抛错
        if (!data || typeof data.toolCallId !== 'string') break;
        const resolved = decisions.get(data.toolCallId);
        const message: PermissionRequestMessage = {
          role: 'permissionRequest',
          ...data,
          ...(resolved ? { decision: resolved.decision } : {}),
        };
        messages.push(message);
        entryIds.push(entry.id);
        break;
      }
      default:
        break;
    }
  }
  return { messages, entryIds };
}

/** 只要消息数组的便捷形态（测试 / 不需要 entry 对齐的消费者）。 */
function entriesToMessages(entries: readonly Entry[]): AgentMessage[] {
  return projectEntries(entries).messages;
}

/** 一个分支点的信息（挂在当前分支的 entry 上）：该 entry 在其兄弟中的位置与
 *  全部兄弟 id（seq 序）。UI 据此渲染「‹ 2/3 ›」切换器并发起 switch_branch。 */
interface BranchEntryInfo {
  index: number;
  count: number;
  siblings: string[];
}

/** entry 是否会投影成一条消息（必须与 projectEntries 的产出口径一致，含其对
 *  畸形 permissionRequest 的防御跳过）。分支兄弟只数这类 entry——decision /
 *  model_change 等不可见 entry 不该撑大「2/3」的分母，投影为空的畸形 entry 也
 *  不该成为切过去一片空白的「幽灵分支」。 */
function isProjectableEntry(entry: Entry): boolean {
  if (entry.type === 'message' || entry.type === 'compaction') return true;
  if (entry.type !== 'custom' || entry.customType !== PERMISSION_REQUEST_CUSTOM_TYPE) return false;
  const data = entry.data as PermissionRequestEntryData;
  return !!data && typeof data.toolCallId === 'string';
}

/**
 * 计算当前分支上所有分支点的信息：对分支上的每个 entry，若其 parent 名下有
 * ≥2 个可投影兄弟（retry 产生的并列回复 / 编辑产生的并列提问），记录它在兄弟
 * 中的位置。稀疏结构——无分支的 entry 不出现。
 *
 * @param allEntries 整棵树的 entry（oldestFirst，即 seq 序）
 * @param branchEntryIds 当前分支的投影对齐表（projectEntries 的 entryIds）
 */
function buildBranchInfo(
  allEntries: readonly Entry[],
  branchEntryIds: readonly string[],
): Record<string, BranchEntryInfo> {
  const byId = new Map<string, Entry>();
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of allEntries) {
    byId.set(entry.id, entry);
    if (!isProjectableEntry(entry)) continue;
    const bucket = childrenByParent.get(entry.parentId);
    if (bucket) bucket.push(entry);
    else childrenByParent.set(entry.parentId, [entry]);
  }
  const info: Record<string, BranchEntryInfo> = {};
  for (const id of branchEntryIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    const siblings = childrenByParent.get(entry.parentId) ?? [];
    if (siblings.length < 2) continue;
    const index = siblings.findIndex((s) => s.id === id);
    if (index < 0) continue;
    info[id] = { index, count: siblings.length, siblings: siblings.map((s) => s.id) };
  }
  return info;
}

// ─── Public API ───

export { buildBranchInfo, entriesToMessages, messageToEntryBody, projectEntries };
export type { BranchEntryInfo, EntryBody, ProjectedBranch };
