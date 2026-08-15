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
| 7 | `ipc/client-router.ts` 注册制 + 各域 `client-handlers.ts` + `mcp/bridge.ts` + 编排下沉 + 穷尽性测试 | ✅ |
| 8 | `recorder/content-bridge.ts` + `port-relay.ts` 抽出 | 🟡 port-relay ✅；content-bridge（注入钩子 / 事件监听 / 抑制三件套 → `setupRecorderContentBridge()` + 导出 `handleContentPresent`）待做 |
| 9 | 收口：`index.ts` 瘦身校验、depcruise 新规则、注释路径修正 | ⬜ |

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

### 2. keepalive 覆盖缺口（剩余部分）

备份恢复的缺口已修（`9028ba6`：缓冲存活期 + commit 期双 acquire，都在 `backup-handler.ts`
编排层）。还没覆盖的：

| 操作 | 期间有 chrome API 活动 | 风险 |
|---|---|---|
| `mcp_read_resource` / `mcp_status` | 少 | 中 |
| 划词流式 `runPageActionStream` | ✅ 每个 delta 都 postMessage | 低 |

mcp 两条现在住 `background/mcp/bridge.ts`，修的话 acquire/release 就地包住两个
handler 的 async 段即可。划词流式风险低（delta 持续喂活），可以不修。

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

> **进展（2026-08）**：树化迁移已完成——存储层换成会话树（`DexieSessionStorage`
> implements pi `SessionStorage` + `lib/shims/pi-session-state.ts` 移植 reducer +
> Dexie v1→v2 无损迁移 + 备份随包分支），运行时经 `TreeBinding`（syncTail 水位线 /
> moveLane 回卷）接线，消息编辑（#44）/ 任意轮重试 / 分支切换 UI 已上。原「阶段 1」
> 目标全部落地。**注意**：0.84.x 的 `AgentHarness` 类是空壳（全部方法
> `HarnessNotImplemented`，能跑的编排在未安装的 `pi-coding-agent` 里），阶段 3 的
> 运行时替换须等上游填实现；`SessionState` 未公开导出，上游导出后删除本地移植副本。
>
> 树化后的剩余后续项：
> - IPC 增量广播（见下方「每次全量重发」——现在 entry 模型已具备增量条件）
> - Record 日志接入 SW 崩溃恢复（`appendRecord` / `findOpenOperations` 协议已在存储层可用）
> - 日志 checkpoint（每 N 条存快照）压 SW 冷启 replay 成本
> - v3 清理 `sessions.messages` 影子字段（迁移保险，见 db.ts）
> - `messageCount` 口径为全树 message entry 数（含旧分支），如需精确到当前分支再改

`entrypoints/background/chat/session-manager.ts` 剩下的编排职责仍与
`@earendil-works/pi-agent-core` 声明的 `AgentHarness` 接口高度重合：

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

**阶段 1 — 存储层换成 `Session` 树（不动运行时）** ✅ 已完成（2026-08，连同
消息编辑 / 任意轮重试 / 分支切换 UI 一并落地；实现见 lib/persistence/session-tree.ts、
lib/persistence/migrate-messages.ts、session-manager 的 TreeBinding）。

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

> **2026-08 调研结论：值得独立做，而且不应等 harness。** 但目标不是把所有帧都改成
> delta，而是把「连续流」与「不连续状态跳转」分开：连续流发有序 mutation，订阅 / 重连 /
> 切分支 / retry 回卷等仍发权威 snapshot。

### 当前实际数据流

| 消息 | 当前载荷 | 实际频率 / 语义 |
|---|---|---|
| `message_update` | 单条在途 assistant 消息的**累积全文** | 每个 provider 流事件一次，不严格等于每 token；text / thinking / tool-call 的 start、delta、end 都会触发 |
| `message_end` | 当前分支的完整 transcript | 每条 user / assistant / toolResult 完成一次；工具轮会连续触发多次 |
| `agent_end` | 当前分支的完整 transcript + 分支信息 | 每次 run 结束一次，通常紧跟最后一个 `message_end`，全文基本重复 |
| `session_state` | 当前分支的完整 transcript + 运行态 | 订阅活会话、压缩、retry / 编辑、切分支、授权卡片、取消与纠错 |

pi 已在 `AgentEvent.message_update.assistantMessageEvent` 提供 text / thinking / tool-call delta；
Cebian 目前丢掉这个字段，只转发 `event.message` 的累积副本。因此无需从两份全文反推 delta，
但也不应把 pi 的含 `partial` 上游对象直接暴露为 wire contract——应在 background 归一化成
自己的小 patch，避免协议绑死上游版本。

