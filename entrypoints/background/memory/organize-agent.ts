// 临时整理 agent 的工厂（背景层编排，故住在 entrypoints/background/memory/——
// createCebianAgent 在 background 的 agent/factory.ts，lib/ 不可反向 import 它）。
// 即用即弃、不登记为 session：跑完 agent_end 由编排层（organize-manager）丢弃。
//
// 安全：作用域由 beforeToolCall 硬锁在 staging 副本目录，整理 agent 连 live 记忆都碰不到；
// 工具集只给「读 + 在 staging 内改」的最小 fs 集（无 save_url / run_skill / 浏览器 / MCP）。

import type {
  Agent,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createCebianAgent } from '../agent/factory';
import { fsListTool } from '@/lib/tools/fs-list';
import { fsReadFileTool } from '@/lib/tools/fs-read-file';
import { fsCreateFileTool } from '@/lib/tools/fs-create-file';
import { fsEditFileTool } from '@/lib/tools/fs-edit-file';
import { fsDeleteTool } from '@/lib/tools/fs-delete';
import { fsRenameTool } from '@/lib/tools/fs-rename';
import { ORGANIZE_INSTRUCTIONS } from '@/lib/memory/prompt';
import { isWithinStaging, organizePathArgs } from '@/lib/memory/organize-scope';
import { CEBIAN_MEMORIES_STAGING_DIR } from '@/lib/persistence/vfs-paths';

/** 整理 agent 的最小 fs 工具集：读 + 列 + 在 staging 内创建/编辑/删除/重命名。 */
const ORGANIZE_TOOLS = [
  fsListTool,
  fsReadFileTool,
  fsCreateFileTool,
  fsEditFileTool,
  fsDeleteTool,
  fsRenameTool,
];

/**
 * 构造 beforeToolCall 门禁：整理 agent 的每一个 fs 路径参数都必须落在 stagingRoot 内，
 * 否则 block（含 `../` 逃逸防护，见 isWithinStaging）。这是「作用域锁死」的硬执行点。
 */
export function createStagingScopeGate(stagingRoot: string) {
  return async (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const paths = organizePathArgs(
      context.toolCall.name,
      context.args as Record<string, unknown>,
    );
    for (const p of paths) {
      if (!isWithinStaging(p, stagingRoot)) {
        return {
          block: true,
          reason: `Out of scope: memory consolidation may only touch ${stagingRoot}; refusing path ${p}`,
        };
      }
    }
    return undefined;
  };
}

/**
 * 创建临时整理 agent：给定模型，系统提示词为 ORGANIZE_INSTRUCTIONS，工具仅最小 fs 集，
 * 作用域锁死 staging。运行（subscribe + prompt + await agent_end）由编排层负责。
 */
export function createOrganizeAgent(model: Model<Api>): Agent {
  return createCebianAgent({
    model,
    systemPrompt: ORGANIZE_INSTRUCTIONS,
    thinkingLevel: 'medium',
    tools: ORGANIZE_TOOLS,
    beforeToolCall: createStagingScopeGate(CEBIAN_MEMORIES_STAGING_DIR),
  });
}
