# TODO

Cebian 的重构与待办追踪。**已完成的条目在下一次相关工作收口时删除**，不做归档 ——
历史在 git log 和 CHANGELOG 里，这里只留「还没做的事」。

---

##  进行中：background 架构重构

12 个平铺文件 → `index.ts` + 概念目录。规则：**background 根目录只放 `index.ts`，
每个能力一个文件夹**（少一个「够不够两个文件」的判断分支）。

### 分层规则

```
index.ts                     只 import 各模块 setup()
ipc/                         ✗ 不得 import 任何能力目录
agent/ providers/ lifecycle/ ✗ 不得 import 能力目录与 ipc/；agent/ → providers/ 单向允许
能力目录(chat/recorder/memory/page-actions)  ✓ 可 import ipc/、agent/、providers/、lifecycle/
chat/session-store.ts        数据层，可被其它能力 import
```

### 进度

| # | 内容 | 状态 |
|---|---|---|
| 1 | `lifecycle/`（keepalive、update-notice）+ `providers/`（credentials、oauth-refresh、dev-seed） | ✅ `545882c` |
| 2 | `agent/`（factory、prompt-composer + 10 例单测） | ✅ `9de26a4` `a52b94f` |
| 2b | `lib/agent/{system-prompt,page-context}.ts` → `agent/` | ✅ `eb04657` |
| 2c-1 | 信封标签剥离补齐（安全修复） | ✅ `b7f1d6b` |
| 3 | `chat/` 纯移动 + `AgentManager`→`SessionManager` | ✅ `9779322` |
| 4 | `AgentSession` 正名 + `persist()` 落库唯一入口 | ✅ `561ce23` |
| 5 | `recorder/` `memory/` `page-actions/` 各自成夹 | ✅ `a0a6d68` |
| A | `AGENT_PORT_NAME` → `CLIENT_PORT` + 端口/sendMessage 判据 | ✅ `3eb55bb` |
| 6 | `ipc/port-registry.ts` 传输层抽出 | ✅ |
| 6b | 会话路由下沉 `chat/viewers.ts`（`subscription` → viewer 词汇；删 `setBroadcast` 注入） | ✅ |
| 7 | `ipc/client-router.ts` 注册制 + 各域 `client-handlers.ts` + `mcp-bridge.ts` + 编排下沉 + 穷尽性测试 | ⬜ |
| 8 | `recorder/content-bridge.ts` + `port-relay.ts` 抽出 | ⬜ |
| 9 | 收口：`index.ts` 瘦身校验、depcruise 新规则、注释路径修正 | ⬜ |

### 子任务 7 要点

- `ipc/client-router.ts` 只有一张 `Partial<Record<ClientMessage['type'], Handler>>` 查表，
  各能力在自己的 `setup()` 里注册，router 不 import 任何域
- 配穷尽性测试：枚举 `ClientMessage['type']` 断言全部有 handler，漏注册则 CI 红
- 编排下沉：`session_delete` 的 VFS 清理进 chat、`recorder_start` 的窗口解析与所有权
  复检进 recorder、`memory_organize` 的广播编排进 memory
- **grace-cancel 随 chat 的 case 一起下沉到 `chat/client-handlers.ts`** —— 它现在还留在
  `index.ts`，因为 `chat/viewers.ts` 若自己调 `sessionManager.cancel()` 就会与
  session-manager 成运行时环（depcruise `no-circular` 是 error）。handlers 层没这个问题
- `mcp-bridge.ts`（单文件概念）承接 `mcp_status` + `mcp_read_resource`

### 新增能力时不要建 sendMessage 路由器

调研结论：background realm 有 7 个 `chrome.runtime.onMessage` 监听器，其中 4 个住在
`lib/`（`page-actions/manager`、`persistence/vfs`、`tools/sandbox-rpc`、`browser/element-picker`），
它们**必须**在多个执行上下文同时工作，而 `lib/` 不能 import `entrypoints/`。所以路由器最多
收编 3 个，收益不抵复杂度。端口那一侧的路由器（子任务 7）才值得做。

---

## 🟢 待办（background 重构完成后）

### 1. 模型解析的 5 处语义分歧

| 站点 | 偏好顺序 | 何时回退 | 都失败时 | 查凭证 |
|---|---|---|---|---|
| `resolveSessionModel`（主对话） | 会话身份 → 全局 | 身份缺失 | null | ✗ |
| `resolveCompactionModel`（压缩） | 专用 → 主模型 | 缺失/解析失败/凭证不可用 | 用主模型 | ✓ |
| `resolveActionModel`（划词流式） | 工具条 → 全局 | 缺失/解析失败 | throw | ✗ |
| `materializeHandoff`（转侧边栏） | 全局 → 工具条（**有意反转**，非 bug） | 缺失/解析失败 | throw | ✗ |
| `resolveOrganizeModel`（记忆整理） | 专用 → 全局 | 缺失/解析失败 | null | ✗ |