### 树化后的边界

- IPC 中的 `messages` 是 **main lane 当前分支投影**，不是整棵树。旧分支不会直接进入每帧，
  所以不能把全树 entry 数 `T` 与每帧 transcript 大小画等号。
- 但压缩是无损设计：原消息永远留在 `agent.state.messages`，只在尾部追加摘要，LLM 视图才折叠。
  因而在**不切分支、不 retry / 编辑回卷的追加路径上**，当前分支消息数 `M` / 字节数 `B`
  仍单调增长，压缩不会替 IPC 限流；上述跳转会整体换投影，不能说全局单调。
- `agent_end` 当前还会 `findEntries()` 克隆全树，再由 `buildBranchInfo()` 扫描 `T` 个 entry。
  `buildBranchInfo()` 本身是 O(T)，但 `findEntries()` 的 `structuredClone` 按整树字节数 `Q`
  付出 **O(Q) 时间 + 临时内存**；分支多或历史附件大时可能先于传输成为尾延迟，应缓存
  `branchInfo`，只在 retry / 编辑等确实可能产生 sibling 时标脏重算。

### 第一性成本模型

记 `L` = 当前流式 assistant 长度，`U` = 流事件数，`B` = 当前分支序列化字节数，
`M` = 当前分支消息数，`T` = 全树 entry 数，`Q` = 全树序列化字节数，
`V` = 正在看该会话的窗口数：

- 流式传输：`message_update` 总量约 `V × Σ partialLength`，即 **O(VUL)**；若平均每固定
  `k` 字节来一帧，`U ≈ L/k`，退化为 **O(VL²/k)**。delta 后降为 O(VL)。
- 终结传输：一轮若产生 `K` 个 `message_end`，当前约 **O(V(K+1)B)**；最后的 `+1`
  是几乎重复的 `agent_end`。工具调用越多，`K` 越大。
- 前端：每个 `message_update` 都复制 `messages` 数组 O(M)，整页重新执行 `messages.map`；
  旧 Markdown 有 `memo` 保护，但在途消息仍每帧重新 Markdown + GFM + highlight 解析，约
  O(L)。普通会话合计近似 **O(U(M+L))**；当前 assistant row 还会向前扫描轮次边界 / usage，
  工具密集且连续分组时单次 render 最坏 O(M²)，总计 **O(U(M²+L))**。当前无列表虚拟化，
  长会话会同时吃 IPC 与主线程。
- Chrome 扩展消息使用 **JSON serialization**，不是零拷贝；每个 `port.postMessage` 都要跨
  边界序列化，单帧硬上限 **64 MiB**。现有 `post()` 还会吞掉投递异常，超限时最终
  `agent_end` 可能静默丢失，让 UI 卡在运行态。

字节风险比「200 条消息」更早到：图片附件每张允许 5 MiB、一次最多 10 个，base64 约有
4/3 膨胀，理论上单次 prompt 就可超过 64 MiB；即使首发侥幸通过，之后每个全量快照还会
反复携带历史图片。增量广播只能消除重传，**首发超限仍需另设总附件字节上限，最终把二进制
改成 VFS / blob 引用**。

### 推荐协议形状

1. **Snapshot 是同步边界**
   - `session_snapshot { generation, revision, messages, branchInfo, runState, pending... }`
   - 只用于首次订阅、Port 重连、显式 resync、切分支，以及 retry / 编辑失败后的权威纠错。
   - retry / 编辑会整体换当前分支投影，保留 snapshot 比尝试描述任意 splice 更可靠。
   - snapshot 必须包含在途消息的临时 `messageId` 与截至该 revision 的累积内容；否则重连方
     没见过原 `message_start`，后续 delta 无法定位。`messageId` 按消息分配并保存在活会话，
     不是按 run 分配；持久化 `entryId` 仍是树操作身份，两者不能混成一个字段。
