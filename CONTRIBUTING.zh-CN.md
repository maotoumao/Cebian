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

### 可选：自动注入开发用 AI provider

复制 `.env.example` 为 `.env.local`，填写 `WXT_DEV_API_KEY` 以及配套字段。
下次 `pnpm run dev` 启动时，扩展会自动创建一个自定义 OpenAI 兼容 provider，
省去在 UI 里手动走一遍配置流程。这段逻辑只在 dev 模式且 API key 非空时执行，
生产构建完全跳过；如果同 id 的 provider 已存在，也不会被覆盖。

## 提交 PR 之前

为了确保实现方向与项目目标一致，**PR 必须绑定一个已获维护者批准的 issue**。
流程如下：

1. **新建或找到一个 issue**，描述要修的 bug 或要做的功能，并在其中讨论你的方案。
2. **等待批准**。维护者会在该 issue 回复 `/ready`，从而打上 `ready-to-implement` 标签，
   表示方案已达成共识、可以开始实现。
3. **再提交 PR**，并在描述里用 `Closes #<issue 编号>` 关联该 issue。

**未绑定**带 `ready-to-implement` 标签 issue 的 PR 会被机器人**自动关闭**，并附上
说明如何继续的评论。不用担心——等关联的 issue 获批后，重新打开（reopen）这个 PR
即可通过检查。维护者和协作者发起的 PR 不受此闸门限制。

## 贡献流程

1. Fork 本仓库，并从 `master` 创建你的分支。
2. 进行修改。保持每个 commit 聚焦，diff 尽量精简。
3. 推送前在本地运行 `pnpm run check`。
4. 向 `master` 发起 Pull Request，在描述里用 `Closes #<issue 编号>` 关联已获批的
   issue，并在 PR 模板中勾选 CLA 选项以表示同意贡献者许可协议。

## 贡献者许可协议（CLA）

在合并你的 Pull Request 之前，你必须同意
[Cebian 个人贡献者许可协议](CLA.md)（中文参考译文见
[CLA.zh-CN.md](CLA.zh-CN.md)）。

**一句话说明**：

- 你保留对自己贡献的版权。
- 你授予维护者广泛的许可，允许其使用、再许可、再分发你的贡献。
- 你确认自己有权提交这份代码。

发起 Pull Request 时，在 PR 模板中勾选 CLA 选项即表示同意。

## 许可证

Cebian 基于 [AGPL-3.0-only](LICENSE) 发布。你的贡献将以
AGPL-3.0-only 进入本项目，同时你按 [CLA](CLA.md) 的条款授予维护者
相应权利（包括 CLA 中所述的再许可权利）。

> **法律效力**：CLA 的中文版本仅为参考译文。若中英文之间发生歧义或
> 冲突，以 [CLA.md](CLA.md) 的英文版为准。
