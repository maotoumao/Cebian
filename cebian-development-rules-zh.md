# Cebian 开发规则

这些规则是本仓库中所有 AI 编码 Agent 的唯一事实来源（Single Source of Truth），包括 Claude Code、GitHub Copilot、Codex，以及其他任何编码 Agent。Claude Code 通过 `CLAUDE.md` 导入此文件；Copilot 和 Codex 会直接发现此文件。规则只允许在这里修改，禁止在任何平台适配器中单独修改。

规范的 Agent Skills 位于 `.agents/skills/`；`.claude/skills/` 和 `.github/skills/` 仅包含平台适配器。Claude Code 或 Copilot 中通过 `/<skill-name>` 调用可复用工作流，在 Codex 中通过 `$<skill-name>` 调用。参考型 Skill（例如 `i18n-naming` 和 `shadcn`）按需加载。不要把这些 Skill 与顶层 `skills/` 目录混淆，后者会随扩展一起发布，是产品本身的功能。

## 组件与依赖复用

- 编写新代码之前，始终优先复用已有组件和库。先搜索代码库。
- 缺少 UI 组件时，优先通过 shadcn/ui 添加（`shadcn` Skill 可用）。
- 引入第三方依赖之前，先检查 WXT 是否提供内置模块或推荐集成方式（参见 https://wxt.dev）。优先使用 WXT 生态中的包，而不是通用替代方案。

## 先规划再执行

所有任务都必须遵循 Plan-First 流程：

1. **先规划再行动** —— 编写任何代码之前，制定实现计划，列出所有步骤、需要修改的文件以及预期结果。
2. **等待批准** —— 将计划展示给用户，**在用户明确批准之前不得继续**。禁止基于未批准的计划开始编码。
3. **批准后执行** —— 只有用户明确确认（例如 `approved`、`go ahead`、`looks good`）后才能开始实现。
4. **范围变化需要重新批准** —— 如果中途发现计划需要重大变化，停止，展示修改后的计划，并再次等待批准。

如果 Harness 提供专门的规划模式（如 Claude Code 的 plan mode），应使用它，因为它会强制执行步骤 1～3。没有规划模式时，手动执行相同流程：写出计划，然后停止。

## 任务执行工作流

计划获批后，必须严格按照每个子任务的 Gate 循环执行。**禁止批量执行多个子任务或跳过步骤。**

> **🛑 每个子任务完成后必须强制停止（不可协商）。**
>
> 一个子任务完成“实现 + `code-review` + 测试说明”后，**必须立即结束本轮并等待用户**。
>
> 同一轮不得：
> - 开始下一个子任务；
> - 规划下一个子任务；
> - 搭建或预先实现下一个子任务；
> - 为下一个子任务提前重构；
> - 以任何形式“提前做一点”。
>
> 即使用户已经说“都做”“按顺序处理”“继续”，或者批准了整个计划，也必须遵守。整体批准只批准**计划**，不等于批准每一个子任务的 Gate。每个后续子任务仍需要单独的明确批准，例如 `next`、`approved`、`通过`、`下一个`。
>
> 如果准备在同一轮开始第二个子任务，或者认为“用户显然希望全部完成”而继续，就是违规。停止并把控制权交还给用户。不确定某项操作是否属于新的子任务时，默认视为新的子任务并停止。

### 1. 拆分子任务

将批准后的计划拆成具体、可独立验证的子任务，并在 Harness 的 todo/task list 中跟踪，使用户可以看到进度。

### 2. 一次一个任务

一次只能将一个子任务标记为 `in-progress`，只完成该子任务，不能开始后续任务。

### 3. 每个任务完成后进行代码审查

完成一个子任务的实现后，立即运行当前 Harness 专用只读 Reviewer 中的 `code-review` workflow。只审查当前子任务，并处理发现的问题。

如果 Reviewer 提出的修复、重构或设计变更超出原批准计划范围（例如提取新的共享模块、重构无关文件、改变既有模式），必须停止并向用户说明建议、原因和拟议修改，等待明确批准。

