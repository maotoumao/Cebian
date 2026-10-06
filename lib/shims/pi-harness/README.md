# pi-harness（vendored 快照）

来源：`@earendil-works/pi-agent-core@0.84.4` 的 `src/harness/`（MIT，© Mario Zechner，许可证全文见同目录 `LICENSE`，上游仓库 https://github.com/earendil-works/pi）。原版 TypeScript 从 npm 包 `dist/*.js.map` 的 `sourcesContent` 无损提取，只做了机械转换：2 空格缩进、单引号、`@/` 绝对导入。

## 为什么要 vendor

pi 1.0.0 删除了整个实验性 harness（Session 层、压缩函数、`session/testing` 子路径、`compactionSummary` 等自定义消息类型），官方推荐的接替者 `@earendil-works/pi-durable` 仍标 Experimental，API 完全不同，也没有浏览器可用的存储后端。

Cebian 的会话树存储（`lib/persistence/session-tree.ts`）和压缩摘要（`lib/agent/compaction.ts`）依赖这部分代码，所以把它冻结在 0.84.4 快照、自行维护；对 pi 只依赖 1.0 承诺稳定的 Agent 核心与 pi-ai。

## 内容

| 文件 | 上游文件 | 保留的内容 |
| --- | --- | --- |
| `session/types.ts` | `harness/session/types.ts` | 全部条目 / 记录 / 查询 / 存储类型与 `SessionError` |
| `session/session.ts` | `harness/session/session.ts` | `Session` 全类与 `assertJsonSerializable` |
| `session/state.ts` | `harness/session/state.ts` | `SessionState` reducer（自研 Dexie 后端用） |
| `session/testing/` | `harness/session/testing/` | 后端一致性套件，只给测试用 |
| `messages.ts` | `harness/messages.ts` | 自定义消息类型、摘要前后缀常量、`convertToLlm` |
| `compaction/compaction.ts` | `harness/compaction/compaction.ts` | `generateSummary` 及其依赖、`DEFAULT_COMPACTION_SETTINGS` |
| `compaction/utils.ts` | `harness/compaction/utils.ts` | `serializeConversation` |
| `types.ts` | `harness/types.ts` | `Result` / `ok` / `err` / `CompactionError` |

## 维护约定

- 这里只放上游代码，不混 Cebian 业务逻辑；需要扩展时在调用方做（例如 `lib/agent/compaction-summary.ts` 对 `CompactionSummaryMessage` 的声明增广）。
- 行为由 `session/testing/conformance.ts` 钉住（经 `lib/persistence/session-tree.test.ts` 运行）。改动本目录必须保持该套件全绿。
- 上游已删除这些文件，升级 pi 时不必再 diff 它们；但要确认这里依赖的 pi 公开 API 没变：pi-ai 的 `uuidv7`、`Models.completeSimple`、`retryAssistantCall`、`contentText` 以及消息 / 模型 / 用量 / 重试相关类型，pi-agent-core 的 `AgentMessage` / `ThinkingLevel` / `CustomAgentMessages`。
- 与上游的任何偏离都记在下面。

## 与上游的偏离

1. 只保留 Cebian 用到的部分（见上表），删掉了 session 上下文构建、切点计算、分支摘要、文件操作追踪、`create*Message` 辅助等未用代码。
2. `session/testing/conformance.ts`：`await using` 改为 `try/finally` 手动调用 `Symbol.asyncDispose`（Node 22 不支持该语法），行为等价。
3. `session/state.ts`：沿用此前从 0.84.1 `dist` 移植、手补类型的版本，与 0.84.4 源码逻辑一致，只有类型标注差异。
4. `messages.ts`：上游 `declare module "../types.ts"` 改为 `declare module '@earendil-works/pi-agent-core'`，把四种自定义消息注册进 pi 1.0 的 `CustomAgentMessages`（pi 1.0 自身已不再注册）。
