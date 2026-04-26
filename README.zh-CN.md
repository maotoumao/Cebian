<div align="center">

<img src="./public/icon/128.png" alt="Cebian" width="96" height="96" />

# Cebian

**AI 驱动的浏览器侧边栏助手**

**[English](./README.md)** | 简体中文

</div>

---

> [!IMPORTANT]
> **项目使用约定**
>
> 本项目基于 [AGPL-3.0](./LICENSE) 协议开源，使用时请遵守开源协议。另外希望你在使用代码时已经了解以下说明：
>
> 1. 二次分发、打包请**保留代码出处**：<https://github.com/maotoumao/Cebian>
> 2. 如果希望闭源 / 商用，请通过 GitHub 联系作者获取商业授权
> 3. 如果开源协议变更，将在此仓库更新，不另行通知

---

## 🌱 为什么做 Cebian

Cebian 想做**一个能在日常生活中帮助到普通人的工具**。没有中间商赚差价，你可以使用你购买的任何大模型厂商的 API 作为你的侧边栏 AI 助手。

所以 ————

- **没有账号**。装完就能用，没有注册、邮箱、登录。
- **隐私优先**。对话、Prompt、附件，全都在你自己的浏览器里，**仅在你向 AI 提问时**，相关上下文才会发送给你选定的大模型厂商。
- **开源**。AGPL-3.0。

---

## ✨ 简介

Cebian 是一个运行在 Chrome 侧边栏里的 AI agent。它能读取你当前浏览的网页，也能帮你检索书签、翻历史记录。外部工具通过 MCP 协议挂载，专门的处理流程可以写成 Skill 复用。浏览网页时随时可以调用。

> 关于名字 —— Cebian = 侧边

---

## 🚀 特性

|          特性          | 说明                                                                                     |
| :--------------------: | :--------------------------------------------------------------------------------------- |
|      **🤖 多模型**     | 支持 OpenAI、Anthropic、Google，以及任意 OpenAI 兼容协议的自定义服务端点                 |
|     **📄 页面感知**    | 一键拿到当前 URL、标题、选中文本，或用拾取器点选任意元素作为上下文；支持粘贴图片和文件   |
|   **⚡ Slash Prompt**  | 自定义 Prompt 库，用 `{{selected_text}}`、`{{page_url}}`、`{{clipboard}}` 等模板变量组合 |
|      **🧩 Skill**     | 把多步工作流或领域知识封装成可复用的 Skill，AI 可按需调用                          |
|     **🔌 MCP 工具**    | 内置 Model Context Protocol 客户端，外部工具即插即用                                     |
|    **📱 移动端模拟**   | 对当前标签页开启移动设备模拟，调试响应式页面更方便                                       |
|     **🔒 隐私优先**    | 本地存储，没有云同步，也没有遥测——连你用了几次都不知道（其实是懒得维护服务器 :D） |

---

## 🛠️ 启动项目

### 环境要求

|   依赖   |  版本  |
| :------: | :----: |
| Node.js  | >= 20  |
|   pnpm   | latest |

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/maotoumao/Cebian.git
cd Cebian

# 安装依赖
pnpm install

# Chrome 开发模式
pnpm run dev

# Firefox 开发模式
pnpm run dev:firefox
```

开发模式启动后，浏览器会自动加载 `.output/chrome-mv3/`（或 Firefox 对应目录）下的未打包扩展。也可以在浏览器的扩展管理页手动加载。

### 常用命令

|          命令          | 说明                                      |
| :--------------------: | :---------------------------------------- |
|     `pnpm run dev`     | Chrome 开发模式                           |
| `pnpm run dev:firefox` | Firefox 开发模式                          |
|    `pnpm run check`    | 类型检查 + i18n lint（pre-commit 也会跑） |
|    `pnpm run build`    | 生产构建                                  |
|     `pnpm run zip`     | 打包用于应用商店上传                      |

---

## 💖 支持这个项目

如果你喜欢 Cebian，欢迎：

1. ⭐ Star 本仓库，让更多人看到
2. 提 Issue 或 PR 反馈问题、贡献代码
3. 关注我的其他频道：

|  微信公众号   |  博客  | B站 | 小红书 |
|  ----  | ---- | ---- | ---- |
| [一只猫头猫](./public/sponsor/wechat_channel.jpg) | [catcat.work](https://blog.catcat.work) | [不想睡觉猫头猫](https://space.bilibili.com/12866223) | [一只猫头猫](https://www.xiaohongshu.com/user/profile/5ce6085200000000050213a6?xhsshare=CopyLink&appuid=5ce6085200000000050213a6&apptime=1714394544) |

## 🎁 赞助

如果这个项目对你有帮助的话，欢迎请我喝杯蜜雪冰城~

[![微信赞赏](./public/sponsor/wechat-button.png)](./public/sponsor/wechat-qr.jpeg)

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/maotoumao)

### 🌟 Ultimate Sponsor

> **My girlfriend** —— for the late nights, the cold dinners, and
> every "just five more minutes." Thank you, always. ❤️

### 💝 Sponsors

_假装这里有赞助。_

---

## 🤝 参与贡献

欢迎参与贡献！提交 PR 前请阅读 [贡献指南](./CONTRIBUTING.zh-CN.md)。

---

## 📄 开源协议

本项目基于 **GNU Affero General Public License v3.0 only**（AGPL-3.0-only）开源，完整文本见 [LICENSE](./LICENSE)。

简单说：

- 你可以自由使用本软件
- 如果你**修改并分发** Cebian —— 包括**以网络服务形式对外提供** —— 你必须以同样的 AGPL-3.0 协议开源你修改的全部代码
- 如果你的使用场景无法满足 AGPL-3.0，可以通过 GitHub 联系作者