只有当前子任务范围内的 Bug、死代码、当前子任务文件中的拼写错误等问题，可以无需再次确认直接修复。

### 4. 提供测试说明

代码审查通过后，给用户明确、具体的手动验证步骤：打开什么、点击什么、应该看到什么、Console 应出现什么、如何判断成功。然后停止等待。

### 5. 等待测试反馈

用户仍在测试当前子任务或存在未解决问题时，不得开始下一子任务。先回答问题并处理当前子任务反馈。

### 6. 等待明确批准

只有用户明确批准当前子任务（例如 `approved`、`next`、`looks good`、`passed`、`通过`）后，才能将其标记完成并进入下一子任务。沉默、简单回应或无关消息都不算批准。

### 7. 重复

进入下一子任务后，从第 2 步重新开始。

如果子任务证明计划错误，停止并重新触发 Plan-First 重新批准流程，不得继续推进。

## Changelog Gate

当整个任务（而不是每个子任务）相对于最近已发布版本产生最终用户可见差异时，在报告完成前必须按照 Changelog 章节的规则，在 `CHANGELOG.md` 的 `## [Unreleased]` 中追加条目。

纯内部重构、测试、构建、依赖升级可以不记录。当前 `[Unreleased]` 中引入又在发布前修复的问题，如果最近发布版本并不存在该问题，不应单独记录为 Bug Fix；若最终仍存在用户可见差异，只记录最终行为。

## 架构验证

编写代码之前，必须验证代码放置位置和结构：

- 这是该逻辑正确的文件/目录吗？
- 是否遵循现有项目约定（`components/`、`hooks/`、`lib/`、`entrypoints/`）？
- 是否需要重构现有模块？如果需要，先提出重构计划再实现。
- 避免为一次性操作创建不必要的抽象、Helper 或 Wrapper 文件。

### 内聚、耦合与文件大小

- **高内聚** —— 每个文件/模块只关注一个职责，不要混合 UI、IO 和业务规则。
- **低耦合** —— 遵守 `entrypoints/`、`components/`、`hooks/`、`lib/` 的既有分层。阅读 import 理解依赖方向，不要引入反向或跨层依赖。
- **文件大小信号** —— 单文件超过约 300 行时，应评估是否沿清晰边界拆分。这是信号而非硬规则；高内聚的长文件可以保留，职责混杂的短文件也应拆分。不要为了设计而设计。

### 命名与模块 API

- **根据做什么命名，而不是怎么做。** `fillMissing` 优于 `restoreMerge`；`collectStorage` 优于任何提及 Dexie / `chrome.storage` 的名字。transport、backend、`viaBackground`、IPC 等实现细节不应出现在公共名称中。
- **根据值是什么命名，而不是它在某个调用者中的角色。** `turn`（每轮模型/消息携带的 thinking）优于 `override`；`identity` 优于 `requested`。控制流角色由比较值的代码表达。
- **删除无信息量的后缀。** `Obj` / `Data` / `Info` / `Result` 不增加含义。`resolveModel` 优于 `resolveModelObj`；`model` 优于 `modelData`。
- **名称冲突时让层级可见。** 页面侧 IPC 入口 `restoreSessions` 与 background 侧纯决策 `planSessionWrites` 应区分层级，不要让两个 `restore*` 看起来处于同一层级。执行上下文不明显时用注释说明。
- **平行模块使用统一动词词汇。** 兄弟模块做相同工作时使用相同动词模式，例如每个 backup source 都提供 `collect<Source>` / `restore<Source>`。
- **按事物而不是方向组织。** 按数据源 / 领域实体拆文件，每个文件同时包含两个方向，例如每个 `lib/backup/sources/*.ts` 都同时有 collect 和 restore，而不是按操作拆分。
- **一个概念对应一个类型。** 不要把一个概念拆成近似重复类型，例如将 `VfsMultiRootGroup` + `VfsSingleRootGroup` 合并为 `VfsRootGroup { roots: string[] }`。
- **名称不再符合现实就立即重命名。** 从“当前模型”泛化为“任意模型身份”后，应改成 `ModelIdentity` 而不是 `ActiveModel`。但持久化 key 或 wire-protocol field 是外部契约：可以重命名 JS export，不能重命名底层 `local:...` storage key 或协议字段，否则会破坏已有数据和向后兼容。
- **Exports 放在文件底部。** 类型和内部 Helper 在前，公共 API 在后。一个文件服务多个受众时按受众分组。
- **保持最小导出面。** 最后一个跨文件调用者消失后立即取消 export。更窄的公共 API 更容易重构，也更能表达真正共享的内容。