要做的是**抽共享函数** = `refactor`，落点 `background/providers/`（是 provider 概念，
不是 agent 概念）。

抽之前要逐个论证语义，别一刀切：`materializeHandoff` 的顺序反转和 `resolveActionModel`
的 throw 都是有意的，「对齐」不等于「统一」。

### 2. keepalive 覆盖缺口

keepalive 是按「有活干」引用计数，只有 `session-manager`（agent 运行）、`organize-manager`、
`recorder` 三处 acquire。以下长操作**没有**：

| 操作 | 期间有 chrome API 活动 | 风险 |
|---|---|---|
| **备份恢复**（chunk 累积 + commit） | ❌ chunk 之间靠消息喂活，commit 是一个大 Dexie 事务 | 中 |
| `mcp_read_resource` / `mcp_status` | 少 | 中 |
| 划词流式 `runPageActionStream` | ✅ 每个 delta 都 postMessage | 低 |

**不是数据丢失** —— `applySessionsTransactional` 把 `clear()` + `bulkPut()` 放在同一个
Dexie rw 事务里，SW 中途被杀会整体回滚，本地会话原样还在。真实后果是「恢复失败 +
一条看不懂的错误」。

真正的窗口比 `applyAll` 宽：恢复走分块协议，records 先累积在 `backup-handler.ts` 的
`applyBuffers`（**SW 内存**），最后一条 commit 才落库。SW 若死在 chunk 阶段，缓冲整份
没了 → commit 因「查无此 nonce 的缓冲」或「累计条数与 expectedCount 不符」而失败
（后半段 chunk 可能唤醒 SW 并建出一个只含尾部记录的新缓冲）。

**修法**：keepalive 绑两处，都在恢复编排层（`backup-handler.ts`），`session-store.ts`
不动 —— 数据层不该管操作的保活。

1. **缓冲存活期**：`touchBuffer` 首次建缓冲时 `acquireKeepAlive()`，`dropBuffer` 里
   `releaseKeepAlive()`。三条释放路径（commit / abort / TTL）全汇聚在 `dropBuffer`，不漏放。
2. **commit 期**：commit handler 里单独 acquire、`finally` 里 release。
   **不能省** —— `expectedCount === 0` 的空恢复没有缓冲，但 `applySessionsTransactional`
   无条件先 `toArray()` 读整张会话表、replace 还要 `clear()`，本地会话多时同样是长事务。
   引用计数天然处理两者的嵌套。

**是行为改动，单独提交。加固性质、未观测到实际故障 → 不记 CHANGELOG。**

### 3. 客户端端口收口（`lib/ipc/client-port.ts`）

现状：一条承载四个域的连接被 `useBackgroundAgent`（一个**聊天** hook）拥有；
`HistoryPanel` 还会为 `session_list` / `session_delete` 各开一条**用完即弃**的端口
（connect → 发一个请求 → 收一个回复 → disconnect），破坏了「一实例一端口」。

目标形状与 background 侧对称：

```
background：entrypoints/background/ipc/port-registry.ts
客户端：    lib/ipc/client-port.ts   模块级单例：懒连接、断线重连、暴露 post/subscribe
```

`useBackgroundAgent` / MCP / recorder / HistoryPanel **都只是消费者**，没有谁「拥有」端口。
做完后把 `lib/ipc/protocol.ts` 头注释里「现状有例外：HistoryPanel …」那句删掉。

`useMemoryOrganize` 自己开端口**不算违规**（整理状态是推送、且独立设置页里没有别的端口
可复用），只是设置页作为侧边栏路由打开时会多一条 —— shim 可支持「有 owned port 就复用」。

### 4. 提示词信封标签的单一来源（2c-2）

`b7f1d6b` 只补了洞，没有防漂移。信封词汇表实际是**三方共用**：

| 角色 | 位置 | 上下文 |
|---|---|---|
| 产出 | `agent/prompt-composer.ts`、`lib/agent/attachments.ts`、`lib/memory/index-scan.ts` | background |
| 剥离 | `agent/page-context.ts` 的 `sanitizeForContext` | background |
| **解析** | `lib/agent/message-helpers.ts` 的 `ATTACHMENTS_BLOCK_RE` 等 | **UI** |

所以词汇表归 `lib/`。要做：① 抽单一来源，三方全部引用；② 穷尽性守卫测试
（断言 `composeUserMessage` 产出里的每个信封标签都在表内）；③ `user_profile` 是唯一的
下划线孤例（其余多词标签都用短划线），随词汇表建立一并改成 `user-profile` ——
注意它半持久化在历史消息里，改名后新旧混存（无解析方依赖，无害）。

