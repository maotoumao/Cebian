# Cebian（侧边）— 项目交接文档

> 最后更新：2026-04-10
> 项目状态：前期调研完成，待启动开发

---

## 1. 项目概述

**Cebian** 是一个 Chrome 浏览器侧边栏（Sidebar）AI Agent 扩展，用户通过自然语言对话操控浏览器——包括读取元素、修改样式、执行自动化脚本、页面分析等。

- **定位**：开发者的 AI DevTools 助手 + 普通用户的智能浏览器副驾
- **形态**：Chrome 扩展，Side Panel
- **分发方式**：自用 + 开源（不上架 Chrome Web Store）
- **许可证**：建议 MIT 或 Apache 2.0
- **双重用户群**：
  - 开发者：CDP 网络/性能分析、DOM 调试、代码注入
  - 普通用户：页面总结、表单填写、抢票/秒杀、定时 RPA

---

## 2. 竞品分析

### 2.1 最直接竞品

| 产品 | 类型 | 特点 | 与 Cebian 的差异 |
|------|------|------|-----------------|
| **Chrome DevTools Gemini** | Chrome 内置 | AI 分析面板（Console Insights、源码分析、网络分析、火焰图） | 只读/分析，**不能执行操作** |
| **HARPA AI** | Chrome 扩展 | 最成熟的 AI 浏览器 agent，多模型支持，GRID API，可连 Zapier/n8n | 面向普通用户的生产力工具，不面向开发者调试 |
| **Delight** | Chrome 扩展 | 用 Vercel AI SDK 构建，6 provider、25+ 模型，sidepanel | 偏对话/写作，不做 DOM 操控和自动化 |
| **Page-Agent (阿里巴巴)** | 开源 SDK + Chrome 扩展 (16.6k⭐) | 页内 GUI Agent，文本 DOM 操作，多页面任务，MCP Server | 见下方详细对比 |
| **Browser Copilot** | 开源框架 | 允许集成自定义 AI assistant | 框架级别，非成品 |

### 2.2 与 Page-Agent 的详细对比

Page-Agent（阿里巴巴，16.6k⭐）是最接近的竞品，但本质定位不同：

| 维度 | Page-Agent | Cebian |
|------|-----------|--------|
| **本质** | 页内 JS SDK（供网站开发者嵌入产品） | Chrome 扩展（终端用户安装，对任意网站生效） |
| **GUI 操作** | ✅ 核心能力 | ✅ |
| **表单填写** | ✅ 官方 use case | ✅ |
| **页面总结/分析** | ⚠️ 弱（action agent，非 reading agent） | ✅ 核心功能 |
| **定时/调度执行** | ❌ 无定时器/调度机制 | ✅ Offscreen + Alarms |
| **抢票/秒杀** | ❌ 无毫秒级定时 | ✅ 毫秒级定时器 |
| **RPA 循环自动化** | ❌ 无持久化任务队列 | ✅ 可持久化 |
| **CDP 协议** | ❌ | ✅ 网络/性能/断点 |
| **Sidebar 对话式 UX** | ❌ 页内浮层 | ✅ 原生 sidebar |
| **后台运行** | ❌ 页面关了就没了 | ✅ SW + Offscreen 存活 |
| **MCP Server** | ✅ Beta | ❌（可后续加） |
| **作为 SDK 嵌入产品** | ✅ 核心用途 | ❌ 不是 SDK |

**核心差异总结：**
- Page-Agent = **供给侧工具**（网站开发者嵌入自己产品的 SDK）
- Cebian = **需求侧工具**（终端用户安装后在任意网站使用）
- Page-Agent 没有调度/定时能力 → 抢票、定时 RPA 做不了
- Page-Agent 没有持久化后台 → 页面关了 agent 就消失
- Page-Agent 不做 CDP 级别的深度分析

### 2.3 Cebian 的差异化

