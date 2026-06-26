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
    
### 新增 / Added

- 文件浏览器现在把会话工作区目录（原本是一串 UUID）显示成「会话标题 · 日期」，并在进入某个工作区时于顶部展示该会话的标题与创建时间，让 AI 生成的文档更好找；设置新增「文件系统」一节，显示虚拟文件系统已用空间，并可一键打开文件浏览器 ([#26](https://github.com/maotoumao/Cebian/pull/26))

- The file browser now shows session workspace folders (previously raw UUIDs) as "conversation title · date", and displays the conversation's title and creation time at the top when you open a workspace, making AI-generated documents easier to find; Settings gains a "Filesystem" section that shows used space and opens the file browser in one click ([#26](https://github.com/maotoumao/Cebian/pull/26))

### 变更 / Changed

- 升级核心 AI 引擎 pi-ai / pi-agent-core 至 0.80，跟进上游的模型目录更新与服务商兼容性修复；同步升级构建工具链（WXT、CodeMirror）

- Upgraded the core AI engine (pi-ai / pi-agent-core) to 0.80, picking up upstream model-catalog refreshes and provider compatibility fixes; also bumped the build toolchain (WXT, CodeMirror)

### 修复 / Fixed

- 修复站点在移动端（≤820px）导航栏中"赞助"和语言标签文字因 flex 压缩折行的问题；移动端赞助按钮退化为纯图标，极窄屏（≤380px）同步隐藏语言标签文字
- 语音输入改为「本地优先、云端兜底」：本地语音引擎不可用的浏览器（如 Edge）现在自动改用云端识别，不再误报「本设备的本地语音识别不支持当前语言」；云端识别连接失败时给出明确的网络提示 ([#33](https://github.com/maotoumao/Cebian/pull/33))
- 修复从某个对话进入设置后点返回会落到新对话的问题：现在返回会回到进入设置前正在查看的对话
- 修复 skill 导入时错误拒绝合法的 `vfs.read`、`vfs.write`、`bgFetch`、`bgFetch:<pattern>` 权限声明；声明了这些权限的 skill 此前在导入预览时会报 `unsupportedPermission` 并拒绝安装 ([#37](https://github.com/maotoumao/Cebian/pull/37) by [@LinYanZhi](https://github.com/LinYanZhi))

- Fixed nav bar text wrapping on mobile (≤820px) where the sponsor label and language label were line-breaking due to flex shrink; the sponsor button now degrades to an icon-only style on mobile, and the language label is additionally hidden on extra-narrow screens (≤380px)
- Voice input now follows "local first, cloud fallback": browsers without an on-device speech engine (such as Edge) automatically switch to cloud recognition instead of wrongly reporting that the language isn't supported on-device; a clear network message is shown when the cloud service can't be reached ([#33](https://github.com/maotoumao/Cebian/pull/33))
- Fixed the Settings back button landing on a new chat: returning from Settings now restores the conversation you were viewing before opening it
- Fixed skill import incorrectly rejecting valid `vfs.read`, `vfs.write`, `bgFetch`, and `bgFetch:<pattern>` permission declarations; skills declaring these permissions previously failed at import time with an `unsupportedPermission` error ([#37](https://github.com/maotoumao/Cebian/pull/37) by [@LinYanZhi](https://github.com/LinYanZhi))

## 1.3.3 - 2026-06-21

### 新增 / Added

- 对话输入框支持语音输入：点击麦克风按钮即可把语音实时转写进输入框，离线本地识别（基于浏览器 on-device 语音引擎，音频不离开设备），首次使用会自动下载所选语言的语音模型 ([#20](https://github.com/maotoumao/Cebian/pull/20))
- 新增通用授权页用于在标签页中完成麦克风授权（侧边栏无法直接弹出授权框）
- 每个对话各自记住自己的模型与思考档：在某个对话里切换模型/思考档只影响该对话，新对话沿用你上一次选择的模型作为默认；适合多开标签分散使用、按对话把请求分摊到不同供应商 ([#11](https://github.com/maotoumao/Cebian/pull/11))
- 使用 OpenRouter 时，请求会附带应用标识请求头（`HTTP-Referer` / `X-Title`），让 Cebian 出现在 OpenRouter 的应用榜单中；不含任何用户数据，仅对 OpenRouter 发送
- WebDAV 备份新增「断开连接」：可移除已保存的连接配置（含密码），远程已上传的快照会保留，重新连接后仍可访问
- 扩展升级后，下次打开侧边栏会自动打开更新日志页并定位到新版本，方便查看本次更新内容

- Voice input in the chat composer: click the mic button to transcribe speech into the input in real time, recognized locally on-device (the browser's on-device speech engine — audio never leaves your device); the language model for your locale is downloaded automatically on first use ([#20](https://github.com/maotoumao/Cebian/pull/20))
- Added a generic permission page to grant microphone access from a tab (the side panel can't show the prompt directly)
- Each conversation now remembers its own model and thinking level: switching the model/thinking level inside one chat affects only that chat, and a new chat defaults to the model you last picked; handy for spreading work across multiple tabs and routing requests to different providers per conversation ([#11](https://github.com/maotoumao/Cebian/pull/11))
- When using OpenRouter, requests now carry app-identifying headers (`HTTP-Referer` / `X-Title`) so Cebian appears on OpenRouter's app rankings; they contain no user data and are sent to OpenRouter only
- WebDAV backup can now be disconnected: remove the saved connection (including the password); snapshots already uploaded to the server are kept and stay accessible after reconnecting
- After an extension upgrade, opening the side panel next time automatically opens the changelog page scrolled to the new version, so you can see what changed

### 修复 / Fixed

- 备份文件名使用用户填写的名称
- 规避会话备份/恢复时的 64 MiB runtime message 体积限制
- 工具执行中点击停止后，工具卡片不再一直显示加载图标，「已取消」提示也移到工具卡片下方 ([#21](https://github.com/maotoumao/Cebian/pull/21))
- 询问用户/权限确认卡片的文本现在保留换行，多行时图标与首行对齐 ([#23](https://github.com/maotoumao/Cebian/pull/23))
- 文件编辑页窄屏布局下，右键删除文件时不再误把该文件重新打开 ([#22](https://github.com/maotoumao/Cebian/pull/22))
- 修复 AI 偶尔不读取页面、凭记忆编造链接就跳转的问题：现在要求链接地址必须来自页面真实 \`href\`、用户输入或工具结果，仅允许基于页面上可见样本的推导（如可见的 \`?page=2\` 翻到 \`?page=3\`），并在跳转失败时回退到重新读取页面
- 修复「关于」页与更新提示里的安装指南链接指向失效旧地址的问题（现指向重构后的文档站安装页），并按界面语言正确区分简体 / 繁体 / 英文

- Use the user-provided name for backup filenames
- Avoid the 64 MiB runtime message limit on session backup and restore
- Stop the tool card from spinning forever after cancelling a running tool, and move the "Cancelled" marker below the tool card ([#21](https://github.com/maotoumao/Cebian/pull/21))
- Preserve line breaks in ask-user and permission-prompt card text, and align the icon to the first line for multi-line text ([#23](https://github.com/maotoumao/Cebian/pull/23))
- Fixed the AI occasionally navigating to a URL invented from memory instead of reading the page: link addresses must now come from a real page \`href\`, user input, or a tool result, with derivation allowed only from a sample visible on the page (e.g. bumping a visible \`?page=2\` to \`?page=3\`), and a fallback to re-read the page when navigation fails
- File editor: deleting a file from the right-click menu no longer spuriously reopens it in the compact (narrow) layout ([#22](https://github.com/maotoumao/Cebian/pull/22))
- Fixed the install-guide link in the About page and update notice pointing at a dead old URL (now points at the rebuilt docs site's installation page), and route it to the correct Simplified / Traditional Chinese / English variant per UI language

### 变更 / Changed

- 升级 pi-agent-core / pi-ai 至 0.79.9（含 GitHub Copilot OAuth 可用模型列表改用登录账号自身的模型目录等修复）

- Upgrade pi-agent-core and pi-ai to 0.79.9 (includes fixes such as GitHub Copilot OAuth model availability now using the signed-in account's own model catalog)

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

- 改用 compaction 感知的 LLM 视图，替换 maxRounds 滑动窗口 ([#9](https://github.com/maotoumao/Cebian/pull/9))
- 连通性测试失败不再阻断 API key 保存
- 自定义供应商改用 uuid 作为内部 id
- 跟随系统主题时改用 SunMoon 图标
- read_page 选择器输入清理杂散引号
- 站点根路径不再出现可见的重定向页

- Use a compaction-aware LLM view to replace the maxRounds sliding window ([#9](https://github.com/maotoumao/Cebian/pull/9))
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

