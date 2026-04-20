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

Cebian wants to be **a tool that genuinely helps ordinary people**. AI shouldn't be locked behind accounts, and it shouldn't treat your data as someone else's asset.

A few things Cebian sticks to:

- **No account required.** Install and use — no sign-up, no email, no login.
- **🔒 Your data stays on your device.** Every conversation, prompt, and attached file is stored locally in your browser. Nothing is uploaded to any server.
- **Open source.** The full source code is on GitHub, free to read and modify under AGPL-3.0.

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
|   **🔒 Privacy-first**   | All conversations, prompts, and files stay in your browser — nothing is uploaded to any server                          |

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

## 🤝 Contributing

Contributions are welcome! Please read the [contributing guide](./CONTRIBUTING.md) before opening a PR. First-time contributors need to sign the [CLA](./CLA.md).

---

## 📄 License

Cebian is licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only). Full text: [LICENSE](./LICENSE).

In short:

- You are free to use Cebian.
- If you **modify and distribute** Cebian — including **running it as a network service** — you must release the complete source of your modifications under the same AGPL-3.0 license.
- For use cases that cannot comply with AGPL-3.0 (e.g. closed-source commercial redistribution), a separate commercial license may be available. Contact the maintainer via GitHub to discuss.

---

## 💖 Support the project

If you like Cebian:

1. ⭐ Star the repo and tell a friend
2. Open an issue or PR — feedback and contributions are very welcome

> Cebian is a personal project. I can't promise sponsor-tier features
> or dedicated support — your support is purely encouragement, and it
> already means a lot. Thank you 🙏

### 🌟 Ultimate Sponsor

> **My girlfriend** — for the late nights, the cold dinners, and
> every "just five more minutes." Thank you, always. ❤️

### 💝 Sponsors

_Be the first._