- **Sidebar 原生体验**，普通用户也能点开侧边栏直接用
- **能执行操作**，不仅仅是分析（vs Chrome 内置 Gemini）
- **定时/调度自动化**，支持抢票、秒杀、定时 RPA（vs Page-Agent）
- **CDP 深度集成**，网络拦截、性能分析、JS 断点（开发者向）
- **后台持久化**，SW + Offscreen Document 保障任务持续运行
- **开源自用**，权限可以拉满，不受 Web Store 审核限制

### 2.4 参考资料

- Delight 技术文章：https://medium.com/@andrewskwesiankomahene/building-delight-a-multi-provider-ai-chrome-extension-with-vercel-ai-sdk-c5c9f700bd55
- Vercel 官方 Chrome 扩展 Demo：https://github.com/vercel-labs/ai-sdk-chrome-extension
- Copilot Browser Bridge：https://github.com/aktsmm/copilot-browser-bridge
- Page-Agent（阿里巴巴）：https://github.com/alibaba/page-agent
- WXT 框架：https://wxt.dev

---

## 3. 技术架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────┐
│                  Chrome 扩展                      │
│                                                   │
│  ┌──────────┐   chrome.runtime   ┌─────────────┐ │
│  │ Sidebar  │ ◄────────────────► │  Service     │ │
│  │  (React) │     messages       │  Worker      │ │
│  │          │                    │              │ │
│  │ 对话 UI   │                    │ • LLM 调用   │ │
│  │ 设置页面  │                    │ • Tool Call  │ │
│  │ 代码预览  │                    │ • Token 管理 │ │
│  └──────────┘                    └──────┬──────┘ │
│                                         │        │
│                               executeScript      │
│                                         │        │
│  ┌──────────────┐                ┌──────▼──────┐ │
│  │  Offscreen   │                │  Content    │ │
│  │  Document    │                │  Script     │ │
│  │              │                │             │ │
│  │ 毫秒级定时器  │                │ • DOM 读写   │ │
│  │ 自动化调度    │                │ • 样式修改   │ │
│  └──────────────┘                │ • 自动化执行 │ │
│                                  └─────────────┘ │
└──────────────────────┬──────────────────────────┘
                       │ fetch（无 CORS 限制）
                       ▼
                ┌──────────────┐
                │  LLM APIs    │
                │ (用户自配)    │
                │ • OpenAI     │
                │ • Anthropic  │
                │ • Copilot    │
                │ • Ollama     │
                │ • 任意兼容端点│
                └──────────────┘