## `lib/` 内部组织

`lib/` 按**概念**而非**执行上下文**组织。跨 background 和 UI、通过 IPC 连接的概念保持在同一目录中，不要拆成 `background/` 与 `ui/`。执行上下文应体现在文件名而不是目录名。

### 新增 lib 文件的判断树

1. **只被一个 entrypoint 使用且不可复用？** → 放到 `entrypoints/<ctx>/`，不要放到 `lib/`。
2. **纯工具，没有 Cebian 领域概念、没有平台绑定，可从 bg/UI/content/sandbox 任意位置导入？** → 放到 `lib/` 根目录。这也是为什么根目录只有 `utils.ts` 和 `i18n.ts`。
3. **属于已有概念？** → 放入对应概念目录，并在文件名中表达执行上下文：
   - 裸文件名 / `types.ts` / `client.ts`：跨 context 共享；
   - `*-channel.ts`：UX 侧 IPC 入口，仅 UI 导入；
   - `manager.ts`：background 侧 orchestration，仅 background 导入。
4. **新概念？** → 只有当它拥有至少 2 个内聚文件时才创建文件夹。单文件概念保持单文件，放在最近的概念目录或根目录；出现第二个 context-specific 文件后再升级为文件夹。
5. **Domain content**（system prompts、注入的 preamble 文本、绑定某概念的配置表）应跟随所属概念，绝不能放入通用 `constants.ts` 大杂烩。项目有意不存在 `lib/constants.ts`。

### 当前概念 / 能力目录

| 目录 | 概念 / 能力 | Import 边界 |
| --- | --- | --- |
| `agent/` | 对话运行时：attachments、message parsing、compaction、tool-permissions | — |
| `providers/` | AI Provider 连接：oauth、custom-models、registry | — |
| `ipc/` | 跨 context 消息：protocol、instance-id、sandbox-binary | — |
| `persistence/` | 数据持久化：db、vfs、storage、vfs-paths | platform: IndexedDB / chrome.storage |
| `browser/` | Chrome / CDP / 页面注入：tab-actions、mobile-emulation、element-picker | content scripts 禁止导入 |
| `ui/` | 依赖 `document` / React / toast：dialog、clipboard | background 禁止导入 |
| `content/` | 文件格式 Helper：mime、frontmatter、pdf-loader | pure |
| `page-actions/` | 悬浮球 / 划词工具条的动作配置与消息契约，由内容脚本、侧边栏、background 共用 | — |
| `search/` | 联网搜索引擎配置与抽取契约，由 `web_search` 工具和设置页共用；默认引擎脚本随概念走 | — |
| `ai-config/` | AI 配置 | — |
| `backup/` | 备份 | — |
| `mcp/` | MCP | — |
| `recorder/` | 录制 | — |
| `tools/` | 工具 | — |
| `shims/` | 第三方补丁，不属于我们的概念 | — |

`persistence/`、`browser/`、`ui/`、`content/` 属于 capability folders（能力目录），目录名本身编码 import-direction 规则。Reviewer 可以仅通过 import 路径发现违规，例如 `entrypoints/background/*` 导入 `@/lib/ui/*` 就是错误的。

## 代码注释

- 新增或修改的注释优先使用中文，其次使用英文。
- 必要技术术语（API 名称、库名、协议字段、错误码等）保持英文，不要强行翻译。
- 规则只针对新增或修改的注释。不要给未修改代码补注释，也不要批量翻译已有英文注释。

## 工具失败处理