2. **连续流是有序 mutation**
   - `message_start`：为本条 assistant 分配临时 `messageId`，发送最小初始形状。
   - `message_patch_batch`：发送自己的归一化 patch 联合，绝不带上游 `partial`：
     `block_start` 带 text / thinking 类型，或 tool-call 的最小 `{ id, name }`；`block_delta`
     带 `{ messageId, contentIndex, kind, delta }`；`block_commit` 带该 text / thinking /
     tool-call block 的最终完整形状。start / delta / commit 跨 block 严格保序，不能假设所有
     pi 事件都只是可拼接字符串（`toolcall_end` 才给权威 `ToolCall`）。
   - `message_commit`：消息结束时发送一次最终完整消息，作为 delta reducer 的校验点；落树后
     再附 `entryId`（在途消息没有持久化 id 是现有正确契约）。
   - `prompt` 增加客户端生成的 `commandId`；乐观 user row 以它为键，server 的 user mutation
     回显同一 id 并 **replace / commit**，不能再 append 一份。非乐观的 toolResult /
     compaction / permission 卡片走 append / replace mutation。
   - `agent_end` 只发 run 状态、清空 pending、必要的 commit / `branchInfo`，不再带 transcript。
3. **`session_state` 不宜一次性全拆**
   - 第一阶段只把高频 `message_update`、重复 `message_end` / `agent_end` 增量化。
   - 压缩、授权与取消频率低且有原子语义，可以暂留 snapshot；之后再把「消息 mutation +
     pending 状态」放进同一 revision 的事务帧，不能让可点击授权卡片与 pending 集合错帧。

### 顺序、背压与重同步

- 活 Port 内依赖有序投递，不为每帧做 ACK；主要失同步边界是断线、SW 重启、协议 bug 与
  超限投递。重连后一律重新 `subscribe` 并收 snapshot。
- 每个活会话维护 `generation + revision`。每次权威状态 mutation 只推进一次 revision；发送
  snapshot 只是报告当前 state revision，**自身不再占新号**，因此定向 subscribe / resync
  不会让其它 viewer 凭空看到 gap。snapshot 是权威替换：新 generation 由它建立 / 重置；
  同 generation 下旧 snapshot（revision < current）忽略，equal / newer snapshot 直接应用，
  newer 可跨过 gap（resync 本来就负责这件事）。
  mutation 才要求连续：`revision <= current` 是重复 / 旧帧，直接忽略，
  `revision === current + 1` 才应用，`revision > current + 1` 才请求 snapshot。snapshot 的消息、
  运行态、`branchInfo` 与 revision 必须来自同一个串行化状态切片：异步查树期间不能先占
  revision，查完后拿旧 messages 配新 revision。它也能封住当前「订阅期间 await DB / 全树
  分支扫描，旧 snapshot 可能晚于新 update 到达」的竞态。
- Port 没有可用的背压信号。background 应在约 32–50 ms 内合并连续 delta（同块拼字符串、
  跨块保序），定时器只排队、不阻塞 pi 的 awaited subscriber；`message_commit` / `agent_end`
  前必须同步 flush。这样既限制 Port 队列，也把 Markdown 重算压到约 20–30 FPS。
- 所有帧设显式字节预算；`post()` 至少记录非断线类序列化错误，不能继续无差别吞掉。

### 前端配套

- reducer 做结构共享：只替换变化的 message，旧消息对象引用保持稳定。
- 把单条消息抽成可 memo 的 row，避免每个 delta 重算全部历史消息的 header / meta / tool 查找；
  Markdown 只在变化的在途 row 上按合帧节奏解析。
- Chromium-only 的侧边栏可先给离屏消息加 `content-visibility: auto`；真正虚拟化留到实测 DOM
  数量成为瓶颈后再做，因为变高 Markdown、自动贴底、页内查找与分支切换会显著增加复杂度。

### 实施顺序

1. 先加开发态计数：每类帧次数、UTF-8 字节数
  `TextEncoder().encode(JSON.stringify(frame)).byteLength`、最大 `B/M/T/Q`、UI commit /
  long task；用纯文本、工具密集、thinking、图片、retry 多分支五组会话建立基线。
2. 引入 generation / revision + `session_snapshot`，先把重连和纠错边界固定下来。
3. `message_end` 改最终消息 commit，`agent_end` 去 transcript；这是低复杂度、直接消掉最多的
   O(B) 重复帧。
4. 接 pi delta，做 `message_patch_batch` + background 合帧，再做前端 row memo。
5. 缓存 `branchInfo`（树规模问题）与二进制引用化（64 MiB 问题）分别立项，不塞进 IPC reducer。

**按会话路由必须保留。** `chat/viewers.ts` 在序列化前筛 viewer；若改成先全局广播、再让客户端
`if` 过滤，JSON 序列化与传输成本仍会乘以所有打开窗口。客户端过滤只能省业务处理，省不了边界成本。

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