```

### 3.2 核心设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 是否需要后端？ | **不需要** | Service Worker 无 CORS 限制，可直接 fetch 任何 API |
| 用什么前端框架？ | **React + Tailwind** | 生态成熟，Delight 等先例验证可行 |
| LLM SDK | **Vercel AI SDK (`ai`)** | 统一多 provider 接口、流式响应、Tool Calling 开箱即用 |
| 打包工具 | **WXT (https://wxt.dev)** | 基于 Vite，HMR 热更新，TS 原生支持，自动化发布，百万级用户扩展验证 |
| 定时任务 | **chrome.alarms（分钟级）+ Offscreen Document（毫秒级）** | SW 30 秒空闲被杀，需要替代方案 |

### 3.3 不需要后端的原因

Chrome 扩展的 Service Worker **没有 CORS 限制**，可以直接请求任何第三方 API。核心功能均可在扩展内完成：

- LLM API 调用 → `fetch()` 直连
- 存储 API Key → `chrome.storage.local`
- 读取/修改 DOM → `chrome.scripting.executeScript()`
- 对话历史 → `IndexedDB` / `chrome.storage`
- 流式响应 → `fetch` + `ReadableStream`
- 截图 → `chrome.tabs.captureVisibleTab()`

---

## 4. 权限策略

由于**自用 + 开源**，不需要考虑 Web Store 审核，权限直接拉满：

```jsonc
// manifest.json
{
  "manifest_version": 3,
  "name": "Cebian",
  "permissions": [
    "sidePanel",
    "activeTab",
    "tabs",
    "scripting",
    "storage",
    "alarms",
    "offscreen",
    "debugger"        // CDP 协议，最强大的浏览器控制
  ],
  "host_permissions": ["<all_urls>"],
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "background": {
    "service_worker": "sw.js",
    "type": "module"
  }
}
```

`debugger` 权限赋予 CDP（Chrome DevTools Protocol）能力：网络拦截、DOM 操控、JS 断点、性能分析、截图、设备模拟等。

---

## 5. 模型提供商策略

### 5.1 优先级

| 优先级 | 方案 | 说明 |
|--------|------|------|
| 1 | **GitHub Copilot Device Flow** | 已有订阅，不花额外钱，自用无 ToS 风险 |
| 2 | **自定义 baseURL + API Key** | 灵活兜底（OpenAI、Anthropic、任意兼容端点） |
| 3 | **Ollama 本地模型** | 离线可用 |

### 5.2 Copilot Device Flow 技术细节

```
第1步：OAuth Device Flow
  POST https://github.com/login/device/code
    body: client_id=Iv1.b507a08c87ecfe98&scope=copilot
    → 返回 device_code + user_code + verification_uri

  用户打开 github.com/login/device，输入 user_code

  轮询 POST https://github.com/login/oauth/access_token
    → 返回 ghu_xxxxx token（~8小时有效）

第2步：交换 Copilot API Token
  GET https://api.github.com/copilot_internal/v2/token
    Headers:
      Authorization: token ghu_xxxxx
      Editor-Version: vscode/1.96.2
      Editor-Plugin-Version: copilot-chat/0.26.7
    → 返回短期有效的 Copilot completion token（~30分钟）

第3步：调用模型 API
  使用第2步的 token 调用 gpt-4o、claude-sonnet 等
  模型名使用裸名（gpt-4o，不是 copilot/gpt-4o）
```

**重要注意事项：**
- `Iv1.b507a08c87ecfe98` 是 VS Code Copilot 的 Client ID（非官方）
- `copilot_internal` 是私有 API，随时可能变更
- 只有 `ghu_` token 能用，PAT（`ghp_`）和 CLI token（`gho_`）均不行
- 需要用 `chrome.alarms` 定期刷新 token（建议每 25 分钟）

### 5.3 多模型统一接口（Vercel AI SDK）

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';

// 用户配置的自定义端点
const provider = createOpenAI({
  baseURL: userConfig.baseURL,
  apiKey: userConfig.apiKey,
});

const result = await streamText({
  model: provider('gpt-4o'),
  messages,
  tools: {
    readDOM: tool({
      description: '读取当前页面的 DOM 元素',
      parameters: z.object({
        selector: z.string().describe('CSS 选择器'),
      }),
      execute: async ({ selector }) => {
        const [tab] = await chrome.tabs.query({ active: true });
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => document.querySelector(sel)?.outerHTML,
          args: [selector],
        });
        return results[0]?.result;
      },
    }),
  },
});
```

---

## 6. Service Worker 生命周期与定时任务

### 6.1 核心限制

- Service Worker **空闲 30 秒后被杀掉**
- 对话/流式请求期间不会被杀（有活跃 fetch）
- Sidebar 打开时，消息通信保持 SW 存活
- **状态必须持久化到 `chrome.storage`**，不能依赖内存变量

### 6.2 定时任务方案

| 方案 | 精度 | SW 被杀后 | 适用场景 |
|------|------|----------|---------|
| `chrome.alarms` | 最小 1 分钟 | ✅ 自动唤醒 SW | Token 刷新、低频轮询 |
| Offscreen Document + `setInterval` | 毫秒级（~4ms） | ✅ 独立于 SW | 高频自动化脚本 |
| Content Script + `setInterval` | 毫秒级 | ✅ 页面存活即在 | 页面内定时操作 |