**触发条件**：等 `lib/` 侧「渲染信封」与「解析信封」这对分居的双胞胎合并之后再做，
否则会把词汇表钉进即将移动的模块。

### 5. pi 词汇表对齐

Cebian 与 pi 的 coding-agent 架构同位（都是 agent-core 之上的应用层）。名字目前**错位**：

| pi | 职责 | Cebian |
|---|---|---|
| `SessionManager` | 会话仓库 | `SessionStore` |
| `AgentSession` | 单会话运行时 | 内部 interface（尚未提成独立单元） |
| `AgentSessionRuntime` | 多会话运行时 | `SessionManager` |
| `ModelRuntime` | 模型 + 凭证运行时 | 散落 5 处的 `resolveXxxModel` + `providers/` |

**不在拆分那一刻之前改名** —— 现在的 `SessionManager` 同时兼任 runtime 与 session 两职，
改成任一名字都是撒谎。

### 6. `lib/agent/` 改名（用户暂缓）

搬走 `system-prompt` / `page-context` 后，`lib/agent/` 只剩 attachments / compaction /
message-helpers / tool-permissions —— 四个都确有 UI + background 双边消费者。它们的共同
本质是**「会话消息的共享契约 + 形状运算」**，不是「agent 的辅助函数」，改名
`lib/conversation/` 更准。触及 13 个文件的 import。

---

## 🔵 未来方向：迁移到 pi 的 `AgentHarness`

`entrypoints/background/chat/session-manager.ts`（1351 行）有一大半在重写
`@earendil-works/pi-agent-core` **同版本已导出**的 `AgentHarness`：

| Cebian 手写 | pi 现成 |
|---|---|
| `AgentPhase = idle\|preparing\|running\|compacting` | `AgentHarnessPhase = idle\|turn\|compaction\|branch_summary\|retry` |
| `prepareController` / `compactionController` | `runAbortController` |
| `maybeCompact()` 全套 | `compact()` + `appendCompaction` entry + `session_before_compact` hook |
| `scheduleWrite` / `flush` 编排 | `pendingSessionWrites` + `save_point` 事件 |
| `truncateForRetry` + retry 编排 | phase `retry` + `moveTo` / `navigateTree` |
| 切模型/思考档 + 落库 | `setModel()` / `setThinkingLevel()`（自动 append entry） |
| `agent.steer()` 手工排队 | `steerQueue` / `followUpQueue` / `nextTurnQueue` |
| `createPermissionGate` → `beforeToolCall` | `on('tool_call')` hook |

而且 pi 的 `Session` **本来就是树**（`SessionTreeEntry` + `getBranch` / `moveTo` /
`navigateTree`），正好是「会话存储迁移到树状结构」要的东西；subagent 就是**另一个
harness 实例**，不需要发明抽象。

`agent-core` **不含任何硬编码写入位置** —— `FileSystem` 是接口，`JsonlSessionRepo({ fs,
sessionsRoot })` 的 root 由调用方注入。要接入只需实现 `SessionStorage`（13 个方法）。

### 阶段方案（增量，不可 big-bang）

**阶段 0 — 可行性验证（原型，不进主干）**，四项任一不过则否掉整个方案：
1. `Models` 集合能否承载 Cebian 的凭证模型（OAuth 刷新、Copilot baseUrl、OpenRouter 归因头、自定义 provider）
2. `on('tool_call')` 能否实现执行前授权（关键：能否**异步挂起**等用户点击）
3. harness 事件流能否喂出现有 `ServerMessage`（尤其流式增量 `message_update`）
4. bundle 体积（正面信号：现有代码已从同一 index 引入，构建正常，tree-shaking 有效；
   `env/nodejs` 不在主 index 导出里）

**阶段 1 — 存储层换成 `Session` 树（不动运行时）**
实现 `DexieSessionStorage implements SessionStorage`；定义 `SessionRecord.messages[]` →
`MessageEntry` 链的映射；**写数据迁移 + 版本化 + 回滚路径**。这一步就能吃到分支重试 / fork /
树状历史导航的全部收益，且不碰并发语义。风险最高（不可逆）。

**阶段 2 — 模型 / 凭证层对齐**
5 处 `resolveXxxModel` 收敛成 `ModelRuntime` 等价物，产出 `Models` 集合；
`lib/agent/compaction.ts` 的 `modelsForSummary` 适配层随之删除（它存在的唯一原因就是
填 0.80 的 API 不对称）。

