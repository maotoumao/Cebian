# 为 Cebian 贡献代码

**[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)**

感谢你对 Cebian 的关注！本文档介绍如何配置开发环境以及贡献流程。

## 行为准则

请保持尊重、建设性的态度。我们不容忍骚扰或恶意行为。

## 开发环境

```bash
pnpm install
pnpm run dev          # Chrome 开发模式
pnpm run dev:firefox  # Firefox 开发模式
pnpm run check        # 类型检查 + i18n lint（pre-commit 也会运行）
pnpm run build        # 生产构建
```

更多说明见 [README.zh-CN.md](README.zh-CN.md)。

## 贡献流程

1. Fork 本仓库，并从 `master` 创建你的分支。
2. 进行修改。保持每个 commit 聚焦，diff 尽量精简。
3. 推送前在本地运行 `pnpm run check`。
4. 向 `master` 发起 Pull Request。
5. 首次贡献时签署 CLA（见下方）。

## 贡献者许可协议（CLA）

在合并你的 Pull Request 之前，你必须同意
[Cebian 个人贡献者许可协议](CLA.md)（中文参考译文见
[CLA.zh-CN.md](CLA.zh-CN.md)）。

**一句话说明**：

- 你保留对自己贡献的版权。
- 你授予维护者广泛的许可，允许其使用、再许可、再分发你的贡献 ——
  包括未来在商业版或闭源版本的 Cebian 中使用。
- 你确认自己有权提交这份代码（例如没有被雇主主张权利）。

### 如何签署

首次发起 Pull Request 时，基于
[CLA Assistant](https://cla-assistant.io/) 的机器人会在评论中贴出签署
链接。通过你的 GitHub 账号点击签署，签名会覆盖你未来对本仓库的全部
贡献。

如果机器人尚未接入仓库，请在 PR 描述中加入以下一行代替：

> I have read and agree to the Cebian CLA (CLA.md).

## 许可证

Cebian 基于 [AGPL-3.0-only](LICENSE) 发布。你的贡献将以
AGPL-3.0-only 进入本项目，同时你按 [CLA](CLA.md) 的条款授予维护者
相应权利（包括 CLA 中所述的再许可权利）。

> **法律效力**：CLA 的中文版本仅为参考译文。若中英文之间发生歧义或
> 冲突，以 [CLA.md](CLA.md) 的英文版为准。