### 6.3 Offscreen Document 实现

```typescript
// sw.js — 创建 offscreen document
async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run scheduled automation tasks'
    });
  }
}

// offscreen.js — 毫秒级定时器
function startTask(task) {
  const id = setInterval(() => {
    chrome.runtime.sendMessage({
      type: 'TIMER_TICK',
      tabId: task.tabId,
      action: task.action,
    });
  }, task.intervalMs); // 可以是 100ms、500ms 等
}
```

---

## 7. 核心能力规划

| 能力 | 实现方式 | 优先级 |
|------|---------|--------|
| **开发者向** | | |
| 读取元素 | `chrome.scripting.executeScript` / CDP | P0 |
| 修改样式 | 注入 CSS / CSSOM | P0 |
| 执行自动化脚本 | Tool Calling → Content Script | P0 |
| 网络请求分析 | CDP `Network` domain | P1 |
| 性能分析 | CDP `Performance` domain | P2 |
| Accessibility 审计 | 注入脚本分析 DOM 无障碍问题 | P2 |
| **普通用户向** | | |
| 页面总结/分析 | 提取正文 → LLM 摘要 | P0 |
| 表单智能填写 | Tool Calling → DOM 自动输入 | P1 |
| 抢票/秒杀 | Offscreen Document + 毫秒级定时 + 精准点击 | P1 |
| 定时 RPA | chrome.alarms 调度 + 任务队列持久化 | P1 |
| 页面截图分析 | `chrome.tabs.captureVisibleTab` + 视觉模型 | P1 |
| 录制模式 | 监听用户操作 → 生成可复用脚本 | P2 |

---

## 8. 推荐技术栈

```
项目结构：
cebian/
├── src/
│   ├── sidepanel/          React + Tailwind（对话 UI）
│   ├── service-worker/     AI SDK Core + Tool Calling 调度
│   ├── content-script/     DOM 读写 + 自动化执行
│   ├── offscreen/          毫秒级定时任务
│   └── providers/
│       ├── copilot.ts      Device Flow + Token Exchange
│       ├── openai.ts       @ai-sdk/openai
│       └── ollama.ts       本地模型
├── manifest.json
├── wxt.config.ts           WXT 配置
├── package.json
└── tsconfig.json
```

### 依赖清单

| 包 | 用途 |
|----|------|
| `ai` | Vercel AI SDK Core（streamText, generateObject, tool） |
| `@ai-sdk/openai` | OpenAI / 兼容端点 provider |
| `@ai-sdk/anthropic` | Anthropic provider |
| `zod` | Tool Calling 参数校验 |
| `react` + `react-dom` | Sidebar UI |
| `tailwindcss` | 样式 |
| `wxt` | Chrome 扩展框架（Vite 驱动、HMR、TS、自动化发布） |

---

## 9. 安全注意事项

| 点 | 措施 |
|----|------|
| API Key 存储 | `chrome.storage.local`（不用 `sync`，Key 不同步到云端） |
| API 调用位置 | **仅在 Service Worker 中**，不在 Content Script 中暴露 Key |
| LLM 生成的代码 | 执行前预览，用户确认后再执行 |
| 敏感操作 | 表单提交、网络请求等需要二次确认 |
| Copilot Client ID | README 中注明这是逆向工程的非官方用法 |

---

## 10. 待讨论事项

- [ ] 具体的 UI 设计方案（对话界面、设置页面、代码预览组件）
- [ ] Tool Calling 的工具集具体定义（哪些浏览器操作封装成 tool）
- [ ] 对话上下文管理策略（DOM 摘要方式、token 限制处理）
- [ ] Copilot Device Flow 是否作为首选还是可选
- [ ] 是否需要支持多标签页同时操作
- [ ] 自动化脚本保存/分享机制
- [ ] 国际化需求（中文/英文）