Cebian 的 Agent Tools（`lib/tools/*`）实现 `@earendil-works/pi-agent-core` 的 `AgentTool`。协议是字面意义上的：**失败时 throw，成功时 return。**

### 真正的错误 → `throw new Error(<message>)`

网络错误、无效输入、资源不存在、权限拒绝、解析失败等真正错误必须：

```ts
throw new Error(<message>)
```

`pi-agent-core` 会设置 `message.isError = true`，进而进入 LLM payload 的 `is_error: true`，让模型触发 retry / replan。`Error.message` 是 LLM 唯一能看到的信息，因此应写得可操作。

### 空结果 → 成功 return

以下属于空结果：

- 0 个搜索结果；
- 空目录；
- 0 个匹配元素；
- PDF 没有文本层；
- Chrome API 返回 `undefined`。

这些情况应成功 return，并提供描述性内容。判断标准是：“Agent 能否基于该结果合理继续？”能 → return；不能 → throw。

### 禁止把错误重新编码成成功

不要把真正的异常 catch 后包装成成功结果。这样会破坏 `isError` 信号。

`try/catch` 本身没有问题，只要 catch 最终仍然 throw。常见合法用途：

- 将 `URL` constructor 异常翻译成 “Invalid URL: ...”；
- 将 `parseFrontmatter` 异常翻译成 “Failed to parse SKILL.md: ...”；
- 在 `mcp-tool.ts` 中将 `ThrottleError` 翻译为更友好的提示；
- 保留 `AbortError` / `signal.aborted` 的 rethrow，使 pi-agent-core 的 cancellation contract 正常触发，例如 `fs-save-url.ts` 的 fetch handshake catch。

`try/finally` 可用于资源清理，例如 reader locks、abort listeners、tab-restore。

### 页面注入函数

`chrome.scripting.executeScript` 注入的函数可能返回 `"Error: ..."` sentinel，而不是 throw，因为 Chrome 会吞掉页面内部 rejection。

调用 Tool 必须在 extension 层检测这个 sentinel，并将其转换为真正的 throw。参考 `interact.ts` 中的 `runInPageStep`。

### `details`

`details` 是每个 Tool 自己定义的结构化旁路信息，用于 UI / logs / persistence；LLM 看不到它。

例如 `mcp-tool.ts` 使用：

```ts
{ server, tool, structured, mcpApp? }
```

`ask-user.ts` 使用具名 `AskUserDetails` interface。类型化的 details 优先使用具名 interface。没有有用信息时使用 `{}`。

**不要增加 `status` 字段**，因为状态已经由 `message.isError` 表达。

## 调试与故障排查

调查 Bug 时，如果根因不确定，或者经过多轮调查仍未解决，**停止猜测**。在可疑代码路径中加入有针对性的 `console.log` / `console.warn`，让用户重新复现并收集日志。

清楚告诉用户：

- 应该做什么；
- 如何触发问题；
- 需要分享哪些日志。

例如：“打开 sidepanel，触发 X，然后分享 Console 输出。”

不要在没有证据的情况下持续进行推测式修复。正确流程是：

`日志 → 用户复现 → 收集反馈 → 基于证据定位 → 修复`

## 测试

单元测试使用 **Vitest** 和 **WxtVitest** 插件（`wxt/testing/vitest-plugin`）。它会在内存中 polyfill extension `browser` API，使用 `@webext-core/fake-browser`，处理 `#imports` auto-import，并配置 `@/` alias，因此测试可以像生产代码一样导入模块。

### 单元测试与源文件同目录

单元测试必须 co-located，与被测试文件放在同一目录，并使用同名 `.test.ts`：

```text
lib/backup/registry.ts
lib/backup/registry.test.ts
```

Import 仍使用 `@/` alias。

### 并非每个文件都需要测试

只覆盖高风险的纯逻辑，尤其是可能静默损坏或泄露数据的逻辑：

- crypto：encrypt/decrypt round-trip、错误密码失败；
- merge/replace semantics；
- secret split/recombine；
- manifest parsing；
- path-safety predicates。