**阶段 3 — 运行时替换**
`AgentSession` 从「手写 phase + `Agent`」换成「持有 `AgentHarness`」；授权门禁改接
`on('tool_call')`；压缩改用 `harness.compact()`；retry 改用 `moveTo` / `navigateTree`；
广播改为订阅 harness 事件转发。

**阶段 4 — 协议与 UI**
`ServerMessage` 按 harness 事件形状调整；UI 支持分支导航（新功能，可独立排期）。

顺带解决下面这条协议层的全量重发问题。

#### 协议的「每次全量重发」（**即使不迁移 harness 也值得单独做**）

现在的增量同步是靠「每次重发全量」实现的：

| 消息 | 载荷 | 频率 |
|---|---|---|
| `message_update` | **单条**正在流式的 assistant 消息（累积全文） | 每 token 级，高频 |
| `message_end` | **整个会话历史** `[...agent.state.messages]` | 每条消息结束一次 |
| `agent_end` | **整个会话历史** | 每轮结束一次 |
| `session_state` | **整个会话历史** | 压缩 / retry / 授权卡片 / 取消 |

两种代价叠加：
- `message_update` 每次带「到目前为止的全文」，一条 n 字节回复约 O(n) 次更新 → 累计传输 **O(n²)**（高频，单条消息内部）
- `message_end` / `agent_end` / `session_state` 每次序列化**整个 transcript** —— 200 条消息的会话，每结束一条消息就全量克隆一遍（低频，但单次体积大得多）

可能的改法：`message_update` 只发 delta（客户端累加）；`message_end` / `agent_end` 只发
**变化的那条消息**。代价是客户端要维护增量状态，且需要一个「漏帧后重同步」机制。

**注意**：这也是「按会话路由必须保留」的原因 —— 若不按会话过滤，上面两笔开销都要
乘以打开的窗口数。客户端多一行 `if` 过滤是免费的，**序列化 + IPC 传输**才是代价。
路由本身住在 `chat/viewers.ts`。

### 注意

pi 的 README 明确说它**故意不做** sub-agents / permission popups / MCP / plan mode ——
全部推给 extensions。所以 Cebian 需要的这三块，即使采用 harness 也仍是自己的代码，
只是接入点从 `beforeToolCall` 换成 `on('tool_call')` hook。

---

## 🟣 前瞻兼容：用户自定义划词动作

未来要支持「按站点显示不同的划词按钮、各自 prompt」。**现有接口已留好口**：
`PageActionDef { id, renderSystemPrompt, renderUserIntent }` 是数据驱动注册表，
`PageActionRequest.params` 的注释白纸黑字写着「泛化预留给将来的自定义动作参数」。
background 的执行路径（查定义 → 渲染 → stream）一行不用改。

### 三处必然「外溢」出 `page-actions`

| 外溢点 | 去哪 |
|---|---|
| 存储项声明 | `lib/persistence/storage.ts`（**类型**仍放 `lib/page-actions/types.ts`） |
| 备份注册 | `lib/backup/registry.ts` —— 那里有穷尽性测试守着，漏了会 CI 红 |
| URL 匹配 | **复用 `lib/tools/url-pattern.ts`**，别新造第二份 |

### 两个届时要拍板的分叉

- **A**：内置动作要不要也降成模板？倾向**不**（内置 prompt 有回退与条件段逻辑，
  塞进模板等于发明一个迷你 DSL）。自定义动作把模板包成闭包，对外统一是 `PageActionDef`。
- **B**：谁决定「这个页面显示哪些按钮」？倾向**内容脚本自己读 storage + 匹配**
  （无 IPC 往返、按钮零延迟），要求匹配逻辑放纯模块 `lib/page-actions/match.ts`，
  不能碰 `lib/browser/`（有 depcruise 规则挡着）。

### 一处协议改动

`PageActionId` 从字面量联合放宽成 `string`，校验从白名单变成「格式校验 + 查得到定义」。
安全上无碍 —— background 的 `getPageAction(id)` 查不到就 throw，这条防线今天就在。

### 远期风险，现在留个记号

自定义 prompt 是**用户自己**写的，可信度等同 `userInstructions`。但若将来支持「分享 /
导入他人的动作包」，它就变成**不可信输入** —— 届时需要来源标记 + 导入时显式确认。
现在设计存储形状时留一个 `source: 'user' | 'imported'` 字段，成本近乎零。

「返回不同的结果」若只是不同**内容**，现有 `ResultCard` 够用；若要不同**去向**
（替换选中文本 / 剪贴板 / 新标签），需给 `PageActionDef` 加 `output` 字段，
由 `ResultCard.tsx` 分派 —— 那会让划词从「问一句话」变成「一个小自动化」，影响面大得多。
