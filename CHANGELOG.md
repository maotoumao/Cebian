# 更新日志 / Changelog

本文件记录 Cebian 的所有重要变更。
All notable changes to Cebian are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

约定 / Conventions

- 所有新条目先写入 `## [Unreleased]`，发版时再整体落成版本节。
- 已发布的版本节不可修改。
- 每个小节正文先列中文、后列英文；来自 issue 的变更附 `(#编号)`。

- New entries go under `## [Unreleased]` first; they are promoted to a version section at release time.
- Released version sections are immutable.
- Each section lists Chinese bullets first, then English bullets; issue-driven changes link `(#number)`.

## [Unreleased]

### 修复 / Fixed

- 备份文件名使用用户填写的名称
- 规避会话备份/恢复时的 64 MiB runtime message 体积限制
- 工具执行中点击停止后，工具卡片不再一直显示加载图标，「已取消」提示也移到工具卡片下方 (#21)
- 询问用户/权限确认卡片的文本现在保留换行，多行时图标与首行对齐 (#23)
- 文件编辑页窄屏布局下，右键删除文件时不再误把该文件重新打开 (#22)

- Use the user-provided name for backup filenames
- Avoid the 64 MiB runtime message limit on session backup and restore
- Stop the tool card from spinning forever after cancelling a running tool, and move the "Cancelled" marker below the tool card (#21)
- Preserve line breaks in ask-user and permission-prompt card text, and align the icon to the first line for multi-line text (#23)
- File editor: deleting a file from the right-click menu no longer spuriously reopens it in the compact (narrow) layout (#22)

### 变更 / Changed

- 升级 pi-agent-core / pi-ai 至 0.79.4

- Upgrade pi-agent-core and pi-ai to 0.79.4

## 1.3.2 - 2026-06-14

### 新增 / Added

- 备份与恢复：本地 `.zip` + WebDAV，支持可选加密
- 历史记录按时间分组并支持折叠（今天 / 7 天内 / 30 天内 / 更早）
- 聊天消息朗读按钮
- 新会话空状态加入示例卡片与品牌回落
- 预提示阶段压缩（compaction），带可取消的交互
- 新增 Ant Ling 与 NVIDIA NIM 供应商
- 按模型多模态能力控制图片上传

- Backup and restore: local `.zip` + WebDAV, with optional encryption
- Group history by time with collapsible sections (today / last 7 days / last 30 days / older)
- Read-aloud button on chat messages
- New-session empty state with example cards and brand fallback
- Pre-prompt compaction with a cancellable UX
- Add Ant Ling and NVIDIA NIM providers
- Gate image upload by each model's multimodal capability

### 修复 / Fixed

- 改用 compaction 感知的 LLM 视图，替换 maxRounds 滑动窗口 (#9)
- 连通性测试失败不再阻断 API key 保存
- 自定义供应商改用 uuid 作为内部 id
- 跟随系统主题时改用 SunMoon 图标
- read_page 选择器输入清理杂散引号
- 站点根路径不再出现可见的重定向页

- Use a compaction-aware LLM view to replace the maxRounds sliding window (#9)
- Connectivity test failure no longer blocks saving the API key
- Custom providers use a uuid as their internal id
- Use the SunMoon icon when following the system theme
- Sanitize stray quotes in the read_page selector input
- Avoid a visible redirect page at the site root

### 变更 / Changed

- 退役设置中的「高级」标签页并移除未使用的 maxRounds
- run_skill 改由 beforeToolCall 门控授权，不再依赖 LLM 传递 nonce
- 升级 pi-agent-core / pi-ai 至 0.79.x

- Retire the Advanced settings tab and remove the unused maxRounds
- Authorize run_skill via a beforeToolCall gate instead of an LLM-relayed nonce
- Upgrade pi-agent-core and pi-ai to 0.79.x

## 1.3.1 - 2026-05-30

### 新增 / Added

- 应用打开时弹出更新提示对话框

- In-app update notice dialog on app open

### 修复 / Fixed

- 重构 API key 供应商注册表，修复两个设置项缺陷

- Rework the API-key provider registry and fix two settings bugs

### 变更 / Changed

- 迁移 pi-agent-core / pi-ai 至 @earendil-works 0.78.0
- 更新扩展名称

- Migrate pi-agent-core and pi-ai to @earendil-works 0.78.0
- Update the extension name

## 1.3.0 - 2026-05-30

### 新增 / Added

- PDF 工具：在标签页中读取 PDF
- 聊天 markdown 内联渲染 VFS 图片
- 技能沙箱权限：bgFetch、vfs.read / vfs.write

- PDF tool: read PDFs in tabs
- Inline VFS image rendering in chat markdown
- Skill sandbox permissions: bgFetch, vfs.read / vfs.write

### 修复 / Fixed

- 瞬时断连后重新派发重试
- 修复警告对话框文本换行

- Retry dispatch after a transient disconnect
- Fix alert dialog text wrapping

### 变更 / Changed

- 为 code-review 代理指定模型

- Set the model for the code-review agent

## 1.2.1 - 2026-05-24

### 新增 / Added

- execute_js 与 read_page 支持 outputPath，将大结果直接写入 VFS 以免撑爆上下文
- 模型选择器打开时滚动到当前模型

- execute_js and read_page support outputPath to offload large results into the VFS
- Scroll to the active model when opening the model picker

### 修复 / Fixed

- Web Store 审核：shim 掉 pi-ai 的 anthropic oauth 模块
- 流式订阅中途保持会话标题
- 为合成 keypress 补齐 legacy keyCode / which / code
- 守卫历史中重复选中当前会话

- Web Store review: shim out the pi-ai anthropic oauth module
- Preserve the session title when subscribing mid-stream
- Populate legacy keyCode / which / code on synthetic keypress
- Guard against re-selecting the current session in history

### 变更 / Changed

- 技能索引随 VFS 变更事件自动失效
- Settings 路由懒加载，缩小初始包体

- Auto-invalidate the skill index from VFS change events
- Lazy-load Settings routes to shrink the initial chunk

## 1.2.0 - 2026-05-20

### 新增 / Added

- VFS 文件 / 文件夹下载与文件复制
- VFS 媒体渲染：图片与 markdown 预览、frontmatter 表格
- fs_save_url 工具：抓取 URL 并写入 VFS，带文件名推导与大小上限
- 聊天消息重试按钮
- 按 SEP-1865 内联渲染 MCP Apps

- VFS file and folder download, plus file copy
- VFS media rendering: image and markdown preview, frontmatter table
- fs_save_url tool: fetch a URL into the VFS with filename derivation and a size cap
- Retry button on chat messages
- Inline MCP Apps rendering per SEP-1865

### 修复 / Fixed

- 首次发送立即显示标题与用户消息
- 重试后停止按钮卡住与中止标记不一致
- 内联重命名时防止误激活与拖拽
- 历史面板在 flex 列中可正常滚动
- 修复 sidepanel 首帧 150px 高度残留

- Show the title and user message immediately on first send
- Fix the stop button stuck after retry and aborted-marker inconsistency
- Prevent activation and drag during inline rename
- Allow the history panel to scroll in a flex column
- Avoid a stale 150px height on sidepanel first paint

### 变更 / Changed

- 技能的 matched-url 改为否决式过滤，去掉脚手架默认通配

- Make skill matched-url a veto-only filter and drop the wildcard default

## 1.1.0 - 2026-05-09

### 变更 / Changed

- 升级 pi-agent-core / pi-ai 至 0.73.0

- Upgrade pi-agent-core and pi-ai to 0.73.0

### 移除 / Removed

- 移除 Google Gemini CLI OAuth 供应商

- Drop the Google Gemini CLI OAuth provider

## 1.0.0 - 2026-04-26

### 新增 / Added

- 首个公开版本

- Initial public release