不要为了 coverage 测试简单 glue 或 UI wiring；这些通过手动验证。

### `test/` 只用于 E2E / integration

顶层 `test/` 目录保留给未来的 E2E / integration 测试。目前没有此类测试，因此目录不存在。**不要把 unit tests 放进 `test/`。**

### 测试命令

- `pnpm test`：watch 模式；
- `pnpm test:run`：单次运行；
- `pnpm check`：运行 typecheck + i18n lint + `test:run`。

### 测试中的 Storage

不要 mock `chrome.storage` / WXT storage items。`fakeBrowser` 已提供内存 storage。

在 `beforeEach` 中调用：

```ts
fakeBrowser.reset()
```

设置状态时调用真正的 storage item 的 `setValue`，断言时通过 `getValue`。

### Mock `#imports`

Vitest 看到的是解析后的真实 import path，而不是 `#imports`。需要 mock WXT util 时，在 `.wxt/types/imports-module.d.ts` 查找真实路径，并对真实路径执行 `vi.mock`，不要 mock `'#imports'`。

### Exhaustiveness / Registry Guards

当 registry 或 discriminated union 必须与另一个 source of truth 保持同步时，应增加测试枚举 source of truth 并断言完整性。例如每个 storage item 都必须被分类。这样遗漏会在 CI 中失败，而不会静默进入生产。

# Changelog

项目根目录维护唯一的 `CHANGELOG.md`，格式遵循 Keep a Changelog + Semantic Versioning，并采用中英双语。

## 记录什么

以“相对最近已发布版本，终端用户最终能感知到什么差异”为准。

只记录：

- 新功能；
- 行为变化；
- Bug 修复；
- 面向用户的破坏性变更。

如果问题由当前 `[Unreleased]` 中尚未发布的改动引入，又在发版前修复，且最近已发布版本本身不含该问题，则不要把这次修复单独记录为 Bug Fix。如果最终发布行为仍有用户可见差异，只记录最终行为。

纯重构、测试、构建、内部依赖升级一般不记录，除非影响用户。

来自 issue 的变更在条目末尾附 `(#编号)`。

## 写到哪里

日常一律写入顶部的：

```md
## [Unreleased]
```

已发布版本节（例如 `## 1.3.2 - 2026-06-14`）**只读，永不修改**。

写入前先完整读取 `[Unreleased]`，在已有小节追加，不要重复创建小节。

## 小节

按需使用：

- `### 新增 / Added`
- `### 变更 / Changed`
- `### 修复 / Fixed`
- `### 移除 / Removed`
- `### 破坏性变更 / Breaking Changes`

## 双语排版

每个小节正文必须：

1. 先列出全部中文条目；
2. 空一行；
3. 再列出全部对应英文条目；
4. 中英文顺序一一对应。

不要逐行中英并排，也不要在条目中使用 `/` 分隔中英文。

小节标题使用：

```text
中文 / English
```

## 发版收口

在修改 `package.json` 版本号的发版提交中：

1. 将 `## [Unreleased]` 重命名为 `## X.Y.Z - YYYY-MM-DD`；
2. 在顶部新增一个空的 `## [Unreleased]`。

此操作由人或 AI 手动完成，可使用项目的 `cl` workflow 辅助审计补漏。

**CI 不自动搬运 `[Unreleased]` 内容。** CI 仅负责按照 Changelog 内容发布 Release Notes。

## 任务完成后的 Code Review

完成一个任务中的全部编码工作后，运行当前 Harness 专用只读 Reviewer 的 `code-review` workflow，并在报告完成之前修复发现的问题。

Review 必须同时确认 Changelog Gate：

- 如果任务相对最近发布版本产生最终用户可见差异，确认 `## [Unreleased]` 已更新；
- 新条目必须遵循 Changelog 格式；
- 使用正确的 subsection；
- 中英文按规定组织；
- 不修改已发布版本章节；
- 不单独记录当前 unreleased 周期中引入又修复的回归；
- 如果最终仍有用户可见差异，只记录最终行为。
