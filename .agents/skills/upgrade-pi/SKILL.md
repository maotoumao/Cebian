---
name: upgrade-pi
description: 升级pi-agent-core和pi-ai到最新版本
---

帮我调研一下 @earendil-works/pi-agent-core 和 @earendil-works/pi-ai 的最新更新，深入调研我目前安装的版本和最新版本之间的更新内容和细节，确认后，和我讨论能否进行升级。

这是一次**调研 + 讨论**任务：默认**不要**改 [package.json](../../../package.json) 或跑安装命令，讨论确认后再动。

## 变更查询来源（按优先级）

这两个包同属 pi monorepo（`github.com/earendil-works/pi`），**变更日志在仓库里，不在 npm release notes**，逐版本读、别只看最新一版：

- pi-ai：`packages/ai/CHANGELOG.md` → https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md
- pi-agent-core：`packages/agent/CHANGELOG.md` → https://github.com/earendil-works/pi/blob/main/packages/agent/CHANGELOG.md
- 发布节奏 / 日期交叉印证（npm 版本历史）：
  - https://www.npmjs.com/package/@earendil-works/pi-ai?activeTab=versions
  - https://www.npmjs.com/package/@earendil-works/pi-agent-core?activeTab=versions

两个 CHANGELOG 都遵循 Keep a Changelog（`Breaking Changes / Added / Changed / Fixed / Removed`）。重点抓 `Breaking Changes`。

## 硬性约束（务必遵守）

1. **两个包锁步升级到同一版本**。lockfile 里 pi-agent-core 依赖同版本 pi-ai；只升其中一个会造成版本错配。
2. **`typebox` 跟随 pi，绝不单独升**。本项目 [package.json](../../../package.json) 把 `typebox` **精确锁死**（无 `^`），就是为了和 pi 内部捆绑的 typebox 完全一致——两边 `TSchema` 类型标识必须是同一份，否则本项目用 `Type.Object(...)` 造出来的 schema 传给 pi 校验会类型不兼容，还可能产生两份 typebox 副本。
   - 升级 pi 后，去 [pnpm-lock.yaml](../../../pnpm-lock.yaml) 查 pi 实际解析的 `typebox` 版本；**只有当它变了**，才把项目的 `typebox` 精确 pin 改成同一版本。
   - 参考：pi 的 typebox 迁移发生在 0.69.0（`@sinclair/typebox` 0.34.x → `typebox` 1.x）；0.86.0 起精确依赖 `typebox 1.3.27`。
3. 本项目实际用法（评估破坏性变更时以这些为准）：
   - `Type` / `Static` / `TSchema`：[lib/tools/*](../../../lib/tools)、[lib/mcp/client.ts](../../../lib/mcp/client.ts) 里的 `typebox/value` 校验器。
   - agent runtime：[hooks/useBackgroundAgent.ts](../../../hooks/useBackgroundAgent.ts)、[lib/agent/](../../../lib/agent)、`AgentTool` 协议（tool 抛错=失败、返回=成功）。

4. **会话树与压缩依赖的 harness 已 vendor，不随 pi 升级**。pi 1.0.0 删除了整个实验性 harness（Session 层、压缩函数、`session/testing`、`compactionSummary` 等自定义消息类型），本项目把用到的部分冻结在 0.84.4 快照，放在 [lib/shims/pi-harness/](../../../lib/shims/pi-harness)（原因、偏离与维护约定见其 README）。升级 pi 时：
   - 不必再 diff 上游 harness（上游已不存在），但要按 README「维护约定」核对它依赖的 pi 公开 API（`uuidv7`、`Models.completeSimple`、`retryAssistantCall`、`contentText`、消息类型、`CustomAgentMessages` 等）没有变。
   - vendored conformance 套件（经 [lib/persistence/session-tree.test.ts](../../../lib/persistence/session-tree.test.ts) 运行）必须保持全绿。

5. **系统提示词与工具不进 `agent.state`**。pi 0.86 起把系统提示词和工具声明作为 transcript 里的 `role: 'system'` 消息传递；本项目让 `agent.state.messages` 保持纯对话流（会话树的水位线 / 下标对齐依赖这一点），由 [entrypoints/background/agent/factory.ts](../../../entrypoints/background/agent/factory.ts) 的 `prepareRequest` 按 `AgentPreamble` 在每次请求前现装 system 头。升级 pi 时：
   - 重点读 agent-loop 的 `declareToolChanges`、`prepareRequest`、`prepareNextTurn`（Agent 选项名为 `prepareNextTurnWithContext`）、`finishTurn` 有没有改语义或时序。
   - [factory.test.ts](../../../entrypoints/background/agent/factory.test.ts) 会兜住「每次请求都有头、system 消息永不进 state」这条不变式，必须保持全绿。

6. **版本范围用 `~`**。`package.json` 里两个包写 `~x.y.z`（只放行 patch），minor 升级必须走本流程，避免一次 `pnpm install` 悄悄带进破坏性变更并与精确 pin 的 `typebox` 错位。

7. **已知上游行为**（已核实至 1.0.0，后续升级时重新核对）：Copilot 下的 GPT-6 Sol / Luna 可选「关闭思考」，但 Responses 适配器对 `github-copilot` 不发送 `effort: "none"`，由 Copilot 服务端决定；Copilot 的 Gemini 条目 `supportsReasoningEffort: false`，思考档不生效。

## 工作流

1. `pnpm outdated` 看两个包的 Current / Latest。
2. 逐版本读上面两个 CHANGELOG（把 Current→Latest 之间每个版本都覆盖到），重点抓 `Breaking Changes` 和公开 API 改动。
3. 交叉验证：CHANGELOG 与 npm 版本历史日期是否一致；破坏性变更是否命中本项目实际用法（别人眼里的 breaking 我们可能没用到）。
4. 给结论 + 和我讨论：能否升、要不要顺带动 `typebox`（按上面约束判断）、升级后需要手动回归哪些链路（发消息 / 流式思考 / 工具调用 / 中止 abort / 模型切换 / 压缩 / 分支回卷）。默认**不改 package.json**，确认后再动。
