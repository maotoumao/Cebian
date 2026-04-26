<div align="center">

<img src="./public/icon/128.png" alt="Cebian" width="96" height="96" />

# Cebian

**An AI assistant that lives in your browser side panel**

English | **[简体中文](./README.zh-CN.md)**

</div>

---

> [!IMPORTANT]
> **Project usage notes**
>
> This project is open-sourced under the [AGPL-3.0](./LICENSE) license. Please respect the license when using the code. In particular:
>
> 1. When redistributing or repackaging, **keep the source attribution**: <https://github.com/maotoumao/Cebian>
> 2. For closed-source or commercial use, please reach out via GitHub for a commercial license.
> 3. Any future change to the license will be announced in this repository — there will be no separate notification.

---

## 🌱 Why Cebian

Cebian wants to be **a tool that helps ordinary people in everyday life**. No middleman taking a cut — bring your own API key from any model provider and use it as your side-panel AI assistant.

So ————

- **No account required.** Install and use — no sign-up, no email, no login.
- **Privacy first.** Conversations, prompts, and attachments all stay in your own browser; **only when you send a message to the AI** is the relevant context forwarded to the model provider you chose.
- **Open source.** AGPL-3.0.

---

## ✨ Overview

Cebian is a Chrome extension that puts an AI assistant in the browser side panel. It can read the current page, pick elements, emulate mobile devices, attach files, and plug into external tools via MCP — letting you reach for AI without ever leaving the page you're on.

> About the name: "Cebian" is just the pinyin of 侧边 (cè biān) — Chinese for "the side." Nothing fancier than that.

---

## 🚀 Features

|         Feature        | Description                                                                                                            |
| :--------------------: | :--------------------------------------------------------------------------------------------------------------------- |
|   **🤖 Multi-model**   | OpenAI, Anthropic, Google, and any OpenAI-compatible endpoint via custom providers                                     |
|  **📄 Page-aware**     | Grab the current URL, title, selected text, or any picked element as context; paste images and files                   |
|  **⚡ Slash Prompts**  | Build a prompt library with template variables like `{{selected_text}}`, `{{page_url}}`, `{{clipboard}}`               |
|     **🧩 Skills**     | Package multi-step workflows or domain knowledge into reusable Skills the AI can invoke on demand                      |
|     **🔌 MCP tools**   | Built-in Model Context Protocol client — drop in external tools and they just work                                     |
|  **📱 Mobile emulation** | Toggle mobile-device emulation on the active tab to debug responsive pages                                           |
|   **🔒 Privacy-first**   | All conversations, prompts, and files stay in your browser — nothing is uploaded to any server (honestly, just too lazy to maintain one :D)                          |

---

## 🛠️ Getting Started

### Requirements

|   Tool   | Version |
| :------: | :-----: |
| Node.js  |  >= 20  |
|   pnpm   |  latest |

### Quick start

```bash
# Clone
git clone https://github.com/maotoumao/Cebian.git
cd Cebian

# Install
pnpm install

# Chrome dev mode
pnpm run dev

# Firefox dev mode
pnpm run dev:firefox
```

Dev mode auto-loads the unpacked extension from `.output/chrome-mv3/` (or the Firefox equivalent). You can also load it manually from your browser's extensions page.

### Common commands

|         Command        | Description                                          |
| :--------------------: | :--------------------------------------------------- |
|     `pnpm run dev`     | Chrome dev build                                     |
| `pnpm run dev:firefox` | Firefox dev build                                    |
|    `pnpm run check`    | Type-check + i18n lint (also runs as a pre-commit)   |
|    `pnpm run build`    | Production build                                     |
|     `pnpm run zip`     | Package for store upload                             |

---

## 💖 Support the project

If you like Cebian:

1. ⭐ Star the repo and tell a friend
2. Open an issue or PR — feedback and contributions are very welcome
3. Follow my other channels:

| WeChat Official Account | Blog | Bilibili | Xiaohongshu | X |
| ---- | ---- | ---- | ---- | ---- |
| [一只猫头猫](./public/sponsor/wechat_channel.jpg) | [catcat.work](https://blog.catcat.work) | [不想睡觉猫头猫](https://space.bilibili.com/12866223) | [一只猫头猫](https://www.xiaohongshu.com/user/profile/5ce6085200000000050213a6?xhsshare=CopyLink&appuid=5ce6085200000000050213a6&apptime=1714394544) | [@maotoumao0_0](https://x.com/maotoumao0_0) |

## 🎁 Sponsors

If this project has been helpful, you're welcome to buy me a coffee~

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/maotoumao)

[![WeChat Reward](./public/sponsor/wechat-button.png)](./public/sponsor/wechat-qr.jpeg)

### 🌟 Ultimate Sponsor

> **My girlfriend** — for the late nights, the cold dinners, and
> every "just five more minutes." Thank you, always. ❤️

### 💝 Sponsors

_Be the first._

---

## 🤝 Contributing

Contributions are welcome! Please read the [contributing guide](./CONTRIBUTING.md) before opening a PR.

---

## 📄 License

Cebian is licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only). Full text: [LICENSE](./LICENSE).

In short:

- You are free to use Cebian.
- If you **modify and distribute** Cebian — including **running it as a network service** — you must release the complete source of your modifications under the same AGPL-3.0 license.
- For use cases that cannot comply with AGPL-3.0, please contact the maintainer via GitHub to discuss.
